import type {
  OperationWorkflow,
  Project,
  RecordingTrace,
  RunAccepted,
} from '../../shared/types.ts'

export class ApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

interface ErrorBody {
  error?: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  const contentType = response.headers.get('content-type') || ''
  const body: unknown = contentType.includes('application/json')
    ? await response.json().catch(() => null)
    : null

  if (!response.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as ErrorBody).error === 'string'
        ? (body as ErrorBody).error!
        : `请求失败（HTTP ${response.status}）`
    throw new ApiError(message, response.status)
  }

  return body as T
}

function jsonInit(method: string, payload?: unknown): RequestInit {
  if (payload === undefined) {
    return { method }
  }
  return {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }
}

export function fetchProjects(): Promise<Project[]> {
  return request<Project[]>('/api/projects')
}

export function createProject(input: {
  name: string
  description: string
  autoOpenBrowser?: boolean
}): Promise<Project> {
  return request<Project>('/api/projects', jsonInit('POST', input))
}

export function deleteProject(id: string): Promise<{ success: boolean }> {
  return request<{ success: boolean }>(`/api/projects/${id}`, { method: 'DELETE' })
}

export function startRecording(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${id}/record/start`, { method: 'POST' })
}

export function stopRecording(id: string): Promise<Project> {
  return request<Project>(`/api/projects/${id}/record/stop`, { method: 'POST' })
}

export function fetchTrace(id: string): Promise<RecordingTrace> {
  return request<RecordingTrace>(`/api/projects/${id}/trace`)
}

export function fetchWorkflow(id: string): Promise<OperationWorkflow> {
  return request<OperationWorkflow>(`/api/projects/${id}/workflow`)
}

export function compileWorkflow(
  id: string
): Promise<{ project: Project; workflow: OperationWorkflow }> {
  return request<{ project: Project; workflow: OperationWorkflow }>(
    `/api/projects/${id}/compile`,
    { method: 'POST' }
  )
}

export function saveParameters(
  id: string,
  parameters: Record<string, string>
): Promise<{ project: Project; workflow: OperationWorkflow }> {
  return request<{ project: Project; workflow: OperationWorkflow }>(
    `/api/projects/${id}/parameters`,
    jsonInit('PUT', { parameters })
  )
}

export function runProject(
  id: string,
  parameters?: Record<string, string>
): Promise<RunAccepted> {
  return request<RunAccepted>(
    `/api/projects/${id}/run`,
    jsonInit('POST', parameters && Object.keys(parameters).length > 0 ? { parameters } : {})
  )
}
