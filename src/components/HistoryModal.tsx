import { AlertCircle, CheckCircle2, X } from 'lucide-react'
import type { Project, RunRecord } from '../../shared/types.ts'
import { Modal } from './Modal.tsx'

interface HistoryModalProps {
  project: Project
  onClose: () => void
}

function summarizeLogs(logs: NonNullable<RunRecord['logs']>): string {
  const verified = logs.filter((log) => log.verification === 'verified').length
  const soft = logs.filter((log) => log.verification === 'soft').length
  const failed = logs.filter((log) => log.verification === 'failed').length
  const l2 = logs.filter((log) => log.tier === 'L2').length
  const l3 = logs.filter((log) => log.tier === 'L3').length
  const slowest = logs.reduce((max, log) => Math.max(max, log.durationMs), 0)
  return `共 ${logs.length} 步 · 校验通过 ${verified} · 软信号 ${soft} · 失败 ${failed} · L2 ${l2} · L3 视觉 ${l3} · 最慢 ${slowest}ms`
}

export function HistoryModal({ project, onClose }: HistoryModalProps) {
  return (
    <Modal label="执行历史记录" maxWidth="max-w-lg">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h3 className="text-base font-semibold text-slate-900">执行历史记录</h3>
          <p className="text-xs text-slate-500">{project.name}</p>
        </div>
        <button
          aria-label="关闭"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {project.runs.length === 0 ? (
        <div className="py-8 text-center text-sm text-slate-500">
          该任务还没有运行记录，点击“立即运行”试试看吧。
        </div>
      ) : (
        <div className="max-h-80 space-y-2.5 overflow-y-auto pr-1">
          {project.runs.map((run) => (
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
                {run.logs && run.logs.length > 0 && (
                  <p className="text-[11px] text-slate-500">
                    执行遥测：{summarizeLogs(run.logs)}
                  </p>
                )}
                {run.logs?.some((log) => log.failureScreenshot) && (
                  <p className="text-[11px] text-rose-500">
                    失败现场截图：
                    {run.logs.find((log) => log.failureScreenshot)?.failureScreenshot}
                  </p>
                )}
              </div>
              <span className="shrink-0 text-slate-400">{run.time}</span>
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}
