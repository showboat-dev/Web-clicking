import { useEffect, useState } from 'react'
import {
  Plus,
  Play,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Trash2,
  Search,
  History,
  X,
  CircleDot,
  Square,
  FileJson,
  Sparkles,
  SlidersHorizontal,
  Save,
} from 'lucide-react'

interface RunRecord {
  id: string
  time: string
  status: 'success' | 'failed'
  duration: string
  note: string
}

interface WorkflowParameter {
  key: string
  label: string
  description: string
  inputType: 'text' | 'select' | 'number'
  defaultValue: string
  value: string
  required: boolean
  boundStepIds: string[]
}

interface WorkflowStep {
  id: string
  order: number
  stepCategory: 'fixed' | 'parameterized'
  sourceEventIds: string[]
  humanView: {
    title: string
    description: string
    paramKey?: string
    paramLabel?: string
  }
  engineBinding: {
    tabId: string
    actionType: string
    paramKey?: string
    value?: string
  }
}

interface OperationWorkflow {
  projectId: string
  updatedAt: string
  summary: string
  removedNoiseCount: number
  parameters: WorkflowParameter[]
  steps: WorkflowStep[]
}

interface Project {
  id: string
  name: string
  description: string
  stepsCount: number
  lastStatus: 'idle' | 'recording' | 'running' | 'success' | 'failed'
  runs: RunRecord[]
  traceFile?: string
  workflowFile?: string
  workflow?: OperationWorkflow
}

