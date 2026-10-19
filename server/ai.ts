import fs from 'node:fs'
import path from 'node:path'
import type {
  CandidateLocator,
  FrameRef,
  OperationWorkflow,
  RecordedEvent,
  RecordingTrace,
  StepRecovery,
  StepVerificationRule,
  WorkflowCoverage,
  WorkflowStep,
} from './types.ts'
import {
  buildAnnotationPayload,
  buildWorkflowFromCleanTrace,
  buildWorkflowWithAnnotations,
  cleanTrace,
  RULE_TRANSLATOR_VERSION,
  validateAnnotations,
  type AnnotationResult,
  type CleanResult,
  stabilizeVerificationUrl,
} from './compiler.ts'

export const TRANSLATOR_VERSION = 'v2-rules-ai-evidence.1'

const VALID_ACTIONS = new Set([
  'goto',
  'tab_open',
  'tab_close',
  'click',
  'dblclick',
  'contextmenu',
  'hover',
  'drag',
  'scroll',
  'dialog',
  'fill',
  'file_upload',
  'select',
  'press',
  'extract_text',
  'wait_for_text',
])

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
export const WORKFLOW_COMPILER_SYSTEM_PROMPT = `你是一个网页自动化工作流的「语义标注器」。

输入是一串已经由确定性规则清洗好的原子动作（actions）：去噪、合并、参数类型判定都已经完成。你的职责只有三件事：
1. 为整条工作流写一句中文 summary；
2. 为每一个动作写清晰的中文标题（title）与一句话说明（description）；
3. 对 parameterized: true 的动作，给出参数英文驼峰 key、中文名称 label、中文说明 paramDescription。

严格约束：
- **禁止增删动作**：输入中的每个 stepId 必须输出且只输出一条标注；
- **禁止生成或修改任何定位器 / 选择器**：定位器只来自录制证据；
- 不要修改动作顺序、tabId、value 等执行字段；
- parameterized 为 false 的动作不要输出 paramKey / paramLabel；
- file_upload 动作的 paramDescription 需提醒「运行时填写本地文件绝对路径」；
- 标题要具体（如「在搜索框输入关键词」），不要写「步骤 1」这类空话；
- 只输出纯 JSON 对象，不要 Markdown 代码块。

输出结构：
{
  "summary": "一句话中文总结该工作流完成的业务事项",
  "annotations": [
    {
      "stepId": "cstep-1",
      "title": "打开必应搜索首页",
      "description": "导航到必应首页作为流程起点",
      "paramKey": "仅 parameterized 动作填写，如 searchKeyword",
      "paramLabel": "仅 parameterized 动作填写，如 搜索关键词",
      "paramDescription": "仅 parameterized 动作填写，说明参数用途"
    }
  ]
}`

/**
 * 为发送给大模型的 Trace 去除不必要的大体积字段，并附带相邻事件时间差辅助识别合成事件
 */
/**
 * 调用大模型做「语义标注」（不生成步骤、不生成定位器）
 */
