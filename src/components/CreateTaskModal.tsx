import { useState, type FormEvent } from 'react'
import { Loader2, X } from 'lucide-react'
import { Modal } from './Modal.tsx'

interface CreateTaskModalProps {
  onClose: () => void
  /** 成功创建后由父组件负责关闭弹窗；抛错则在本弹窗内展示 */
  onSubmit: (name: string, description: string) => Promise<void>
}

export function CreateTaskModal({ onClose, onSubmit }: CreateTaskModalProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [isCreating, setIsCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim() || isCreating) return

    setIsCreating(true)
    setError(null)
    try {
      await onSubmit(name.trim(), description.trim())
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : '创建任务失败')
      setIsCreating(false)
    }
  }

  return (
    <Modal label="新建任务">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-slate-900">新建任务</h3>
        <button
          aria-label="关闭"
          onClick={onClose}
          className="cursor-pointer rounded-lg p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">任务名称 *</label>
          <input
            type="text"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：月度采购订单批量导出"
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        <div>
          <label className="mb-1 block text-xs font-medium text-slate-700">需求描述</label>
          <textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="简单描述在哪个页面点击什么按钮、填写什么内容..."
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
          />
        </div>

        {error && (
          <div className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-slate-200 px-4 py-2 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            取消
          </button>
          <button
            type="submit"
            disabled={isCreating}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-slate-900 px-4 py-2 text-xs font-medium text-white hover:bg-slate-800 disabled:bg-slate-400"
          >
            {isCreating ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                正在启动浏览器...
              </>
            ) : (
              '创建任务'
            )}
          </button>
        </div>
      </form>
    </Modal>
  )
}
