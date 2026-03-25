import { useEffect, useState, type ReactNode } from 'react'

interface SlideOverPanelProps {
  open: boolean
  onClose: () => void
  children: ReactNode
}

export function SlideOverPanel({ open, onClose, children }: SlideOverPanelProps) {
  const [mounted, setMounted] = useState(false)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    if (open) {
      setMounted(true)
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setVisible(true))
      })
    } else {
      setVisible(false)
      const timer = setTimeout(() => setMounted(false), 200)
      return () => clearTimeout(timer)
    }
  }, [open])

  if (!mounted) return null

  return (
    <>
      <div
        className={`fixed top-14 inset-x-0 bottom-0 bg-black/30 z-[51] transition-opacity duration-200 ${
          visible ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />
      <div
        className={`fixed top-14 right-0 bottom-0 w-72 bg-bg-card border-l border-border-default overflow-y-auto z-[52] shadow-lg transition-transform duration-200 ${
          visible ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        {children}
      </div>
    </>
  )
}
