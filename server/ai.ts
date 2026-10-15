import fs from 'node:fs'
import path from 'node:path'
import type {
  OperationWorkflow,
  RecordingTrace,
  WorkflowParameter,
  WorkflowStep,
} from './types.ts'

export interface AIConfig {
  apiUrl: string
  apiKey: string
  model: string
}

/**
 * 动态读取项目根目录下的 .env 文件，方便用户填入 DEEPSEEK_API_KEY 后无需重启后端即可立即生效
 */
function parseDotEnv(): Record<string, string> {
  const envPath = path.resolve(process.cwd(), '.env')
  const result: Record<string, string> = {}
  if (!fs.existsSync(envPath)) return result

  try {
    const content = fs.readFileSync(envPath, 'utf-8')
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim()
      if (!line || line.startsWith('#')) continue
      const eqIdx = line.indexOf('=')
      if (eqIdx === -1) continue
      const key = line.slice(0, eqIdx).trim()
      let val = line.slice(eqIdx + 1).trim()
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1)
      }
      result[key] = val
    }
  } catch {
    // ignore read error
  }
  return result
}

export function getAIConfig(): AIConfig {
  const dotEnv = parseDotEnv()
  return {
    apiUrl:
      dotEnv.DEEPSEEK_API_URL ||
      process.env.DEEPSEEK_API_URL ||
      dotEnv.AI_API_URL ||
      process.env.AI_API_URL ||
      'https://api.deepseek.com/chat/completions',
    apiKey:
      dotEnv.DEEPSEEK_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      dotEnv.AI_API_KEY ||
      process.env.AI_API_KEY ||
      '',
    model:
      dotEnv.DEEPSEEK_MODEL ||
      process.env.DEEPSEEK_MODEL ||
      dotEnv.AI_MODEL ||
      process.env.AI_MODEL ||
      'deepseek-chat',
  }
}

/**
 * 核心系统提示词：将浏览器底层录制的原始事件轨迹 (RecordingTrace) 清洗并编译为“部分固定、部分抽象参数化”的操作工作流 (OperationWorkflow)
 */
