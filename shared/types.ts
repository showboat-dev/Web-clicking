/**
 * 前后端共享的领域类型契约。
 *
 * 前端（src/）与后端（server/）都从这里导入类型，避免两边各写一份导致漂移。
 * 该文件只包含类型声明（无运行时代码），可被 Node 的类型擦除与 Vite 同时消费。
 */

// ============================================================
// 1. 录制原始数据：喂给大模型的输入（RecordingTrace）
// ============================================================

export type LocatorStrategy = 'testId' | 'id' | 'role' | 'label' | 'text' | 'css' | 'xpath'

/** iframe 链中的一层（顶层向下，不含主文档） */
export interface FrameRef {
  url: string
  name?: string
  index?: number
}

export interface ViewportInfo {
  width: number
  height: number
  dpr: number
  scrollX: number
  scrollY: number
}

export interface CandidateLocator {
  strategy: LocatorStrategy
  value: string
  priority: number
}

export interface TargetEvidence {
  tagName: string
  role?: string
  innerText?: string
  nearbyLabel?: string
  attributes?: Record<string, string>
  locators: CandidateLocator[]
  boundingBox?: { x: number; y: number; width: number; height: number }
  /** shadow DOM 的 host 链（顶层向下） */
  shadowChain?: string[]
  /** shadow root 模式：closed 时 Playwright 无法穿透，只能走视觉兜底 */
  shadowMode?: 'open' | 'closed'
  /** 目标元素的 outerHTML 片段 */
  domSnapshot?: string
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
    /** 多层 iframe 链（P1 录制证据） */
    frameChain?: FrameRef[]
    /** 录制时的视口信息（视觉兜底/坐标归一化用） */
    viewport?: ViewportInfo
  }
  // 第 2 层：动作本身（涵盖窗口/标签页级变动 + 页内操作）
  action: {
    category: 'window' | 'page'
    type:
      | 'tab_open'
      | 'tab_close'
      | 'navigate'
      | 'click'
      | 'dblclick'
      | 'contextmenu'
      | 'hover'
      | 'drag'
      | 'scroll'
      | 'fill'
      | 'select'
      | 'select_text'
      | 'file_upload'
      | 'press'
      | 'dialog'
      | 'download'
    value?: string
    key?: string
  }
  // 第 3 层：操作对象的多重身份与候选定位器
  target?: TargetEvidence
  // 拖拽的目标元素（action.type === 'drag' 时存在）
  dragTo?: TargetEvidence
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

// ============================================================
// 2. 大模型清洗编译后的人机分层工作流（OperationWorkflow）
// ============================================================

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

export type WorkflowStepCategory = 'fixed' | 'parameterized'

/** 动作后置校验规则（P0：最小可用版，可由翻译器或人工补全） */
export interface StepVerificationRule {
  mode: 'value' | 'url' | 'title' | 'text' | 'none'
  expected?: string
  timeoutMs?: number
}

export type WorkflowActionType =
  | 'goto'
  | 'tab_open'
  | 'tab_close'
  | 'click'
  | 'dblclick'
  | 'contextmenu'
  | 'hover'
  | 'drag'
  | 'scroll'
  | 'fill'
  | 'file_upload'
  | 'dialog'
  | 'select'
  | 'press'
  | 'extract_text'
  | 'wait_for_text'

/** 结构恢复证据：L1 定位失败后，执行器用它重新推导目标（P1） */
export interface StepRecovery {
  frameChain?: FrameRef[]
  shadowChain?: string[]
  /** closed shadow root 无法被 Playwright 穿透，执行器应直接走 L3 */
  shadowMode?: 'open' | 'closed'
  domSnapshot?: string
  nearbyText?: string
  role?: string
  innerText?: string
  tagName?: string
  attributes?: Record<string, string>
  bbox?: { x: number; y: number; width: number; height: number }
  /** 录制时截图（相对路径），供 L3 视觉 Agent 做参考 */
  referenceScreenshot?: string
}

/** 翻译覆盖审计：每个原始事件是否有归宿（P1） */
export interface WorkflowCoverage {
  totalEvents: number
  mappedEvents: number
  droppedEvents: number
  unmappedEventIds: string[]
  warnings: string[]
  /** 被剔除事件的原因分布（规则清洗统计） */
  dropReasons?: Record<string, number>
}