async function annotateWithAI(
  clean: CleanResult,
  trace: RecordingTrace,
  config: AIConfig
): Promise<AnnotationResult> {
  const payload = buildAnnotationPayload(trace, clean)

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    signal: AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: config.model,
      response_format: { type: 'json_object' },
      temperature: 0.1,
      messages: [
        { role: 'system', content: WORKFLOW_COMPILER_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `请为以下原子动作输出语义标注（必须覆盖所有 stepId）：\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
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
  if (!content) throw new Error('大模型接口返回内容为空')

  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error('大模型返回内容不是合法 JSON')
  }

  const validation = validateAnnotations(parsed, clean.steps)
  if (!validation.valid || !validation.annotation) {
    throw new Error(`大模型标注未通过 Schema 校验：${validation.errors.slice(0, 3).join('；')}`)
  }
  return validation.annotation
}

/**
 * 使用 Node.js 原生 fetch 调用 DeepSeek 接口，将录制轨迹 (RecordingTrace) 清洗编译为操作工作流 (OperationWorkflow)
 */
/**
 * 旧版「整包工作流」结构校验（保留给回归测试与外部调用）
 */
export function validateRawWorkflow(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['模型输出不是 JSON 对象'] }
  }
  const obj = raw as Record<string, unknown>
  if (obj.steps !== undefined && !Array.isArray(obj.steps)) errors.push('steps 不是数组')
  if (obj.parameters !== undefined && !Array.isArray(obj.parameters)) errors.push('parameters 不是数组')

  if (Array.isArray(obj.steps)) {
    obj.steps.forEach((item, index) => {
      if (!item || typeof item !== 'object') {
        errors.push(`steps[${index}] 不是对象`)
        return
      }
      const step = item as Record<string, unknown>
      const binding = step.engineBinding as Record<string, unknown> | undefined
      if (!binding || typeof binding !== 'object') {
        errors.push(`steps[${index}] 缺少 engineBinding`)
        return
      }
      const actionType = binding.actionType
      if (typeof actionType !== 'string' || !VALID_ACTIONS.has(actionType)) {
        errors.push(`steps[${index}] actionType 非法：${String(actionType)}`)
      }
    })
  }

  return { valid: errors.length === 0, errors }
}

function deriveRecovery(event: RecordedEvent): StepRecovery | undefined {
  const target = event.target
  if (!target) return undefined

  const recovery: StepRecovery = {}
  if (event.pageContext.frameChain?.length) recovery.frameChain = event.pageContext.frameChain
  if (target.shadowChain?.length) recovery.shadowChain = target.shadowChain
  if (target.shadowMode) recovery.shadowMode = target.shadowMode
  if (target.domSnapshot) recovery.domSnapshot = target.domSnapshot
  if (target.nearbyLabel) recovery.nearbyText = target.nearbyLabel
  if (target.role) recovery.role = target.role
  if (target.innerText) recovery.innerText = target.innerText
  if (target.tagName) recovery.tagName = target.tagName
  if (target.attributes) recovery.attributes = target.attributes
  if (target.boundingBox) recovery.bbox = target.boundingBox
  if (event.screenshotPath) recovery.referenceScreenshot = event.screenshotPath

  return Object.keys(recovery).length > 0 ? recovery : undefined
}

/** 从录制证据派生额外的候选定位器（L2 结构恢复的确定性弹药） */
export function deriveCandidateLocators(
  event: RecordedEvent,
  existing: CandidateLocator[]
): CandidateLocator[] {
  const target = event.target
  if (!target) return []

  const seen = new Set(existing.map((loc) => `${loc.strategy}:${loc.value}`))
  const derived: CandidateLocator[] = []
  const push = (strategy: CandidateLocator['strategy'], value: string | undefined, priority: number) => {
    if (!value) return
    const normalized = value.trim().slice(0, 120)
    if (!normalized) return
    const key = `${strategy}:${normalized}`
    if (seen.has(key)) return
    seen.add(key)
    derived.push({ strategy, value: normalized, priority })
  }

  const name = target.innerText || target.nearbyLabel
  if (target.role && name && name.length <= 40) push('role', `${target.role}:${name}`, 8)
  if (target.innerText && target.innerText.length >= 2 && target.innerText.length <= 40) {
    push('text', target.innerText, 9)
  }
  if (target.nearbyLabel) push('label', target.nearbyLabel, 10)

  const tag = target.tagName || '*'
  const attrs = target.attributes || {}
  const testId = attrs['data-testid'] || attrs['data-test']
  if (testId) push('css', `${tag}[data-testid="${testId}"]`, 8)
  if (attrs.name) push('css', `${tag}[name="${attrs.name}"]`, 11)
  if (attrs.placeholder) push('css', `${tag}[placeholder="${attrs.placeholder}"]`, 12)
  if (attrs['aria-label']) push('css', `${tag}[aria-label="${attrs['aria-label']}"]`, 12)

  return derived
}

function deriveFrameChain(event: RecordedEvent): FrameRef[] | undefined {
  if (event.pageContext.frameChain?.length) return event.pageContext.frameChain
  if (event.pageContext.frameUrl) return [{ url: event.pageContext.frameUrl }]
  return undefined
}

/** 依据「录制时的后续事件」推导动作后置校验（最可靠的确定性来源） */
export function deriveVerification(
  step: WorkflowStep,
  primaryIndex: number | undefined,
  events: RecordedEvent[]
): StepVerificationRule | undefined {
  const actionType = step.engineBinding.actionType
  if (actionType === 'fill' || actionType === 'select' || actionType === 'file_upload') {
    return { mode: 'value' }
  }
  if (actionType === 'goto') {
    const expected = step.engineBinding.value
    return expected ? { mode: 'url', expected: stabilizeVerificationUrl(expected) } : undefined
  }
  if (actionType !== 'click' && actionType !== 'press' && actionType !== 'dblclick') return undefined
  if (primaryIndex === undefined) return undefined

  const startedAt = events[primaryIndex].timestamp
  for (let i = primaryIndex + 1; i < events.length; i += 1) {
    const next = events[i]
    if (next.timestamp - startedAt > 15000) break
    if (next.action.type === 'navigate' && next.action.value) {
      return { mode: 'url', expected: stabilizeVerificationUrl(next.action.value), timeoutMs: 5000 }
    }
    if (next.action.type === 'click' || next.action.type === 'fill') break
  }
  return undefined
}

export function buildCoverage(
  trace: RecordingTrace,
  steps: WorkflowStep[]
): WorkflowCoverage {
  const mapped = new Set<string>()
  for (const step of steps) {
    for (const id of step.sourceEventIds || []) mapped.add(id)
  }
  const unmapped = trace.events.filter((event) => !mapped.has(event.id))
  const warnings: string[] = []
  if (unmapped.length > 0) {
    warnings.push(
      `有 ${unmapped.length} 个原始事件未被映射到任何步骤，可能存在漏步骤（前 5 个：${unmapped
        .slice(0, 5)
        .map((event) => event.id)
        .join(', ')}）`
    )
  }
  if (steps.length === 0) warnings.push('工作流没有任何步骤')

  return {
    totalEvents: trace.events.length,
    mappedEvents: trace.events.length - unmapped.length,
    droppedEvents: unmapped.length,
    unmappedEventIds: unmapped.map((event) => event.id),
    warnings,
  }
}

/**
 * 用原始录制证据增强工作流（P1）：补齐 frameChain / 结构恢复证据 / 派生定位器 / 后置校验。
 * 注意：不覆盖规则编译或 AI 标注已经生成的 verification / coverage / translatorVersion。
 */
export function enrichWorkflowWithEvidence(
  trace: RecordingTrace,
  workflow: OperationWorkflow
): OperationWorkflow {
  const eventIndex = new Map<string, number>()
  trace.events.forEach((event, index) => eventIndex.set(event.id, index))

  const steps = workflow.steps.map((step) => {
    const sourceIds = step.sourceEventIds || []
    let primaryIndex: number | undefined
    for (const id of sourceIds) {
      const index = eventIndex.get(id)
      if (index === undefined) continue
      if (trace.events[index].target) {
        primaryIndex = index
        break
      }
    }
    if (primaryIndex === undefined) {
      for (const id of sourceIds) {
        const index = eventIndex.get(id)
        if (index !== undefined) {
          primaryIndex = index
          break
        }
      }
    }

    const engineBinding = { ...step.engineBinding }
    const primary = primaryIndex !== undefined ? trace.events[primaryIndex] : undefined
    if (primary) {
      const frameChain = deriveFrameChain(primary)
      if (frameChain) engineBinding.frameChain = frameChain
      const recovery = deriveRecovery(primary)
      if (recovery) engineBinding.recovery = recovery
      engineBinding.locators = [
        ...step.engineBinding.locators,
        ...deriveCandidateLocators(primary, step.engineBinding.locators),
      ]
      if (!engineBinding.verification) {
        const verification = deriveVerification(step, primaryIndex, trace.events)
        if (verification) engineBinding.verification = verification
      }
    }

    return { ...step, engineBinding }
  })

  return {
    ...workflow,
    schemaVersion: 2,
    translatorVersion: workflow.translatorVersion ?? TRANSLATOR_VERSION,
    coverage: workflow.coverage ?? buildCoverage(trace, steps),
    steps,
  }
}

/**
 * 把录制轨迹编译为工作流：
 * 1. 确定性规则清洗 + 规则编译（兜底，永远可用）；
 * 2. 若配置了 API Key，再调用大模型做语义标注（只改文案/参数命名，不增删步骤）；
 * 3. AI 失败自动回退规则生成，并在 coverage.warnings 中记录；
 * 4. 最后用原始录制证据增强（frameChain / recovery / 派生定位器）。
 */
export async function compileTraceToWorkflow(trace: RecordingTrace): Promise<OperationWorkflow> {
  const clean = cleanTrace(trace)
  if (clean.steps.length === 0) {
    throw new Error('录制轨迹清洗后没有可执行步骤，请检查录制内容')
  }

  const config = getAIConfig()
  let workflow = buildWorkflowFromCleanTrace(trace, clean)

  if (config.apiKey) {
    try {
      const annotation = await annotateWithAI(clean, trace, config)
      workflow = buildWorkflowWithAnnotations(trace, clean, annotation)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'AI 语义标注失败'
      workflow = {
        ...workflow,
        translatorVersion: `${RULE_TRANSLATOR_VERSION}+fallback`,
        coverage: {
          ...(workflow.coverage as WorkflowCoverage),
          warnings: [
            ...(workflow.coverage?.warnings ?? []),
            `AI 语义标注失败，已回退规则生成：${message}`,
          ],
        },
      }
    }
  }

  return enrichWorkflowWithEvidence(trace, workflow)
}
