/**
 * 核心逻辑单测：原始录制证据 → 工作流增强（frameChain / recovery / 派生定位器 / 校验 / 覆盖审计）
 * 运行：node tests/enrich.test.mjs
 */
import {
  buildCoverage,
  deriveCandidateLocators,
  enrichWorkflowWithEvidence,
  validateRawWorkflow,
} from '../server/ai.ts'

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

const trace = {
  projectId: 'proj-x',
  recordedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  events: [
    {
      id: 'evt-1',
      timestamp: 1000,
      isoTime: '2026-01-01T00:00:01.000Z',
      pageContext: { tabId: 'tab-1', tabIndex: 1, url: 'https://example.com', title: '首页' },
      action: { category: 'window', type: 'navigate', value: 'https://example.com' },
    },
    {
      id: 'evt-2',
      timestamp: 2000,
      isoTime: '2026-01-01T00:00:02.000Z',
      pageContext: {
        tabId: 'tab-1',
        tabIndex: 1,
        url: 'https://example.com',
        title: '首页',
        frameChain: [{ url: 'https://example.com/frame' }],
      },
      action: { category: 'page', type: 'click', value: '提交' },
      target: {
        tagName: 'button',
        role: 'button',
        innerText: '提交',
        nearbyLabel: '提交表单',
        attributes: { id: 'go', 'data-testid': 'submit-btn' },
        locators: [{ strategy: 'id', value: '#go', priority: 2 }],
        boundingBox: { x: 10, y: 20, width: 80, height: 30 },
        shadowChain: ['#host'],
        domSnapshot: '<button id="go" data-testid="submit-btn">提交</button>',
      },
      screenshotPath: 'data/screenshots/proj-x/evt-2.jpg',
    },
    {
      id: 'evt-3',
      timestamp: 2500,
      isoTime: '2026-01-01T00:00:02.500Z',
      pageContext: { tabId: 'tab-1', tabIndex: 1, url: 'https://example.com/done', title: '完成' },
      action: { category: 'window', type: 'navigate', value: 'https://example.com/done' },
    },
    {
      id: 'evt-4',
      timestamp: 3000,
      isoTime: '2026-01-01T00:00:03.000Z',
      pageContext: { tabId: 'tab-1', tabIndex: 1, url: 'https://example.com/done', title: '完成' },
      action: { category: 'page', type: 'fill', value: 'hello' },
      target: {
        tagName: 'input',
        role: 'textbox',
        innerText: '',
        nearbyLabel: '姓名',
        attributes: { name: 'name' },
        locators: [{ strategy: 'css', value: 'input[name="name"]', priority: 6 }],
        boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      },
    },
  ],
}

const workflow = {
  projectId: 'proj-x',
  updatedAt: '2026-01-01T00:00:00.000Z',
  summary: '测试',
  removedNoiseCount: 0,
  parameters: [],
  steps: [
    {
      id: 'step-1',
      order: 1,
      stepCategory: 'fixed',
      sourceEventIds: ['evt-2'],
      humanView: { title: '点击提交', description: '' },
      engineBinding: {
        tabId: 'tab-1',
        actionType: 'click',
        locators: [{ strategy: 'id', value: '#go', priority: 2 }],
        timeoutMs: 8000,
      },
    },
    {
      id: 'step-2',
      order: 2,
      stepCategory: 'parameterized',
      sourceEventIds: ['evt-4'],
      humanView: { title: '填写姓名', description: '', paramKey: 'name', paramLabel: '姓名' },
      engineBinding: {
        tabId: 'tab-1',
        actionType: 'fill',
        paramKey: 'name',
        locators: [{ strategy: 'css', value: 'input[name="name"]', priority: 6 }],
        timeoutMs: 8000,
      },
    },
  ],
}

const enriched = enrichWorkflowWithEvidence(trace, workflow)
const step1 = enriched.steps[0]
const step2 = enriched.steps[1]

check('enrich：写入 schemaVersion=2 与 translatorVersion', enriched.schemaVersion === 2 && Boolean(enriched.translatorVersion), enriched.translatorVersion)
check(
  'enrich：frameChain 从事件证据补齐',
  JSON.stringify(step1.engineBinding.frameChain) === JSON.stringify([{ url: 'https://example.com/frame' }])
)
check(
  'enrich：shadowChain / DOM 快照进入 recovery',
  step1.engineBinding.recovery?.shadowChain?.[0] === '#host' &&
    String(step1.engineBinding.recovery?.domSnapshot).includes('submit-btn')
)
check(
  'enrich：bbox / role / 邻近文本进入 recovery',
  step1.engineBinding.recovery?.bbox?.width === 80 &&
    step1.engineBinding.recovery?.role === 'button' &&
    step1.engineBinding.recovery?.nearbyText === '提交表单'
)
check(
  'enrich：参考截图进入 recovery',
  step1.engineBinding.recovery?.referenceScreenshot === 'data/screenshots/proj-x/evt-2.jpg'
)
check(
  'enrich：派生 role/text/label/testid 定位器',
  ['role', 'text', 'label'].every((strategy) =>
    step1.engineBinding.locators.some((loc) => loc.strategy === strategy)
  ) && step1.engineBinding.locators.some((loc) => loc.value.includes('submit-btn'))
)
check(
  'enrich：click 后跟 navigate → URL 后置校验',
  step1.engineBinding.verification?.mode === 'url' &&
    step1.engineBinding.verification?.expected === 'https://example.com/done'
)
check('enrich：fill → 输入值后置校验', step2.engineBinding.verification?.mode === 'value')
check(
  'enrich：覆盖审计统计正确',
  enriched.coverage?.totalEvents === 4 &&
    enriched.coverage?.mappedEvents === 2 &&
    enriched.coverage?.droppedEvents === 2,
  JSON.stringify(enriched.coverage)
)
check('enrich：未映射事件产生警告', (enriched.coverage?.warnings.length || 0) > 0, enriched.coverage?.warnings?.[0])

const invalid = validateRawWorkflow({ steps: [{ engineBinding: { actionType: 'not-a-real-action' } }] })
check('schema：拒绝非法 actionType', invalid.valid === false && invalid.errors.length > 0, invalid.errors[0])
check('schema：合法工作流通过', validateRawWorkflow(workflow).valid === true)

const deduped = deriveCandidateLocators(trace.events[1], trace.events[1].target.locators)
check(
  '派生定位器去重（不重复已有 id 策略）',
  deduped.every((loc) => !(loc.strategy === 'id' && loc.value === '#go')) && deduped.length >= 4,
  deduped.map((loc) => `${loc.strategy}:${loc.value}`).join(' | ')
)

const coverage = buildCoverage(trace, workflow.steps)
check('coverage：可独立调用', coverage.totalEvents === 4 && coverage.unmappedEventIds.length === 2)

console.log(`\n=== enrich：${passed}/${passed + failed} 通过 ===`)
process.exit(failed === 0 ? 0 : 1)