export const WORKFLOW_COMPILER_SYSTEM_PROMPT = `你是一个专业的“网页自动化工作流清洗与参数抽象编译器”。
你的任务是读取用户在浏览器中录制的原始底层事件轨迹（RecordingTrace JSON），完成以下两件核心工作：
第一，剔除浏览器底层派发的冗余噪声、被动跳转和无意义误触；
第二，将清洗后的步骤明确分类为“固定操作（fixed）”与“动态抽象操作（parameterized）”，并将所有动态操作中的输入值抽离汇总到项目顶层的参数表（parameters）中，形成一份“部分固定、部分抽象”且可由 Playwright 100% 确定性执行的结构化工作流（OperationWorkflow JSON）。

### 一、操作分类原则：区分“固定硬操作（fixed）”与“动态抽象操作（parameterized）”

1. 【固定硬操作（stepCategory: "fixed"）】
   - 定义：在工作流每次重复执行时动作和目标都保持不变的硬性步骤。
   - 包含场景：
     * 打开起始系统/网站入口页面（actionType: "goto"）—— 起始网址本身是该工作流的固定入口，归为 "fixed"，不要抽成动态参数。
     * 点击网页上固定的按钮、菜单、搜索图标、提交按钮或标签页（actionType: "click"）。
     * 按下固定的键盘按键，如回车提交或 Esc 关闭（actionType: "press"）。
     * 新建或关闭浏览器标签页（actionType: "tab_open" | "tab_close"）。
   - 处理方式：stepCategory 设为 "fixed"，humanView.paramKey 和 engineBinding.paramKey 均省略，固定值直接保留在 engineBinding.value 中。

2. 【动态抽象操作（stepCategory: "parameterized"）】
   - 定义：在工作流每次执行时，用户往往需要填入不同内容的可变步骤。
   - 包含场景：
     * 在输入框、搜索框、文本域中输入文本（actionType: "fill"）—— 输入的文本内容一定是不固定的，必须抽象为动态参数！
     * 在下拉选择框中切换筛选项（actionType: "select"）—— 选择的项通常也是可变的，应当抽象为动态参数。
   - 处理方式：
     * 将该步骤的 stepCategory 设为 "parameterized"；
     * 为该输入项设计一个语义清晰的英文驼峰参数名（如 searchKeyword、orderNumber、applicantName），填入该步骤的 humanView.paramKey 和 engineBinding.paramKey；
     * 同时在顶层的 parameters 数组中注册该参数（包含 key、纯中文名称 label、中文说明 description、inputType、录制时的原始值 defaultValue、当前值 value，以及绑定的步骤 ID 列表 boundStepIds）。

### 二、四大底层降噪清洗规则（极其重要，必须严格遵守）

1. 【剔除浏览器底层合成点击、Label 关联连带点击与零尺寸隐藏元素】
   - 当用户在输入框按下回车（action.type === "press"，value === "Enter"）时，网页常会在几毫秒内自动派发一个隐藏提交按钮的合成点击（特征：紧跟在 press 之后 100ms 内，或 target.boundingBox 宽高为 0，或紧接着又触发一次输入框自身的 click）。
   - 当用户点击某个 <label>（如必应的 label#search_icon）或外层容器时，浏览器常会在极短时间内（deltaMsFromPrev < 50ms，通常仅隔 1~10 毫秒）自动触发其关联的 <input type="submit">（如 input#sb_form_go）的第二次 click 事件。这属于单次鼠标点击引发的浏览器底层连带事件，**必须只保留第一个 click，剔除 50ms 内紧跟的第二个连带 click**！
   - 此外，如果用户在页面 A 只是聚焦点了一下某个输入框但未输入任何内容，紧接着就直接在同一个标签页导航（navigate）到了完全无关的页面 B 开始正式操作，说明页面 A 只是误开或放弃的页面，也应作为前置无效操作一并剔除。

2. 【剔除由点击或回车引发的被动路由跳转（navigate）】
   - 只有用户主动打开起始网页的第一个 navigate 事件需要转换为 actionType: "goto"（若有 URL 重定向，取稳定后的起始 URL）。
   - 当用户执行了 click 或 press("Enter") 之后几秒内发生的 navigate 事件（比如跳转到搜索结果页 "/search?q=..." 及随后的重定向），是前一步动作自然引发的页面跳转结果，**严禁**将它们编译成额外的 "goto" 步骤！

3. 【合并输入框的“前置聚焦点击”与“输入内容”】
   - 用户在输入框打字前通常会先 click 一下该输入框，紧接着在同一输入框触发 fill。
   - Playwright 的 fill() 会自动聚焦元素，因此请将“点击某输入框 + 在同一输入框 fill”合并为一个单独的 actionType: "fill"（stepCategory: "parameterized"）步骤，并把这两个原始事件的 id 都放入该步骤的 sourceEventIds 中。

4. 【候选定位器（locators）100% 原样保真】
   - 凡是涉及 DOM 元素的步骤（click / fill / select / press），其 engineBinding.locators 数组必须 **原封不动地拷贝** 自对应原始事件的 target.locators。
   - **严禁**你自己编造或修改任何 CSS 选择器、ID 或 XPath。goto / tab_open / tab_close 步骤的 locators 传空数组 []。

### 三、输出 JSON 结构规范（严格输出纯 JSON 对象）

{
  "projectId": "与输入一致的 projectId",
  "updatedAt": "当前 ISO 时间字符串",
  "summary": "用一句自然的中文总结该工作流完成的业务事项",
  "removedNoiseCount": 被清洗剔除或合并掉的原始冗余事件数量（整数）,
  "parameters": [
    {
      "key": "英文驼峰参数名，如 searchKeyword",
      "label": "简明中文参数名，如 搜索关键词",
      "description": "中文说明该参数用于哪个页面的哪个输入框",
      "inputType": "text | select | number",
      "defaultValue": "录制时的原始值，如 hello",
      "value": "默认与 defaultValue 相同，如 hello",
      "required": true,
      "boundStepIds": ["step-2"]
    }
  ],
  "steps": [
    {
      "id": "step-1",
      "order": 1,
      "stepCategory": "fixed | parameterized",
      "sourceEventIds": ["evt-xxx"],
      "humanView": {
        "title": "简短清晰的中文步骤标题（如：打开必应搜索首页 / 输入搜索关键词 / 按下回车执行搜索）",
        "description": "一句话中文说明这一步的具体作用",
        "paramKey": "仅当 stepCategory 为 parameterized 时填写，对应 parameters 中的 key",
        "paramLabel": "仅当 stepCategory 为 parameterized 时填写，对应 parameters 中的 label"
      },
      "engineBinding": {
        "tabId": "继承自原始事件 pageContext.tabId，如 tab-1",
        "frameUrl": "若原始事件有 pageContext.frameUrl 则保留，否则省略",
        "actionType": "goto | tab_open | tab_close | click | fill | select | press | extract_text | wait_for_text",
        "paramKey": "仅当 stepCategory 为 parameterized 时填写，对应 parameters 中的 key",
        "value": "固定操作的值（如 goto 的网址、press 的 Enter）或动态参数的初始默认值",
        "locators": [],
        "timeoutMs": 8000,
        "optional": false
      }
    }
  ]
}`

/**
 * 为发送给大模型的 Trace 去除不必要的大体积字段，并附带相邻事件时间差辅助识别合成事件
 */
function buildCompactTraceForPrompt(trace: RecordingTrace) {
  return {
    projectId: trace.projectId,
    recordedAt: trace.recordedAt,
    overallGoal: trace.overallGoal,
    totalRawEvents: trace.events.length,
    events: trace.events.map((evt, index) => ({
      index: index + 1,
      id: evt.id,
      timestamp: evt.timestamp,
      deltaMsFromPrev: index > 0 ? evt.timestamp - trace.events[index - 1].timestamp : 0,
      pageContext: evt.pageContext,
      action: evt.action,
      target: evt.target,
      userComment: evt.userComment,
    })),
  }
}