export interface WorkflowStep {
  id: string
  order: number
  // 固定硬操作（fixed）/ 动态参数化操作（parameterized）
  stepCategory: WorkflowStepCategory
  // 溯源：对应原始录制轨迹中的哪些事件 ID
  sourceEventIds: string[]
  // 给人看的展示层 (Human View)
  humanView: {
    title: string
    description: string
    paramKey?: string
    paramLabel?: string
  }
  // 给 Playwright 确定性执行的绑定层 (Engine Binding)
  engineBinding: {
    tabId: string
    frameUrl?: string
    /** 多层 iframe 链（优先于 frameUrl） */
    frameChain?: FrameRef[]
    /** 结构恢复证据（L2 兜底） */
    recovery?: StepRecovery
    /** 拖拽目标（actionType === 'drag'） */
    dragTo?: { locators: CandidateLocator[]; recovery?: StepRecovery }
    actionType: WorkflowActionType
    paramKey?: string
    value?: string
    locators: CandidateLocator[]
    timeoutMs: number
    optional?: boolean
    /** 动作后置校验；缺省时引擎按 actionType 采用默认校验（fill/select 校验输入值，click/press 做页面变化软校验） */
    verification?: StepVerificationRule
  }
}

export interface OperationWorkflow {
  projectId: string
  updatedAt: string
  /** IR 结构版本：2 = P1 证据链版本（旧数据可为空） */
  schemaVersion?: 2
  /** 生成该工作流的翻译器版本，便于重编译与回归 */
  translatorVersion?: string
  /** 翻译覆盖审计结果 */
  coverage?: WorkflowCoverage
  summary: string
  removedNoiseCount: number
  // 项目级动态参数表（供用户在运行前统一配置管理）
  parameters: WorkflowParameter[]
  // 部分固定（fixed）、部分抽象（parameterized）的操作步骤序列
  steps: WorkflowStep[]
}

// ============================================================
// 3. 项目与运行记录
// ============================================================

export interface RunRecord {
  id: string
  time: string
  status: 'success' | 'failed'
  duration: string
  note: string
  /** 逐步执行遥测（命中定位策略、耗时、校验结果、失败原因） */
  logs?: StepExecutionLog[]
}

export type ProjectStatus = 'idle' | 'recording' | 'running' | 'success' | 'failed'

export interface Project {
  id: string
  name: string
  description: string
  stepsCount: number
  lastStatus: ProjectStatus
  runs: RunRecord[]
  traceFile?: string
  workflowFile?: string
  trace?: RecordingTrace
  workflow?: OperationWorkflow
}

// ============================================================
// 4. 异步运行与 WebSocket 推送协议
// ============================================================

/** 动作后置校验结果：verified 通过 / soft 仅软信号 / failed 未通过 / skipped 未校验 */
export type StepVerificationResult = 'verified' | 'soft' | 'failed' | 'skipped'

/** 单步执行遥测 */
export interface StepExecutionLog {
  stepIndex: number
  totalSteps: number
  stepId?: string
  title: string
  actionType?: WorkflowActionType
  status: 'success' | 'failed'
  durationMs: number
  /** 实际命中的候选定位器（P0 只有 L1 语义/结构候选；L2 结构恢复后续接入） */
  locatorStrategy?: LocatorStrategy
  locatorValue?: string
  /** 命中的兜底层级：L1 直接用录制定位器；L2 用结构证据恢复 */
  tier?: 'L1' | 'L2' | 'L3'
  /** L2 命中方式说明（shadow 链 / DOM 快照 / 邻近锚点） */
  matchedVia?: string
  verification: StepVerificationResult
  verificationDetail?: string
  error?: string
  /** 失败时的现场截图（相对路径） */
  failureScreenshot?: string
  /** 失败时的页面 URL */
  pageUrl?: string
}

/** 引擎在每执行完一个步骤（或一条回放事件）后上报的进度 */
export interface StepProgress {
  /** 已完成/正在上报的步骤序号，从 1 开始 */
  stepIndex: number
  totalSteps: number
  stepId?: string
  title: string
  status: 'success' | 'failed'
  durationMs: number
  locatorStrategy?: LocatorStrategy
  tier?: 'L1' | 'L2' | 'L3'
  verification?: StepVerificationResult
}

/** POST /api/projects/:id/run 的即时响应（任务已受理，真正执行在后台） */
export interface RunAccepted {
  accepted: true
  runId: string
  totalSteps: number
}

export type ServerMessage =
  | { type: 'connected'; message: string }
  | {
      type: 'trace_updated'
      projectId: string
      stepsCount: number
      latestEvent: RecordedEvent
    }
  | {
      type: 'run_started'
      projectId: string
      runId: string
      totalSteps: number
      startedAt: string
    }
  | ({ type: 'run_progress'; projectId: string; runId: string } & StepProgress)
  | {
      type: 'run_finished'
      projectId: string
      runId: string
      runRecord: RunRecord
      project: Project
    }
