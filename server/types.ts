// 1. 喂给大模型的原始录制输入数据结构 (RecordingTrace)
export interface CandidateLocator {
  strategy: 'testId' | 'id' | 'role' | 'label' | 'text' | 'css' | 'xpath'
  value: string
  priority: number
}

export interface RecordedEvent {
  id: string
  timestamp: number
  isoTime: string
  // 第 1 层：时间与页面/窗口上下文
  pageContext: {
    tabId: string
    tabIndex: number
    url: string
    title: string
    frameUrl?: string
  }
  // 第 2 层：动作本身（涵盖窗口/标签页级变动 + 页内操作）
  action: {
    category: 'window' | 'page'
    type:
      | 'tab_open'
      | 'tab_close'
      | 'navigate'
      | 'click'
      | 'fill'
      | 'select'
      | 'select_text'
      | 'press'
    value?: string
    key?: string
  }
  // 第 3 层：操作对象的多重身份与候选定位器
  target?: {
    tagName: string
    role?: string
    innerText?: string
    nearbyLabel?: string
    attributes?: Record<string, string>
    locators: CandidateLocator[]
    boundingBox?: { x: number; y: number; width: number; height: number }
  }
  // 第 4 层：用户边操作边说的语音/文字解说
  userComment?: string
  // 第 5 层：视觉快照路径
  screenshotPath?: string
}

export interface RecordingTrace {
  projectId: string
  recordedAt: string
  updatedAt: string
  overallGoal?: string
  events: RecordedEvent[]
}

// 2. 大模型清洗编译后的人机分层工作流数据结构 (OperationWorkflow)
// 顶层项目动态参数定义（由大模型从动态输入步骤中自动抽取出）
export interface WorkflowParameter {
  key: string
  label: string
  description: string
  inputType: 'text' | 'select' | 'number'
  defaultValue: string
  value: string
  required: boolean
  boundStepIds: string[]
}

export interface WorkflowStep {
  id: string
  order: number
  // 操作分类：fixed 表示固定硬操作（如点击固定按钮、回车、打开固定入口），parameterized 表示动态参数化操作（如输入框填值、下拉选择）
  stepCategory: 'fixed' | 'parameterized'
  // 溯源：对应原始录制轨迹中的哪些事件 ID
  sourceEventIds: string[]
  // 给人看的展示层 (Human View)
  humanView: {
    title: string
    description: string
    // 当 stepCategory === 'parameterized' 时，关联顶层 parameters 中的 key
    paramKey?: string
    paramLabel?: string
  }
  // 给 Playwright 确定性执行的绑定层 (Engine Binding)
  engineBinding: {
    tabId: string
    frameUrl?: string
    actionType:
      | 'goto'
      | 'tab_open'
      | 'tab_close'
      | 'click'
      | 'fill'
      | 'select'
      | 'press'
      | 'extract_text'
      | 'wait_for_text'
    // 若绑定了动态参数则指向顶层参数的 key，执行时动态替换为参数的最新值
    paramKey?: string
    // 固定值或录制时的初始默认值
    value?: string
    locators: CandidateLocator[]
    timeoutMs: number
    optional?: boolean
  }
}

export interface OperationWorkflow {
  projectId: string
  updatedAt: string
  summary: string
  removedNoiseCount: number
  // 项目级动态参数表（供用户在运行前统一配置管理）
  parameters: WorkflowParameter[]
  // 部分固定（fixed）、部分抽象（parameterized）的操作步骤序列
  steps: WorkflowStep[]
}

// 3. 项目与运行记录数据结构
export interface RunRecord {
  id: string
  time: string
  status: 'success' | 'failed'
  duration: string
  note: string
}

export interface Project {
  id: string
  name: string
  description: string
  stepsCount: number
  lastStatus: 'idle' | 'recording' | 'running' | 'success' | 'failed'
  runs: RunRecord[]
  traceFile?: string
  workflowFile?: string
  trace?: RecordingTrace
  workflow?: OperationWorkflow
}
