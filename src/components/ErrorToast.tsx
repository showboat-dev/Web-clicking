import { AlertCircle, X } from 'lucide-react'

interface ErrorToastProps {
  message: string
  onClose: () => void
}

/** 右下角轻量错误提示（运行失败、接口报错等） */
export function ErrorToast({ message, onClose }: ErrorToastProps) {
  return (
    <div className="fixed bottom-6 right-6 z-[60] flex max-w-sm items-start gap-2 rounded-lg border border-rose-200 bg-white px-4 py-3 text-xs text-rose-700 shadow-lg">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-500" />
      <p className="flex-1 leading-relaxed">{message}</p>
      <button
        aria-label="关闭提示"
        onClick={onClose}
        className="cursor-pointer rounded p-0.5 text-rose-300 hover:bg-rose-50 hover:text-rose-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
