import { useCallback, useRef } from 'react'

type ResizeSashProps = {
  direction: 'horizontal' | 'vertical'
  onDrag: (deltaPx: number) => void
}

export function ResizeSash({ direction, onDrag }: ResizeSashProps) {
  const dragging = useRef(false)
  const lastPos = useRef(0)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const pos = direction === 'horizontal' ? ev.clientX : ev.clientY
      const delta = pos - lastPos.current
      lastPos.current = pos
      if (delta !== 0) onDrag(delta)
    }

    const handleMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
  }, [direction, onDrag])

  return (
    <div
      onMouseDown={handleMouseDown}
      className="shrink-0 hover:bg-blue-500/50 active:bg-blue-500 bg-transparent transition-colors z-10"
      style={{
        width: direction === 'horizontal' ? 4 : '100%',
        height: direction === 'vertical' ? 4 : '100%',
        cursor: direction === 'horizontal' ? 'col-resize' : 'row-resize',
      }}
    />
  )
}
