/**
 * 核心逻辑单测：确定性规则清洗 + 规则编译 + 标注 Schema 校验
 * 运行：node tests/compiler.test.mjs
 */
import {
  buildAnnotationPayload,
  buildWorkflowFromCleanTrace,
  cleanTrace,
  validateAnnotations,
} from '../server/compiler.ts'

let passed = 0
let failed = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    passed += 1
    console.log(`PASS  ${name}${detail ? `  (${detail})` : ''}`)
  } else {
    failed += 1
    console.error(`FAIL  ${name}${detail ? `  (${detail})` : ''}`)
  }
}

const loc = (value) => [{ strategy: 'css', value, priority: 6 }]
const ev = (id, ts, type, extra = {}) => ({
  id,
  timestamp: ts,
  isoTime: new Date(ts).toISOString(),
  pageContext: {
    tabId: extra.tabId || 'tab-1',
    tabIndex: 1,
    url: extra.url || 'https://example.com',
    title: '示例页',
  },
  action: { category: extra.category || 'page', type, value: extra.value, key: extra.key },
  ...(extra.target ? { target: extra.target } : {}),
  ...(extra.dragTo ? { dragTo: extra.dragTo } : {}),
})
const target = (css, extra = {}) => ({
  tagName: extra.tagName || 'input',
  role: extra.role || 'textbox',
  innerText: extra.innerText,
  nearbyLabel: extra.nearbyLabel,
  attributes: { name: extra.name, placeholder: extra.placeholder },
  locators: loc(css),
  boundingBox: extra.bbox || { x: 10, y: 20, width: 100, height: 20 },
  ...(extra.shadowChain ? { shadowChain: extra.shadowChain } : {}),
  ...(extra.domSnapshot ? { domSnapshot: extra.domSnapshot } : {}),
})

// ---------------------------------------------------------------
// 1. 清洗规则：噪声剔除 / 合并 / 被动跳转归因
// ---------------------------------------------------------------
const baseTrace = {
  projectId: 'proj-rule',
  recordedAt: new Date(1000).toISOString(),
  updatedAt: new Date(1000).toISOString(),
  overallGoal: '规则清洗测试',
  events: [
    ev('e1', 1000, 'navigate', { category: 'window', value: 'https://example.com' }),
    ev('e2', 2000, 'click', { target: target('#q', { nearbyLabel: '搜索词', name: 'q' }) }),
    ev('e3', 2300, 'fill', { value: 'hello', target: target('#q', { nearbyLabel: '搜索词', name: 'q' }) }),
    ev('e4', 3000, 'press', { key: 'Enter', value: 'Enter', target: target('#q') }),
    ev('e5', 3200, 'navigate', { category: 'window', value: 'https://example.com/results' }),
    ev('e6', 4000, 'click', { target: target('#zero', { bbox: { x: 0, y: 0, width: 0, height: 0 } }) }),
    ev('e7', 5000, 'click', { target: target('#a', { tagName: 'button', role: 'button', innerText: 'A' }) }),
    ev('e8', 5010, 'click', { target: target('#b', { tagName: 'button', role: 'button', innerText: 'B' }) }),
    ev('e9', 6000, 'hover', { target: target('#menu-src', { tagName: 'button', role: 'button', innerText: '菜单' }) }),
    ev('e10', 6500, 'click', { target: target('#menu-item', { tagName: 'button', role: 'button', innerText: '子项' }) }),
    ev('e11', 7000, 'hover', { target: target('#btn', { tagName: 'button', role: 'button', innerText: '按钮' }) }),
    ev('e12', 7200, 'click', { target: target('#btn', { tagName: 'button', role: 'button', innerText: '按钮' }) }),
    ev('e13', 8000, 'tab_open', { category: 'window', tabId: 'tab-2' }),
    ev('e14', 8100, 'tab_close', { category: 'window', tabId: 'tab-2' }),
    ev('e15', 9000, 'select_text', { value: 'abc', target: target('#text', { tagName: 'div' }) }),
  ],
}

const clean = cleanTrace(baseTrace)
const types = clean.steps.map((step) => step.actionType)
const reasons = clean.noise.map((item) => item.reason)

