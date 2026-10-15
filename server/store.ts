import fs from 'node:fs'
import path from 'node:path'
import type {
  OperationWorkflow,
  Project,
  RecordedEvent,
  RecordingTrace,
} from './types.ts'

export const DATA_DIR = path.resolve(process.cwd(), 'data')
export const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json')
export const TRACES_DIR = path.join(DATA_DIR, 'traces')
export const WORKFLOWS_DIR = path.join(DATA_DIR, 'workflows')
export const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots')
export const BROWSER_PROFILE_DIR = path.join(DATA_DIR, 'browser-profile')

const INITIAL_PROJECTS: Project[] = [
  {
    id: 'proj-1',
    name: '人事入职审批单自动填报',
    description: '打开内部人事系统，筛选待办入职申请，自动核对部门信息并点击审批通过。',
    stepsCount: 6,
    lastStatus: 'success',
    runs: [
      { id: 'r-102', time: '今天 18:45', status: 'success', duration: '12.4 秒', note: '已处理 5 条入职审批单' },
      { id: 'r-101', time: '昨天 09:30', status: 'success', duration: '14.1 秒', note: '已处理 8 条入职审批单' },
    ],
  },
]

export function ensureDataDirs() {
  for (const dir of [DATA_DIR, TRACES_DIR, WORKFLOWS_DIR, SCREENSHOTS_DIR, BROWSER_PROFILE_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, JSON.stringify(INITIAL_PROJECTS, null, 2), 'utf-8')
  }
}

export function loadProjects(): Project[] {
  ensureDataDirs()
  try {
    const raw = fs.readFileSync(PROJECTS_FILE, 'utf-8')
    return JSON.parse(raw) as Project[]
  } catch {
    return INITIAL_PROJECTS
  }
}

export function saveProjects(projects: Project[]): void {
  ensureDataDirs()
  fs.writeFileSync(PROJECTS_FILE, JSON.stringify(projects, null, 2), 'utf-8')
}

export function getTraceFilePath(projectId: string): string {
  ensureDataDirs()
  return path.join(TRACES_DIR, `${projectId}.json`)
}

export function getWorkflowFilePath(projectId: string): string {
  ensureDataDirs()
  return path.join(WORKFLOWS_DIR, `${projectId}.json`)
}

export function initOrResetTrace(projectId: string, overallGoal?: string): RecordingTrace {
  ensureDataDirs()
  const trace: RecordingTrace = {
    projectId,
    recordedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    overallGoal,
    events: [],
  }
  const filePath = getTraceFilePath(projectId)
  fs.writeFileSync(filePath, JSON.stringify(trace, null, 2), 'utf-8')

  const projects = loadProjects()
  const updated = projects.map((p) =>
    p.id === projectId
      ? {
          ...p,
          traceFile: `data/traces/${projectId}.json`,
          trace,
          workflow: undefined,
          workflowFile: undefined,
          stepsCount: 0,
        }
      : p
  )
  saveProjects(updated)
  return trace
}

export function loadTrace(projectId: string): RecordingTrace | null {
  const filePath = getTraceFilePath(projectId)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as RecordingTrace
  } catch {
    return null
  }
}

export function saveWorkflow(projectId: string, workflow: OperationWorkflow): OperationWorkflow {
  ensureDataDirs()
  const filePath = getWorkflowFilePath(projectId)
  fs.writeFileSync(filePath, JSON.stringify(workflow, null, 2), 'utf-8')

  const projects = loadProjects()
  const updated = projects.map((p) =>
    p.id === projectId
      ? {
          ...p,
          workflowFile: `data/workflows/${projectId}.json`,
          workflow,
          stepsCount: workflow.steps.length,
        }
      : p
  )
  saveProjects(updated)
  return workflow
}

export function loadWorkflow(projectId: string): OperationWorkflow | null {
  const filePath = getWorkflowFilePath(projectId)
  if (!fs.existsSync(filePath)) return null
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as OperationWorkflow
  } catch {
    return null
  }
}

export function updateWorkflowParameters(
  projectId: string,
  paramUpdates: Record<string, string>
): OperationWorkflow | null {
  const workflow = loadWorkflow(projectId)
  if (!workflow) return null

  const updatedParameters = (workflow.parameters || []).map((param) => {
    if (Object.prototype.hasOwnProperty.call(paramUpdates, param.key)) {
      return {
        ...param,
        value: String(paramUpdates[param.key]),
      }
    }
    return param
  })

  const updatedSteps = workflow.steps.map((step) => {
    const paramKey = step.engineBinding.paramKey || step.humanView.paramKey
    if (paramKey && Object.prototype.hasOwnProperty.call(paramUpdates, paramKey)) {
      return {
        ...step,
        engineBinding: {
          ...step.engineBinding,
          value: String(paramUpdates[paramKey]),
        },
      }
    }
    return step
  })

  const updatedWorkflow: OperationWorkflow = {
    ...workflow,
    updatedAt: new Date().toISOString(),
    parameters: updatedParameters,
    steps: updatedSteps,
  }

  return saveWorkflow(projectId, updatedWorkflow)
}

export function appendRecordedEvent(projectId: string, event: RecordedEvent): RecordingTrace {
  ensureDataDirs()
  const existing = loadTrace(projectId) || {
    projectId,
    recordedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: [],
  }

  // 如果连续两条 fill 事件针对同一个元素（同一个第一候选选择器），自动合并更新值，避免每敲一个字母记一条
  const lastEvent = existing.events[existing.events.length - 1]
  const sameTargetFill =
    lastEvent &&
    lastEvent.action.type === 'fill' &&
    event.action.type === 'fill' &&
    lastEvent.pageContext.tabId === event.pageContext.tabId &&
    lastEvent.target?.locators?.[0]?.value &&
    lastEvent.target?.locators?.[0]?.value === event.target?.locators?.[0]?.value

  if (sameTargetFill) {
    lastEvent.timestamp = event.timestamp
    lastEvent.isoTime = event.isoTime
    lastEvent.action.value = event.action.value
    if (event.screenshotPath) {
      lastEvent.screenshotPath = event.screenshotPath
    }
  } else {
    existing.events.push(event)
  }

  existing.updatedAt = new Date().toISOString()

  const filePath = getTraceFilePath(projectId)
  fs.writeFileSync(filePath, JSON.stringify(existing, null, 2), 'utf-8')

  // 同步更新 projects.json 中的 stepsCount 和 trace 摘要
  const projects = loadProjects()
  const updated = projects.map((p) =>
    p.id === projectId
      ? {
          ...p,
          traceFile: `data/traces/${projectId}.json`,
          stepsCount: existing.events.length,
          trace: existing,
        }
      : p
  )
  saveProjects(updated)

  return existing
}
