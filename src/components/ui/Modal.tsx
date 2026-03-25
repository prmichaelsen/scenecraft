import { useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { X, AlertTriangle, AlertCircle, Info } from 'lucide-react'

interface ModalProps {
  isOpen: boolean
  onClose: () => void
  children: React.ReactNode
  title?: string
  style?: React.CSSProperties
  maxWidth?: 'sm' | 'md' | 'lg' | 'xl' | '2xl'
  persistent?: boolean
  isLoading?: boolean
}

const MAX_WIDTH_CLASSES: Record<string, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
  '2xl': 'max-w-2xl',
}

export function Modal({
  isOpen,
  onClose,
  children,
  title,
  style,
  maxWidth = 'md',
  persistent = false,
  isLoading = false,
}: ModalProps) {
  const canDismiss = !persistent && !isLoading

  const handleEscape = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Escape' && canDismiss) {
        onClose()
      }
    },
    [canDismiss, onClose]
  )

  useEffect(() => {
    if (!isOpen) return
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [isOpen, handleEscape])

  // Body scroll lock
  useEffect(() => {
    if (!isOpen) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [isOpen])

  if (!isOpen) return null
  if (typeof document === 'undefined') return null

  function handleBackdropClick(e: React.MouseEvent) {
    if (e.target === e.currentTarget && canDismiss) {
      onClose()
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
      onClick={handleBackdropClick}
    >
      <div
        className={`relative w-full ${MAX_WIDTH_CLASSES[maxWidth]} bg-bg-page border border-border-default rounded-2xl shadow-xl max-h-[90vh] overflow-auto`}
        style={{ paddingBottom: 'env(safe-area-inset-bottom)', ...style }}
      >
        {/* Close button */}
        {canDismiss && (
          <button
            type="button"
            onClick={onClose}
            className="absolute top-3 right-3 p-1 text-text-muted hover:text-text-primary transition-colors rounded-lg hover:bg-bg-elevated"
            aria-label="Close"
          >
            <X className="w-5 h-5" />
          </button>
        )}

        {/* Title */}
        {title && (
          <div className="px-6 pt-5 pb-0">
            <h2 className="text-lg font-semibold text-text-primary pr-8">
              {title}
            </h2>
          </div>
        )}

        {/* Content */}
        <div className="p-6">{children}</div>
      </div>
    </div>,
    document.body
  )
}

/* ──────────────────────────────────────────────────────────────── */

interface ConfirmationModalProps {
  isOpen: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  message: string | React.ReactNode
  confirmText?: string
  cancelText?: string
  variant?: 'danger' | 'warning' | 'info'
  isLoading?: boolean
}

const VARIANT_CONFIG = {
  danger: {
    icon: AlertTriangle,
    bgClass: 'bg-danger',
    buttonClass: 'bg-danger hover:bg-danger/80 text-white',
  },
  warning: {
    icon: AlertCircle,
    bgClass: 'bg-emphasis',
    buttonClass: 'bg-emphasis hover:bg-emphasis/80 text-white',
  },
  info: {
    icon: Info,
    bgClass: 'bg-accent',
    buttonClass: 'bg-accent hover:bg-accent/80 text-white',
  },
} as const

export function ConfirmationModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  variant = 'danger',
  isLoading = false,
}: ConfirmationModalProps) {
  const config = VARIANT_CONFIG[variant]
  const Icon = config.icon

  return (
    <Modal
      isOpen={isOpen}
      onClose={isLoading ? () => {} : onClose}
      maxWidth="sm"
      isLoading={isLoading}
    >
      <div className="flex flex-col items-center text-center">
        {/* Icon */}
        <div
          className={`w-12 h-12 rounded-full ${config.bgClass} flex items-center justify-center mb-4`}
        >
          <Icon className="w-6 h-6 text-white" />
        </div>

        {/* Title */}
        <h3 className="text-lg font-semibold text-text-primary mb-2">
          {title}
        </h3>

        {/* Message */}
        <div className="text-sm text-text-secondary mb-6">{message}</div>

        {/* Buttons */}
        <div className="flex gap-3 w-full">
          <button
            type="button"
            onClick={onClose}
            disabled={isLoading}
            className="flex-1 px-4 py-2 rounded-lg border border-border-default text-text-secondary hover:bg-bg-elevated transition-colors disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={isLoading}
            className={`flex-1 px-4 py-2 rounded-lg transition-colors disabled:opacity-50 ${config.buttonClass}`}
          >
            {isLoading ? 'Loading...' : confirmText}
          </button>
        </div>
      </div>
    </Modal>
  )
}