check('清洗：动作序列符合预期', types.join(',') === 'goto,fill,press,click,hover,click,click,extract_text', types.join(','))
check('清洗：焦点点击合并进 fill', reasons.includes('focus-click-merged-into-fill') && clean.steps[1].sourceEventIds.join(',') === 'e3')
check('清洗：回车引发的被动跳转被剔除', reasons.includes('passive-navigate'))
check(
  '清洗：被动跳转 URL 成为回车步骤的后置校验',
  clean.steps[2].verification?.mode === 'url' &&
    clean.steps[2].verification?.expected === 'https://example.com/results'
)
check('清洗：0 尺寸合成点击被剔除', reasons.includes('zero-size-click'))
check('清洗：50ms 内 label 连带点击剔除', reasons.includes('label-duplicate-click'))
check('清洗：悬停噪声剔除（同目标紧邻点击）', reasons.includes('hover-incidental'))
check('清洗：菜单悬停保留（后接不同目标点击）', clean.steps.some((step) => step.actionType === 'hover'))
check('清洗：空标签页开→关成对剔除', reasons.filter((reason) => reason === 'empty-tab-open-close').length === 2)
check('清洗：选词映射为 extract_text', clean.steps[7].actionType === 'extract_text' && !clean.steps[7].parameterized)

// ---------------------------------------------------------------
// 2. 规则编译：步骤 / 参数 / 校验 / 覆盖审计
// ---------------------------------------------------------------
const workflow = buildWorkflowFromCleanTrace(baseTrace, clean)
check('规则编译：translatorVersion 标注 rules-only', String(workflow.translatorVersion).includes('rules-only'), workflow.translatorVersion)
check('规则编译：步骤数与清洗结果一致', workflow.steps.length === 8 && workflow.steps[0].engineBinding.actionType === 'goto')
check('规则编译：fill 参数化并生成参数', workflow.parameters.length === 1 && workflow.parameters[0].key === 'q', JSON.stringify(workflow.parameters.map((p) => `${p.key}:${p.label}`)))
check('规则编译：参数默认值来自录制', workflow.parameters[0].defaultValue === 'hello' && workflow.parameters[0].value === 'hello')
check('规则编译：fill 有值校验', workflow.steps[1].engineBinding.verification?.mode === 'value')
check('规则编译：goto 有 URL 校验', workflow.steps[0].engineBinding.verification?.mode === 'url')
check(
  '规则编译：coverage 统计噪声原因',
  workflow.coverage.totalEvents === 15 &&
    workflow.coverage.droppedEvents === 7 &&
    workflow.coverage.dropReasons['passive-navigate'] === 1,
  JSON.stringify(workflow.coverage.dropReasons)
)
check('规则编译：schemaVersion=2', workflow.schemaVersion === 2)

const payload = buildAnnotationPayload(baseTrace, clean)
check('AI payload：包含动作但无截图等大字段', payload.actions.length === 8 && !('events' in payload), JSON.stringify(Object.keys(payload)))

// ---------------------------------------------------------------
// 3. 标注结果 Schema 校验
// ---------------------------------------------------------------
const annotation = {
  summary: '搜索测试',
  annotations: clean.steps.map((step, index) => ({
    stepId: step.id,
    title: `标注步骤 ${index + 1}`,
    description: '描述',
    ...(step.parameterized ? { paramKey: `p${index}`, paramLabel: `参数${index}`, paramDescription: '说明' } : {}),
  })),
}
check('标注校验：合法标注通过', validateAnnotations(annotation, clean.steps).valid)
const missing = validateAnnotations({ summary: 'x', annotations: annotation.annotations.slice(0, 3) }, clean.steps)
check('标注校验：缺步骤被拒绝', missing.valid === false, missing.errors.join(';'))
const wrongId = validateAnnotations(
  { summary: 'x', annotations: annotation.annotations.map((item, index) => (index === 0 ? { ...item, stepId: 'nope' } : item)) },
  clean.steps
)
check('标注校验：非法 stepId 被拒绝', wrongId.valid === false, wrongId.errors[0])

