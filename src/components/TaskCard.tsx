import {
  CircleDot,
  FileJson,
  History,
  Loader2,
  Play,
  Square,
  Trash2,
} from 'lucide-react'
import type { Project } from '../../shared/types.ts'
import type { RunProgress } from '../hooks/useProjects.ts'

interface TaskCardProps {
  project: Project
  paramCount: number
  progress?: RunProgress
  onOpenWorkflow: (project: Project) => void
  onRun: (id: string) => void
  onToggleRecord: (project: Project) => void
  onOpenHistory: (project: Project) => void
  onDelete: (id: string) => void
}

export function TaskCard({
  project,
  paramCount,
  progress,
  onOpenWorkflow,
  onRun,
  onToggleRecord,
  onOpenHistory,
  onDelete,
}: TaskCardProps) {
  const isRecording = project.lastStatus === 'recording'
  const isRunning = project.lastStatus === 'running' || progress?.status === 'running'
  const percent =
    progress && progress.totalSteps > 0
      ? Math.min(100, Math.round((progress.stepIndex / progress.totalSteps) * 100))
      : 0

  return (
    <div className="group flex flex-col justify-between rounded-xl border border-slate-200 bg-white p-5 shadow-2xs transition hover:border-blue-200 hover:shadow-md">
      <div>
        {/* 标题与删除 */}
        <div className="flex items-start justify-between gap-2">
          <h3 className="text-base font-semibold text-slate-900 group-hover:text-blue-600">
            {project.name}
          </h3>
          <button
            onClick={() => onDelete(project.id)}
            title="删除任务"
            className="cursor-pointer rounded-md p-1 text-slate-400 opacity-0 transition hover:bg-slate-100 hover:text-rose-600 group-hover:opacity-100"
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
            onClick={() => onOpenWorkflow(project)}
            className="inline-flex cursor-pointer items-center gap-1.5 hover:text-slate-900"
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
          {isRecording && (
            <span className="inline-flex items-center gap-1 font-medium text-rose-600">
              <span className="h-2 w-2 animate-pulse rounded-full bg-rose-600" />
              浏览器录制中
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => onRun(project.id)}
            disabled={Boolean(isRunning)}
            className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-slate-900 px-3 py-2 text-xs font-medium text-white transition hover:bg-blue-600 disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            {isRunning ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                执行中{progress && progress.stepIndex > 0 ? ` ${progress.stepIndex}/${progress.totalSteps}` : '...'}
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5 fill-current" />
                立即运行
              </>
            )}
          </button>

          <button
            onClick={() => onToggleRecord(project)}
            className={`inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
              isRecording
                ? 'border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100'
                : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
            }`}
          >
            {isRecording ? (
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
            onClick={() => onOpenHistory(project)}
            className="inline-flex cursor-pointer items-center justify-center gap-1 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
          >
            <History className="h-3.5 w-3.5 text-slate-500" />
            记录 ({project.runs.length})
          </button>
        </div>

        {/* 运行进度条（异步任务，由 WS 实时推送） */}
        {isRunning && progress && (
          <div className="mt-2.5">
            <div className="mb-1 flex items-center justify-between gap-2 text-[11px] text-slate-500">
              <span className="truncate">
                {progress.stepIndex === 0
                  ? '正在启动浏览器...'
                  : `第 ${progress.stepIndex}/${progress.totalSteps} 步${
                      progress.title ? ` · ${progress.title}` : ''
                    }`}
              </span>
              <span className="shrink-0 tabular-nums">{percent}%</span>
            </div>
            <div className="h-1 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