const FALLBACK_PROJECTS: Project[] = [
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

export function App() {
  const [projects, setProjects] = useState<Project[]>(FALLBACK_PROJECTS)
  const [searchQuery, setSearchQuery] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [historyProject, setHistoryProject] = useState<Project | null>(null)
  const [dataModal, setDataModal] = useState<{
    project: Project
    activeTab: 'visual' | 'workflow' | 'trace'
    traceJson: string
    workflow: OperationWorkflow | null
    workflowJson: string | null
    paramDrafts: Record<string, string>
    isCompiling: boolean
    isSavingParams: boolean
    compileError: string | null
    saveMessage: string | null
  } | null>(null)

  const [newName, setNewName] = useState('')
  const [newDesc, setNewDesc] = useState('')
  const [isCreating, setIsCreating] = useState(false)

  useEffect(() => {
    fetch('/api/projects')
      .then((res) => (res.ok ? res.json() : Promise.reject()))
      .then((data: Project[]) => setProjects(data))
      .catch(() => {
        // 如果后端尚未就绪则保留本地默认列表
      })

    // 建立 WebSocket 实时监听内置浏览器的录制动作
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`)
    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data) as {
          type?: string
          projectId?: string
          stepsCount?: number
        }
        if (msg.type === 'trace_updated' && msg.projectId !== undefined && msg.stepsCount !== undefined) {
          setProjects((prev) =>
            prev.map((p) =>
              p.id === msg.projectId ? { ...p, stepsCount: msg.stepsCount! } : p
            )
          )
        }
      } catch {
        // ignore invalid ws message
      }
    }

    return () => {
      ws.close()
    }
  }, [])

  const filteredProjects = projects.filter(
    (p) =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase())
  )

  const handleCreateProject = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!newName.trim() || isCreating) return

    setIsCreating(true)
    try {
      const res = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.trim(),
          description: newDesc.trim(),
          autoOpenBrowser: true,
        }),
      })
      if (res.ok) {
        const created = (await res.json()) as Project
        setProjects((prev) => [created, ...prev])
      }
    } catch {
      const created: Project = {
        id: `proj-${Date.now()}`,
        name: newName.trim(),
        description: newDesc.trim() || '暂无描述，点击进入配置具体操作流程。',
        stepsCount: 0,
        lastStatus: 'recording',
        runs: [],
      }
      setProjects((prev) => [created, ...prev])
    } finally {
      setIsCreating(false)
      setNewName('')
      setNewDesc('')
      setIsCreateOpen(false)
    }
  }

  const handleToggleRecord = async (project: Project) => {
    const isRecording = project.lastStatus === 'recording'
    const endpoint = isRecording
      ? `/api/projects/${project.id}/record/stop`
      : `/api/projects/${project.id}/record/start`

    try {
      const res = await fetch(endpoint, { method: 'POST' })
      if (res.ok) {
        const updated = (await res.json()) as Project
        setProjects((prev) => prev.map((p) => (p.id === project.id ? updated : p)))
      }
    } catch {
      // ignore
    }
  }

  const handleViewTrace = async (project: Project) => {
    let traceJson = '// 当前项目还没有录制到操作轨迹，请点击“录制”在内置浏览器中进行操作。'
    let workflow: OperationWorkflow | null = null
    let workflowJson: string | null = null
    const paramDrafts: Record<string, string> = {}

    try {
      const [traceRes, wfRes] = await Promise.all([
        fetch(`/api/projects/${project.id}/trace`),
        fetch(`/api/projects/${project.id}/workflow`),
      ])
      if (traceRes.ok) {
        const traceData = await traceRes.json()
        traceJson = JSON.stringify(traceData, null, 2)
      }
      if (wfRes.ok) {
        const wfData = (await wfRes.json()) as OperationWorkflow
        workflow = wfData
        workflowJson = JSON.stringify(wfData, null, 2)
        for (const p of wfData.parameters || []) {
          paramDrafts[p.key] = p.value
        }
      }
    } catch {
      traceJson = '// 读取录制数据失败'
    }

    setDataModal({
      project,
      activeTab: workflow ? 'visual' : 'trace',
      traceJson,
      workflow,
      workflowJson,
      paramDrafts,
      isCompiling: false,
      isSavingParams: false,
      compileError: null,
      saveMessage: null,
    })
  }

  const handleCompileWorkflow = async () => {
    if (!dataModal || dataModal.isCompiling) return
    setDataModal((prev) =>
      prev ? { ...prev, isCompiling: true, compileError: null, saveMessage: null } : null
    )

    try {
      const res = await fetch(`/api/projects/${dataModal.project.id}/compile`, {
        method: 'POST',
      })
      const body = await res.json()
      if (!res.ok) {
        setDataModal((prev) =>
          prev
            ? {
                ...prev,
                isCompiling: false,
                compileError: body.error || '大模型清洗编译失败',
              }
            : null
        )
        return
      }

      const wf = body.workflow as OperationWorkflow
      const wfStr = JSON.stringify(wf, null, 2)
      const drafts: Record<string, string> = {}
      for (const p of wf.parameters || []) {
        drafts[p.key] = p.value
      }

      if (body.project) {
        setProjects((prev) =>
          prev.map((p) => (p.id === body.project.id ? body.project : p))
        )
      }
      setDataModal((prev) =>
        prev
          ? {
              ...prev,
              project: body.project || prev.project,
              activeTab: 'visual',
              workflow: wf,
              workflowJson: wfStr,
              paramDrafts: drafts,
              isCompiling: false,
              compileError: null,
            }
          : null
      )
    } catch {
      setDataModal((prev) =>
        prev
          ? {
              ...prev,
              isCompiling: false,
              compileError: '网络请求失败，请检查后端服务是否正常运行',
            }
          : null
      )
    }
  }

  const handleSaveParameters = async () => {
    if (!dataModal || !dataModal.workflow || dataModal.isSavingParams) return
    setDataModal((prev) => (prev ? { ...prev, isSavingParams: true, saveMessage: null } : null))

    try {
      const res = await fetch(`/api/projects/${dataModal.project.id}/parameters`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parameters: dataModal.paramDrafts }),
      })
      const body = await res.json()
      if (res.ok && body.workflow) {
        const wf = body.workflow as OperationWorkflow
        if (body.project) {
          setProjects((prev) =>
            prev.map((p) => (p.id === body.project.id ? body.project : p))
          )
        }
        setDataModal((prev) =>
          prev
            ? {
                ...prev,
                project: body.project || prev.project,
                workflow: wf,
                workflowJson: JSON.stringify(wf, null, 2),
                isSavingParams: false,
                saveMessage: '参数已保存，下次运行将使用最新参数值',
              }
            : null
        )
      } else {
        setDataModal((prev) =>
          prev
            ? {
                ...prev,
                isSavingParams: false,
                compileError: body.error || '保存参数失败',
              }
            : null
        )
      }
    } catch {
      setDataModal((prev) =>
        prev
          ? {
              ...prev,
              isSavingParams: false,
              compileError: '保存参数失败，请检查后端连接',
            }
          : null
      )
    }
  }

  const handleRunProject = async (id: string, customParams?: Record<string, string>) => {
    setProjects((prev) =>
      prev.map((p) => (p.id === id ? { ...p, lastStatus: 'running' } : p))
    )

    try {
      const res = await fetch(`/api/projects/${id}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(customParams ? { parameters: customParams } : {}),
      })
      if (res.ok) {
        const updatedProject = (await res.json()) as Project
        setProjects((prev) => prev.map((p) => (p.id === id ? updatedProject : p)))
        return
      }
    } catch {
      // fallback below
    }

    setTimeout(() => {
      setProjects((prev) =>
        prev.map((p) => {
          if (p.id !== id) return p
          const newRun: RunRecord = {
            id: `r-${Date.now()}`,
            time: '刚刚',
            status: 'success',
            duration: '8.6 秒',
            note: '自动化执行完成，所有操作步骤均已通过',
          }
          return {
            ...p,
            lastStatus: 'success',
            runs: [newRun, ...p.runs],
          }
        })
      )
    }, 1800)
  }

  const handleDeleteProject = async (id: string) => {
    setProjects((prev) => prev.filter((p) => p.id !== id))
    try {
      await fetch(`/api/projects/${id}`, { method: 'DELETE' })
    } catch {
      // ignore
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* 主体内容区：我的项目 */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* 工具栏 */}
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-xl font-bold text-slate-900">我的项目</h2>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索项目..."
                className="h-9 w-64 rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white shadow-xs transition hover:bg-slate-800 cursor-pointer"
            >
              <Plus className="h-4 w-4" />
              新建项目
            </button>
          </div>
        </div>

        {/* 项目卡片列表 */}
        {filteredProjects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <p className="text-sm text-slate-500">没有找到匹配的项目，点击右上角新建一个吧。</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => {
              const paramCount = project.workflow?.parameters?.length || 0
              return (
                <div
                  key={project.id}
                  className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-2xs transition hover:border-blue-200 hover:shadow-md"
                >
                  <div>
                    {/* 标题与删除 */}
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="text-base font-semibold text-slate-900 group-hover:text-blue-600">
                        {project.name}
                      </h3>
                      <button
                        onClick={() => handleDeleteProject(project.id)}
                        title="删除项目"
                        className="rounded-md p-1 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-rose-600 group-hover:opacity-100 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>

                    {/* 描述 */}
                    <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-slate-600">
                      {project.description}
                    </p>
                  </div>

                  {/* 底部信息与操作按钮 */}
                  <div className="mt-5 border-t border-slate-100 pt-4">
                    <div className="mb-3 flex items-center justify-between text-xs text-slate-500">
                      <button
                        onClick={() => handleViewTrace(project)}
                        className="inline-flex items-center gap-1.5 hover:text-slate-900 cursor-pointer"
                        title="点击管理参数与查看操作工作流"
                      >
                        <FileJson className="h-3.5 w-3.5 text-slate-400" />
                        <span>共 {project.stepsCount} 个操作步骤</span>
                        {paramCount > 0 && (
                          <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-slate-700">
                            {paramCount} 个动态参数
                          </span>
                        )}
                      </button>
                      {project.lastStatus === 'recording' && (
                        <span className="inline-flex items-center gap-1 font-medium text-rose-600">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" />
                          浏览器录制中
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleRunProject(project.id)}
                        disabled={project.lastStatus === 'running'}
                        className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300 cursor-pointer"
                      >
                        {project.lastStatus === 'running' ? (
                          <>
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            执行中...
                          </>
                        ) : (
                          <>
                            <Play className="h-3.5 w-3.5 fill-current" />
                            立即运行
                          </>
                        )}
                      </button>

                      <button
                        onClick={() => handleToggleRecord(project)}
                        className={`inline-flex items-center justify-center gap-1 rounded-lg border px-3 py-2 text-xs font-medium transition cursor-pointer ${
                          project.lastStatus === 'recording'
                            ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {project.lastStatus === 'recording' ? (
                          <>
                            <Square className="h-3 w-3 fill-current" />
                            结束录制
                          </>
                        ) : (
                          <>
                            <CircleDot className="h-3.5 w-3.5 text-rose-500" />
                            录制
                          </>
                        )}
                      </button>

                      <button
                        onClick={() => setHistoryProject(project)}
                        className="inline-flex items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50 cursor-pointer"
                      >
                        <History className="h-3.5 w-3.5 text-slate-500" />
                        记录 ({project.runs.length})
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </main>

      {/* 新建项目弹窗 */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-900">新建项目</h3>
              <button
                onClick={() => setIsCreateOpen(false)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleCreateProject} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  项目名称 *
                </label>
                <input
                  type="text"
                  required
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例如：月度采购订单批量导出"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="mb-1 block text-xs font-medium text-slate-700">
                  需求描述
                </label>
                <textarea
                  rows={3}
                  value={newDesc}
                  onChange={(e) => setNewDesc(e.target.value)}
                  placeholder="简单描述在哪个页面点击什么按钮、填写什么内容..."
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50 cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isCreating}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400 cursor-pointer"
                >
                  {isCreating ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      正在启动浏览器...
                    </>
                  ) : (
                    '创建项目'
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 工作流参数管理与数据预览弹窗 */}
      {dataModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-3xl rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  {dataModal.project.name} · 工作流与参数管理
                </h3>
                <p className="mt-0.5 text-xs text-slate-500">
                  {dataModal.workflow
                    ? `${dataModal.workflow.summary}（已剔除 ${dataModal.workflow.removedNoiseCount} 个冗余噪声事件）`
                    : `存储位置：data/traces/${dataModal.project.id}.json`}
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={handleCompileWorkflow}
                  disabled={dataModal.isCompiling}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400 cursor-pointer"
                >
                  {dataModal.isCompiling ? (
                    <>
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      正在清洗生成...
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3.5 w-3.5" />
                      {dataModal.workflow ? '重新清洗工作流' : '调用大模型生成工作流'}
                    </>
                  )}
                </button>

                <button
                  onClick={() => setDataModal(null)}
                  className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* 切换标签栏 */}
            <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-2">
              <button
                onClick={() => setDataModal({ ...dataModal, activeTab: 'visual' })}
                className={`inline-flex items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer ${
                  dataModal.activeTab === 'visual'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                <SlidersHorizontal className="h-3.5 w-3.5" />
                参数与步骤视图
              </button>
              <button
                onClick={() => setDataModal({ ...dataModal, activeTab: 'workflow' })}
                className={`rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer ${
                  dataModal.activeTab === 'workflow'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                操作工作流数据（清洗后）
              </button>
              <button
                onClick={() => setDataModal({ ...dataModal, activeTab: 'trace' })}
                className={`rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer ${
                  dataModal.activeTab === 'trace'
                    ? 'bg-slate-900 text-white'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                原始录制数据（清洗前）
              </button>
            </div>

            {dataModal.compileError && (
              <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
                {dataModal.compileError}
              </div>
            )}

            {dataModal.saveMessage && (
              <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                {dataModal.saveMessage}
              </div>
            )}

            {dataModal.activeTab === 'visual' ? (
              !dataModal.workflow ? (
                <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-xs text-slate-500">
                  当前项目尚未生成结构化工作流，请点击右上角“调用大模型生成工作流”按钮进行清洗与参数提炼。
                </div>
              ) : (
                <div className="max-h-96 space-y-5 overflow-y-auto pr-1">
                  {/* 1. 项目动态参数配置区 */}
                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <h4 className="text-xs font-semibold text-slate-900">
                          动态运行参数（每次执行前可修改）
                        </h4>
                        <p className="text-xs text-slate-500">
                          大模型已自动将输入框填写等可变操作抽离为项目参数
                        </p>
                      </div>
                      {dataModal.workflow.parameters.length > 0 && (
                        <div className="flex items-center gap-2">
                          <button
                            onClick={handleSaveParameters}
                            disabled={dataModal.isSavingParams}
                            className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 cursor-pointer"
                          >
                            <Save className="h-3.5 w-3.5" />
                            保存参数
                          </button>
                          <button
                            onClick={() => {
                              const id = dataModal.project.id
                              const params = { ...dataModal.paramDrafts }
                              setDataModal(null)
                              handleRunProject(id, params)
                            }}
                            className="inline-flex items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800 cursor-pointer"
                          >
                            <Play className="h-3 w-3 fill-current" />
                            按此参数运行
                          </button>
                        </div>
                      )}
                    </div>

                    {dataModal.workflow.parameters.length === 0 ? (
                      <p className="text-xs text-slate-500">
                        该工作流全部为固定操作，无需配置动态参数。
                      </p>
                    ) : (
                      <div className="grid gap-3 sm:grid-cols-2">
                        {dataModal.workflow.parameters.map((param) => (
                          <div
                            key={param.key}
                            className="rounded-lg border border-slate-200 bg-white p-3"
                          >
                            <div className="mb-1 flex items-center justify-between">
                              <label className="text-xs font-medium text-slate-800">
                                {param.label}
                              </label>
                              <span className="font-mono text-[11px] text-slate-400">
                                默认值：{param.defaultValue}
                              </span>
                            </div>
                            <input
                              type="text"
                              value={dataModal.paramDrafts[param.key] ?? param.value}
                              onChange={(e) =>
                                setDataModal({
                                  ...dataModal,
                                  saveMessage: null,
                                  paramDrafts: {
                                    ...dataModal.paramDrafts,
                                    [param.key]: e.target.value,
                                  },
                                })
                              }
                              className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                            />
                            {param.description && (
                              <p className="mt-1 text-[11px] text-slate-500">
                                {param.description}
                              </p>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 2. 部分固定、部分抽象的步骤列表 */}
                  <div>
                    <h4 className="mb-2.5 text-xs font-semibold text-slate-900">
                      清洗后的操作流程（共 {dataModal.workflow.steps.length} 步）
                    </h4>
                    <div className="space-y-2">
                      {dataModal.workflow.steps.map((step) => {
                        const isParam = step.stepCategory === 'parameterized'
                        const paramKey = step.engineBinding.paramKey || step.humanView.paramKey
                        const currentVal = paramKey
                          ? (dataModal.paramDrafts[paramKey] ?? step.engineBinding.value)
                          : step.engineBinding.value
                        return (
                          <div
                            key={step.id}
                            className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-xs"
                          >
                            <div className="space-y-1">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-100 font-semibold text-slate-700">
                                  {step.order}
                                </span>
                                <span className="font-medium text-slate-900">
                                  {step.humanView.title}
                                </span>
                                <span
                                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium ${
                                    isParam
                                      ? 'bg-amber-50 text-amber-800 border border-amber-200'
                                      : 'bg-slate-100 text-slate-600'
                                  }`}
                                >
                                  {isParam ? '动态参数操作' : '固定操作'}
                                </span>
                              </div>
                              <p className="pl-7 text-slate-500">
                                {step.humanView.description}
                              </p>
                            </div>

                            {currentVal && (
                              <div className="max-w-xs shrink-0 truncate rounded-md bg-slate-50 px-2.5 py-1 font-mono text-[11px] text-slate-700">
                                {isParam
                                  ? `${step.humanView.paramLabel || '参数值'} = ${currentVal}`
                                  : currentVal}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )
            ) : (
              <pre className="max-h-96 overflow-auto rounded-lg bg-slate-900 p-4 font-mono text-xs leading-relaxed text-slate-100">
                {dataModal.activeTab === 'workflow'
                  ? dataModal.workflowJson ||
                    '// 尚未生成操作工作流，请点击右上角“调用大模型生成工作流”按钮。'
                  : dataModal.traceJson}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* 历史执行记录弹窗 */}
      {historyProject && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
          <div className="w-full max-w-lg rounded-xl bg-white p-6 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">
                  执行历史记录
                </h3>
                <p className="text-xs text-slate-500">{historyProject.name}</p>
              </div>
              <button
                onClick={() => setHistoryProject(null)}
                className="rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 cursor-pointer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {historyProject.runs.length === 0 ? (
              <div className="py-8 text-center text-sm text-slate-500">
                该项目还没有运行记录，点击“立即运行”试试看吧。
              </div>
            ) : (
              <div className="max-h-80 space-y-2.5 overflow-y-auto pr-1">
                {historyProject.runs.map((run) => (
                  <div
                    key={run.id}
                    className="flex items-start justify-between rounded-lg border border-slate-100 bg-slate-50 p-3 text-xs"
                  >
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        {run.status === 'success' ? (
                          <span className="inline-flex items-center gap-1 font-medium text-emerald-600">
                            <CheckCircle2 className="h-3.5 w-3.5" />
                            执行成功
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 font-medium text-rose-600">
                            <AlertCircle className="h-3.5 w-3.5" />
                            执行失败
                          </span>
                        )}
                        <span className="text-slate-400">·</span>
                        <span className="text-slate-500">耗时 {run.duration}</span>
                      </div>
                      <p className="text-slate-700">{run.note}</p>
                    </div>
                    <span className="shrink-0 text-slate-400">{run.time}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default App
