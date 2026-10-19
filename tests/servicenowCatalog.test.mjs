/**
 * ServiceNow 目录项字段对齐：选项值、多行变量集、实例 URL 识别。
 * 运行：node tests/servicenowCatalog.test.mjs
 */
import {
  catalogSysIdFromWorkflow,
  fieldsFromCatalogItem,
  mapCatalogFields,
  resolveChoiceValue,
} from '../server/servicenowCatalog.ts'

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

const workflow = {
  projectId: 'proj-x',
  updatedAt: '2026-01-01T00:00:00.000Z',
  summary: '',
  removedNoiseCount: 0,
  parameters: [],
  steps: [
    {
      id: 'step-1',
      order: 1,
      stepCategory: 'fixed',
      sourceEventIds: [],
      humanView: { title: '打开目录项', description: '' },
      engineBinding: {
        tabId: 'tab-1',
        actionType: 'goto',
        value:
          'https://dev399132.service-now.com/esc?id=sc_cat_item&sys_id=3f1dd0320a0a0b99000a53f7604a2ef9',
        locators: [],
        timeoutMs: 8000,
      },
    },
  ],
}

check(
  '同实例目录项能取出 sys_id',
  catalogSysIdFromWorkflow(workflow, 'https://dev399132.service-now.com') ===
    '3f1dd0320a0a0b99000a53f7604a2ef9'
)
check(
  '别的实例不走 API',
  catalogSysIdFromWorkflow(workflow, 'https://dev000000.service-now.com') === null
)

check('High 对齐到选项值 1', resolveChoiceValue('High', [{ label: '1 - High', value: '1' }]) === '1')

const fields = fieldsFromCatalogItem({
  variables: [
    {
      name: 'urgency',
      label: 'Urgency',
      type: 5,
      mandatory: true,
      choices: [
        { label: '-- None --' },
        { label: '1 - High', value: '1' },
      ],
    },
    { name: 'comments', label: 'Please describe your issue below', type: 2, mandatory: true },
    { name: 'spacer', label: '', type: 14, mandatory: false },
  ],
  variable_sets: [
    {
      internal_name: 'affected_users',
      title: 'Affected users',
      variables: [{ name: 'user_name', label: 'User' }],
    },
  ],
})

const mapped = mapCatalogFields(fields, [
  { key: 'urgency', label: 'Urgency 紧急程度', value: 'High' },
  { key: 'comments', label: 'Please describe your issue below', value: 'sample issue' },
  { key: 'rows', label: 'Affected users', value: 'alice' },
])

check('选项字段写成内部值', mapped.urgency === '1')
check('文本字段原样保留', mapped.comments === 'sample issue')
check(
  '多行变量集单列文本包成 JSON 字符串',
  mapped.affected_users === '[{"user_name":"alice"}]'
)

const rows = mapCatalogFields(
  [
    {
      name: 'lines',
      label: 'Lines',
      kind: 'mrvs',
      mandatory: false,
      choices: [],
      columns: [
        { name: 'a', label: 'A' },
        { name: 'b', label: 'B' },
      ],
    },
  ],
  [{ key: 'lines', label: 'Lines', value: '[{"a":"1","b":"2"}]' }]
)
check('多行变量集已是 JSON 数组时保持字符串', rows.lines === '[{"a":"1","b":"2"}]')

let missing = ''
try {
  mapCatalogFields(fields, [{ key: 'urgency', label: 'Urgency', value: 'High' }])
} catch (error) {
  missing = error instanceof Error ? error.message : ''
}
check('缺必填字段会报出字段名', missing.includes('Please describe your issue below'))

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