/**
 * 使用 Node.js 原生 fetch 调用 DeepSeek 接口，将录制轨迹 (RecordingTrace) 清洗编译为操作工作流 (OperationWorkflow)
 */
export async function compileTraceToWorkflow(trace: RecordingTrace): Promise<OperationWorkflow> {
  const config = getAIConfig()

  if (!config.apiKey) {
    throw new Error('尚未配置 DeepSeek 密钥，请在项目根目录的 .env 文件中填入 DEEPSEEK_API_KEY')
  }

  const compactTrace = buildCompactTraceForPrompt(trace)

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: WORKFLOW_COMPILER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请清洗并编译以下录制的原始轨迹数据，区分固定操作（fixed）与动态参数操作（parameterized），输出结构化的 OperationWorkflow JSON：\n${JSON.stringify(compactTrace, null, 2)}`,
        },
      ],
      temperature: 0.1,
    }),
  })

  if (!response.ok) {
    const errText = await response.text()
    throw new Error(`大模型接口调用失败 (${response.status}): ${errText}`)
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const content = data.choices?.[0]?.message?.content
  if (!content) {
    throw new Error('大模型接口返回内容为空')
  }

  const parsed = JSON.parse(content) as Partial<OperationWorkflow>
  const rawSteps = Array.isArray(parsed.steps) ? parsed.steps : []
  const rawParams = Array.isArray(parsed.parameters) ? parsed.parameters : []

  const normalizedSteps: WorkflowStep[] = rawSteps.map((step, idx) => {
    const id = step.id || `step-${idx + 1}`
    const actionType = step.engineBinding?.actionType || 'click'
    const paramKey = step.engineBinding?.paramKey || step.humanView?.paramKey
    const isParameterized =
      step.stepCategory === 'parameterized' ||
      Boolean(paramKey) ||
      actionType === 'fill' ||
      actionType === 'select'

    return {
      id,
      order: idx + 1,
      stepCategory: isParameterized ? 'parameterized' : 'fixed',
      sourceEventIds: Array.isArray(step.sourceEventIds) ? step.sourceEventIds : [],
      humanView: {
        title: step.humanView?.title || `步骤 ${idx + 1}`,
        description: step.humanView?.description || '',
        ...(isParameterized && paramKey ? { paramKey } : {}),
        ...(isParameterized && step.humanView?.paramLabel
          ? { paramLabel: step.humanView.paramLabel }
          : {}),
      },
      engineBinding: {
        tabId: step.engineBinding?.tabId || 'tab-1',
        ...(step.engineBinding?.frameUrl ? { frameUrl: step.engineBinding.frameUrl } : {}),
        actionType,
        ...(isParameterized && paramKey ? { paramKey } : {}),
        ...(step.engineBinding?.value !== undefined ? { value: step.engineBinding.value } : {}),
        locators: Array.isArray(step.engineBinding?.locators) ? step.engineBinding.locators : [],
        timeoutMs: step.engineBinding?.timeoutMs || 8000,
        optional: Boolean(step.engineBinding?.optional),
      },
    }
  })

  // 归一化顶层项目参数列表，并确保每个 parameterized 步骤都有对应的顶层参数定义
  const paramMap = new Map<string, WorkflowParameter>()
  for (const p of rawParams) {
    if (!p || !p.key) continue
    const defVal = String(p.defaultValue ?? p.value ?? '')
    paramMap.set(p.key, {
      key: p.key,
      label: p.label || p.key,
      description: p.description || '',
      inputType: p.inputType || 'text',
      defaultValue: defVal,
      value: String(p.value ?? defVal),
      required: p.required !== false,
      boundStepIds: Array.isArray(p.boundStepIds) ? p.boundStepIds : [],
    })
  }

  for (const step of normalizedSteps) {
    if (step.stepCategory === 'parameterized') {
      const key = step.engineBinding.paramKey || `param_${step.order}`
      step.humanView.paramKey = key
      step.engineBinding.paramKey = key
      const existing = paramMap.get(key)
      if (existing) {
        if (!existing.boundStepIds.includes(step.id)) {
          existing.boundStepIds.push(step.id)
        }
        if (!step.humanView.paramLabel) {
          step.humanView.paramLabel = existing.label
        }
      } else {
        const defVal = String(step.engineBinding.value ?? '')
        const label = step.humanView.paramLabel || step.humanView.title
        paramMap.set(key, {
          key,
          label,
          description: step.humanView.description || label,
          inputType: step.engineBinding.actionType === 'select' ? 'select' : 'text',
          defaultValue: defVal,
          value: defVal,
          required: true,
          boundStepIds: [step.id],
        })
      }
    }
  }

  return {
    projectId: trace.projectId,
    updatedAt: new Date().toISOString(),
    summary: parsed.summary || trace.overallGoal || '自动生成的网页操作工作流',
    removedNoiseCount:
      typeof parsed.removedNoiseCount === 'number'
        ? parsed.removedNoiseCount
        : Math.max(0, trace.events.length - normalizedSteps.length),
    parameters: Array.from(paramMap.values()),
    steps: normalizedSteps,
  }
}
