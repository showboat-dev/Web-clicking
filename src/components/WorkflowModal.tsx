import { useEffect, useState } from 'react'
import { Loader2, Play, Save, SlidersHorizontal, Sparkles, X } from 'lucide-react'
import type { OperationWorkflow, Project } from '../../shared/types.ts'
import * as api from '../api/client.ts'
import { Modal } from './Modal.tsx'

type TabKey = 'visual' | 'workflow' | 'trace'

interface WorkflowModalProps {
  project: Project
  onClose: () => void
  onProjectUpdated: (project: Project) => void
  onRun: (projectId: string, parameters: Record<string, string>) => void
}

const EMPTY_TRACE_HINT = '// 当前任务还没有录制到操作轨迹，请点击“录制”在内置浏览器中进行操作。'

function paramDraftsOf(workflow: OperationWorkflow | null): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (const param of workflow?.parameters ?? []) {
    drafts[param.key] = param.value
  }
  return drafts
}

export function WorkflowModal({
  project,
  onClose,
  onProjectUpdated,
  onRun,
}: WorkflowModalProps) {
  const [activeTab, setActiveTab] = useState<TabKey>('trace')
  const [isLoading, setIsLoading] = useState(true)
  const [traceJson, setTraceJson] = useState(`// 正在读取 ${project.name} 的录制数据...`)
  const [workflow, setWorkflow] = useState<OperationWorkflow | null>(null)
  const [workflowJson, setWorkflowJson] = useState<string | null>(null)
  const [paramDrafts, setParamDrafts] = useState<Record<string, string>>({})
  const [isCompiling, setIsCompiling] = useState(false)
  const [isSavingParams, setIsSavingParams] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saveMessage, setSaveMessage] = useState<string | null>(null)

  // 打开弹窗时并行读取「原始轨迹」与「清洗后工作流」
  useEffect(() => {
    let cancelled = false

    const load = async () => {
      const [traceResult, workflowResult] = await Promise.allSettled([
        api.fetchTrace(project.id),
        api.fetchWorkflow(project.id),
      ])
      if (cancelled) return

      if (traceResult.status === 'fulfilled') {
        setTraceJson(JSON.stringify(traceResult.value, null, 2))
      } else {
        setTraceJson(EMPTY_TRACE_HINT)
      }

      if (workflowResult.status === 'fulfilled') {
        const loaded = workflowResult.value
        setWorkflow(loaded)
        setWorkflowJson(JSON.stringify(loaded, null, 2))
        setParamDrafts(paramDraftsOf(loaded))
        setActiveTab('visual')
      } else {
        setActiveTab('trace')
      }
      setIsLoading(false)
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [project.id])

  const handleCompile = async () => {
    if (isCompiling) return
    setIsCompiling(true)
    setError(null)
    setSaveMessage(null)
    try {
      const result = await api.compileWorkflow(project.id)
      setWorkflow(result.workflow)
      setWorkflowJson(JSON.stringify(result.workflow, null, 2))
      setParamDrafts(paramDraftsOf(result.workflow))
      setActiveTab('visual')
      onProjectUpdated(result.project)
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '大模型清洗编译失败')
    } finally {
      setIsCompiling(false)
    }
  }

  const handleSaveParameters = async () => {
    if (!workflow || isSavingParams) return
    setIsSavingParams(true)
    setError(null)
    setSaveMessage(null)
    try {
      const result = await api.saveParameters(project.id, paramDrafts)
      setWorkflow(result.workflow)
      setWorkflowJson(JSON.stringify(result.workflow, null, 2))
      setParamDrafts(paramDraftsOf(result.workflow))
      onProjectUpdated(result.project)
      setSaveMessage('参数已保存，下次运行将使用最新参数值')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '保存参数失败')
    } finally {
      setIsSavingParams(false)
    }
  }

  const handleRunWithParams = () => {
    onRun(project.id, { ...paramDrafts })
    onClose()
  }

  return (
    <Modal label="工作流与参数管理" maxWidth="max-w-3xl">
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold text-slate-900">
            {project.name} · 工作流与参数管理
          </h3>
          <p className="mt-0.5 text-xs text-slate-500">
            {workflow
              ? `${workflow.summary}（已剔除 ${workflow.removedNoiseCount} 个冗余噪声事件）`
              : `存储位置：data/traces/${project.id}.json`}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleCompile}
            disabled={isCompiling || isLoading}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-slate-800 disabled:bg-slate-400"
          >
            {isCompiling ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在清洗生成...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5" />
                {workflow ? '重新清洗工作流' : '调用大模型生成工作流'}
              </>
            )}
          </button>

          <button
            aria-label="关闭"
            onClick={onClose}
            className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 切换标签栏 */}
      <div className="mb-4 flex items-center gap-2 border-b border-slate-200 pb-2">
        <button
          onClick={() => setActiveTab('visual')}
          className={`inline-flex cursor-pointer items-center gap-1 rounded-md px-3 py-1 text-xs font-medium transition ${
            activeTab === 'visual' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          参数与步骤视图
        </button>
        <button
          onClick={() => setActiveTab('workflow')}
          className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition ${
            activeTab === 'workflow'
              ? 'bg-slate-900 text-white'
              : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          操作工作流数据（清洗后）
        </button>
        <button
          onClick={() => setActiveTab('trace')}
          className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition ${
            activeTab === 'trace' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'
          }`}
        >
          原始录制数据（清洗前）
        </button>
      </div>

      {error && (
        <div className="mb-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {error}
        </div>
      )}

      {saveMessage && (
        <div className="mb-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
          {saveMessage}
        </div>
      )}

      {workflow?.coverage && workflow.coverage.warnings.length > 0 && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          翻译覆盖审计：{workflow.coverage.warnings.join('；')}
        </div>
      )}

      {isLoading ? (
        <div className="py-12 text-center text-xs text-slate-500">正在读取录制数据...</div>
      ) : activeTab === 'visual' ? (
        !workflow ? (
          <div className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-10 text-center text-xs text-slate-500">
            当前任务尚未生成结构化工作流，请点击右上角“调用大模型生成工作流”按钮进行清洗与参数提炼。
          </div>
        ) : (
          <div className="max-h-96 space-y-5 overflow-y-auto pr-1">
            {/* 1. 任务动态参数配置区 */}
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="mb-3 flex items-center justify-between">
                <div>
                  <h4 className="text-xs font-semibold text-slate-900">
                    动态运行参数（每次执行前可修改）
                  </h4>
                  <p className="text-xs text-slate-500">
                    大模型已自动将输入框填写等可变操作抽离为任务参数
                  </p>
                </div>
                {workflow.parameters.length > 0 && (
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleSaveParameters}
                      disabled={isSavingParams}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 disabled:opacity-60"
                    >
                      {isSavingParams ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Save className="h-3.5 w-3.5" />
                      )}
                      保存参数
                    </button>
                    <button
                      onClick={handleRunWithParams}
                      className="inline-flex cursor-pointer items-center gap-1 rounded-lg bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-slate-800"
                    >
                      <Play className="h-3 w-3 fill-current" />
                      按此参数运行
                    </button>
                  </div>
                )}
              </div>

              {workflow.parameters.length === 0 ? (
                <p className="text-xs text-slate-500">该工作流全部为固定操作，无需配置动态参数。</p>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2">
                  {workflow.parameters.map((param) => (
                    <div
                      key={param.key}
                      className="rounded-lg border border-slate-200 bg-white p-3"
                    >
                      <div className="mb-1 flex items-center justify-between">
                        <label className="text-xs font-medium text-slate-800">{param.label}</label>
                        <span className="font-mono text-[11px] text-slate-400">
                          默认值：{param.defaultValue}
                        </span>
                      </div>
                      <input
                        type="text"
                        value={paramDrafts[param.key] ?? param.value}
                        onChange={(e) => {
                          setSaveMessage(null)
                          setParamDrafts((prev) => ({ ...prev, [param.key]: e.target.value }))
                        }}
                        className="w-full rounded-md border border-slate-200 px-2.5 py-1.5 text-xs text-slate-900 focus:border-slate-900 focus:outline-none"
                      />
                      {param.description && (
                        <p className="mt-1 text-[11px] text-slate-500">{param.description}</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 2. 部分固定、部分抽象的步骤列表 */}
            <div>
              <h4 className="mb-2.5 text-xs font-semibold text-slate-900">
                清洗后的操作流程（共 {workflow.steps.length} 步）
              </h4>
              <div className="space-y-2">
                {workflow.steps.map((step) => {
                  const isParam = step.stepCategory === 'parameterized'
                  const paramKey = step.engineBinding.paramKey || step.humanView.paramKey
                  const currentVal = paramKey
                    ? (paramDrafts[paramKey] ?? step.engineBinding.value)
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
                                ? 'border border-amber-200 bg-amber-50 text-amber-800'
                                : 'bg-slate-100 text-slate-600'
                            }`}
                          >
                            {isParam ? '动态参数操作' : '固定操作'}
                          </span>
                        </div>
                        <p className="pl-7 text-slate-500">{step.humanView.description}</p>
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
          {activeTab === 'workflow'
            ? workflowJson ||
              '// 尚未生成操作工作流，请点击右上角“调用大模型生成工作流”按钮。'
            : traceJson}
        </pre>
      )}
    </Modal>
  )
}
