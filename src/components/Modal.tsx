import type { ReactNode } from 'react'

interface ModalProps {
  children: ReactNode
  /** 弹窗容器最大宽度 class，例如 max-w-md / max-w-3xl */
  maxWidth?: string
  label: string
}

/** 统一的遮罩 + 白色卡片弹窗外壳（三个业务弹窗共用） */
export function Modal({ children, maxWidth = 'max-w-md', label }: ModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-xs">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className={`w-full ${maxWidth} rounded-xl bg-white p-6 shadow-xl`}
      >
        {children}
      </div>
    </div>
  )
}
