import { useMemo, useState } from 'react'
import { Plus, Search } from 'lucide-react'
import type { Project } from '../shared/types.ts'
import { useProjects } from './hooks/useProjects.ts'
import { CreateTaskModal } from './components/CreateTaskModal.tsx'
import { ErrorToast } from './components/ErrorToast.tsx'
import { HistoryModal } from './components/HistoryModal.tsx'
import { TaskCard } from './components/TaskCard.tsx'
import { WorkflowModal } from './components/WorkflowModal.tsx'

export function App() {
  const {
    projects,
    runProgress,
    error,
    dismissError,
    createProject,
    removeProject,
    toggleRecording,
    runProject,
    applyProject,
  } = useProjects()

  const [searchQuery, setSearchQuery] = useState('')
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [workflowProject, setWorkflowProject] = useState<Project | null>(null)
  const [historyProject, setHistoryProject] = useState<Project | null>(null)

  const filteredProjects = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return projects
    return projects.filter(
      (project) =>
        project.name.toLowerCase().includes(query) ||
        project.description.toLowerCase().includes(query)
    )
  }, [projects, searchQuery])

  const handleCreateProject = async (name: string, description: string) => {
    await createProject(name, description)
    setIsCreateOpen(false)
  }

  const handleRunFromModal = (id: string, parameters: Record<string, string>) => {
    void runProject(id, parameters)
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* 主体内容区：我的任务 */}
      <main className="mx-auto max-w-6xl px-6 py-8">
        {/* 工具栏 */}
        <div className="mb-6 flex items-center justify-between gap-4">
          <h2 className="text-xl font-bold text-slate-900">我的任务</h2>

          <div className="flex items-center gap-3">
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索任务..."
                className="h-9 w-64 rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm text-slate-800 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none"
              />
            </div>

            <button
              onClick={() => setIsCreateOpen(true)}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-lg bg-slate-900 px-3.5 text-sm font-medium text-white shadow-xs transition hover:bg-slate-800"
            >
              <Plus className="h-4 w-4" />
              新建任务
            </button>
          </div>
        </div>

        {/* 任务卡片列表 */}
        {filteredProjects.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center">
            <p className="text-sm text-slate-500">没有找到匹配的任务，点击右上角新建一个吧。</p>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {filteredProjects.map((project) => (
              <TaskCard
                key={project.id}
                project={project}
                paramCount={project.workflow?.parameters?.length ?? 0}
                progress={runProgress[project.id]}
                onOpenWorkflow={setWorkflowProject}
                onRun={(id) => void runProject(id)}
                onToggleRecord={(target) => void toggleRecording(target)}
                onOpenHistory={setHistoryProject}
                onDelete={(id) => void removeProject(id)}
              />
            ))}
          </div>
        )}
      </main>

      {/* 新建任务弹窗 */}
      {isCreateOpen && (
        <CreateTaskModal
          onClose={() => setIsCreateOpen(false)}
          onSubmit={handleCreateProject}
        />
      )}

      {/* 工作流参数管理与数据预览弹窗 */}
      {workflowProject && (
        <WorkflowModal
          project={workflowProject}
          onClose={() => setWorkflowProject(null)}
          onProjectUpdated={applyProject}
          onRun={handleRunFromModal}
        />
      )}

      {/* 历史执行记录弹窗 */}
      {historyProject && (
        <HistoryModal project={historyProject} onClose={() => setHistoryProject(null)} />
      )}

      {/* 全局错误提示 */}
      {error && <ErrorToast message={error} onClose={dismissError} />}
    </div>
  )
}

export default App