// ---------------------------------------------------------------
// 4. 新录制动作：右键 / 拖拽 / 滚动 / 弹窗 / 下载
// ---------------------------------------------------------------
const newTrace = {
  projectId: 'proj-new',
  recordedAt: new Date(1000).toISOString(),
  updatedAt: new Date(1000).toISOString(),
  overallGoal: '剩余动作清洗',
  events: [
    ev('n1', 1000, 'navigate', { value: 'https://example.com' }),
    ev('n2', 2000, 'contextmenu', { target: target('#ctx', { innerText: '右键区域' }) }),
    ev('n3', 3000, 'drag', { target: target('#src', { innerText: '拖我' }), dragTo: target('#dst', { innerText: '落点' }) }),
    ev('n4', 4000, 'scroll', { value: '0,500' }),
    ev('n5', 5000, 'dialog', { value: 'confirm:确定吗？' }),
    ev('n6', 6000, 'download', { value: 'file.txt https://example.com/f' }),
    ev('n7', 7000, 'click', { target: target('#after', { tagName: 'button', innerText: '之后' }) }),
  ],
}
const newClean = cleanTrace(newTrace)
const newTypes = newClean.steps.map((step) => step.actionType)
check('新动作：右键/拖拽/弹窗保留，滚动/下载剔除', newTypes.join(',') === 'goto,contextmenu,drag,dialog,click', newTypes.join(','))
check('新动作：滚动标记为证据类噪声', newClean.noise.some((item) => item.reason === 'scroll-evidence-only'))
check('新动作：下载标记为副作用噪声', newClean.noise.some((item) => item.reason === 'download-side-effect'))
check('新动作：拖拽步骤带 dragTo', Boolean(newClean.steps[2].dragTo?.locators?.length))

const newWorkflow = buildWorkflowFromCleanTrace(newTrace, newClean)
const dragStep = newWorkflow.steps.find((step) => step.engineBinding.actionType === 'drag')
check('新动作：拖拽步骤绑定 dragTo 定位器', Boolean(dragStep?.engineBinding.dragTo?.locators?.length), JSON.stringify(dragStep?.engineBinding.dragTo))
check('新动作：弹窗步骤保留', newWorkflow.steps.some((step) => step.engineBinding.actionType === 'dialog'))
check(
  '新动作：coverage 记录新噪声原因',
  newWorkflow.coverage.dropReasons['scroll-evidence-only'] === 1 &&
    newWorkflow.coverage.dropReasons['download-side-effect'] === 1,
  JSON.stringify(newWorkflow.coverage.dropReasons)
)


// ---------------------------------------------------------------
// 5. 初始 tab_open / 新标签页导航 / 验证码跳转
// ---------------------------------------------------------------
const tabTrace = {
  projectId: 'proj-tab',
  recordedAt: new Date(1000).toISOString(),
  updatedAt: new Date(1000).toISOString(),
  overallGoal: '新标签页与验证码清洗',
  events: [
    ev('t1', 1000, 'tab_open', { category: 'window', tabId: 'tab-2', value: 'about:blank' }),
    ev('t2', 2000, 'navigate', { tabId: 'tab-2', value: 'https://www.baidu.com/' }),
    ev('t3', 3000, 'click', { tabId: 'tab-2', target: target('#kw', { tagName: 'input' }) }),
    ev('t4', 4000, 'navigate', { tabId: 'tab-2', value: 'https://www.baidu.com/s?wd=test' }),
    ev('t5', 5000, 'navigate', { tabId: 'tab-2', value: 'https://wappass.baidu.com/static/captcha/tuxing.html?x=1' }),
    ev('t6', 6000, 'navigate', { tabId: 'tab-2', value: 'https://www.baidu.com/s?wd=test&page=2' }),
    ev('t7', 7000, 'tab_open', { category: 'window', tabId: 'tab-3', value: 'about:blank' }),
    ev('t8', 7100, 'navigate', { tabId: 'tab-3', value: 'https://example.com/next' }),
  ],
}
const tabClean = cleanTrace(tabTrace)
const tabReasons = tabClean.noise.map((item) => item.reason)
check('清洗：录制开头的初始 tab_open 被丢弃', tabReasons.includes('initial-tab-open') && tabClean.steps[0].actionType === 'goto')
check(
  '清洗：tab_open 后的导航落成 goto（不是空白页点击）',
  tabClean.steps[0].actionType === 'goto' && tabClean.steps[0].value === 'https://www.baidu.com/'
)
check(
  '清洗：点击后的首个被动跳转作为校验',
  tabClean.steps[1].verification?.mode === 'url' && tabClean.steps[1].verification?.expected === 'https://www.baidu.com/s?wd=test'
)
check('清洗：验证码跳转被丢弃', tabReasons.includes('transient-redirect'))
check('清洗：后续重复被动跳转不覆盖校验', tabReasons.includes('duplicate-passive-navigate'))
const midTabOpen = tabClean.steps.slice(2)
check(
  '清洗：中途新标签页保留 tab_open + goto',
  midTabOpen[0]?.actionType === 'tab_open' && midTabOpen[1]?.actionType === 'goto' && midTabOpen[1]?.value === 'https://example.com/next'
)

console.log(`\n=== compiler：${passed}/${passed + failed} 通过 ===`)
process.exit(failed === 0 ? 0 : 1)
