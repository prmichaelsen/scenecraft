import { useRef, useCallback } from 'react'
import { ResizeSash } from './ResizeSash'

type SplitContainerProps = {
  direction: 'horizontal' | 'vertical'
  ratio: number
  onRatioChange: (ratio: number) => void
  children: [React.ReactNode, React.ReactNode]
  firstCollapsed?: boolean
  secondCollapsed?: boolean
}

const MIN_RATIO = 0.05
const MAX_RATIO = 0.95
const MIN_PX = 100
const COLLAPSED_PX = 34

export function SplitContainer({
  direction, ratio, onRatioChange, children,
  firstCollapsed, secondCollapsed,
}: SplitContainerProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isHorizontal = direction === 'horizontal'
  const ratioRef = useRef(ratio)
  ratioRef.current = ratio

  const handleDrag = useCallback((deltaPx: number) => {
    const container = containerRef.current
    if (!container) return
    const totalSize = isHorizontal ? container.clientWidth : container.clientHeight
    if (totalSize === 0) return
    const deltaRatio = deltaPx / totalSize
    const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratioRef.current + deltaRatio))
    onRatioChange(clamped)
  }, [onRatioChange, isHorizontal])

  const anyCollapsed = firstCollapsed || secondCollapsed

  const firstStyle: React.CSSProperties = firstCollapsed
    ? { flex: `0 0 ${COLLAPSED_PX}px`, minWidth: 0, minHeight: 0, overflow: 'hidden' }
    : {
        flex: secondCollapsed ? 1 : `0 0 ${ratio * 100}%`,
        minWidth: isHorizontal ? MIN_PX : undefined,
        minHeight: isHorizontal ? undefined : MIN_PX,
        overflow: 'hidden',
      }

  const secondStyle: React.CSSProperties = secondCollapsed
    ? { flex: `0 0 ${COLLAPSED_PX}px`, minWidth: 0, minHeight: 0, overflow: 'hidden' }
    : {
        flex: 1,
        minWidth: isHorizontal ? MIN_PX : undefined,
        minHeight: isHorizontal ? undefined : MIN_PX,
        overflow: 'hidden',
      }

  return (
    <div
      ref={containerRef}
      className="flex h-full w-full"
      style={{ flexDirection: isHorizontal ? 'row' : 'column' }}
    >
      <div style={firstStyle}>{children[0]}</div>
      {!anyCollapsed && <ResizeSash direction={direction} onDrag={handleDrag} />}
      <div style={secondStyle}>{children[1]}</div>
    </div>
  )
}
