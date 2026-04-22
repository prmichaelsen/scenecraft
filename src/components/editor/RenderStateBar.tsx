/**
 * NLE-style colored strip above the timeline playhead ruler showing
 * per-bucket preview render state:
 *
 *   dark red       - unrendered
 *   bright red     - currently rendering
 *   blue           - cached, ready to play
 *   dark red stripe - stale (edit invalidated this range)
 *
 * Data source: `useRenderState(projectName)` which polls
 * `GET /api/projects/:name/render-state` every 2s. Switches to a WS
 * subscription once task-37 (unified WS) lands.
 *
 * Virtualization: the bar can span thousands of buckets on long
 * projects. Only buckets inside the current scroll window are emitted
 * as DOM nodes.
 */
import { useMemo } from 'react'
import { useRenderState, type BucketState } from '@/hooks/useRenderState'

type Props = {
  projectName: string
  pxPerSec: number
  scrollLeft: number
  viewportWidth: number
  height?: number
}

const STATE_STYLES: Record<BucketState, React.CSSProperties> = {
  unrendered: { background: '#7f1d1d' },                  // Tailwind red-900
  rendering: { background: '#ef4444' },                   // Tailwind red-500
  cached: { background: '#3b82f6' },                      // Tailwind blue-500
  // Dark-red diagonal stripes — distinct from plain unrendered so the
  // user knows "I invalidated this" vs "never rendered".
  stale: {
    background:
      'repeating-linear-gradient(45deg, #7f1d1d 0 6px, #991b1b 6px 12px)',
  },
}

export function RenderStateBar({
  projectName,
  pxPerSec,
  scrollLeft,
  viewportWidth,
  height = 4,
}: Props) {
  const { snapshot } = useRenderState(projectName)

  // Only emit buckets visible in the scroll window. At 1 px/s that's
  // fine; at 100 px/s we still cap DOM nodes at ~viewportWidth / minBarPx.
  const visibleBuckets = useMemo(() => {
    if (!snapshot) return []
    const visibleStart = scrollLeft / pxPerSec
    const visibleEnd = (scrollLeft + viewportWidth) / pxPerSec
    return snapshot.buckets.filter(
      (b) => b.t_end >= visibleStart && b.t_start <= visibleEnd,
    )
  }, [snapshot, scrollLeft, viewportWidth, pxPerSec])

  if (!snapshot) return null

  const totalWidth = snapshot.duration_seconds * pxPerSec

  return (
    <div
      className="relative"
      style={{ height, width: totalWidth, minWidth: totalWidth }}
      aria-label="preview render state"
    >
      {visibleBuckets.map((b) => {
        const left = b.t_start * pxPerSec
        const width = (b.t_end - b.t_start) * pxPerSec
        return (
          <div
            key={b.t_start}
            style={{
              position: 'absolute',
              left,
              width,
              top: 0,
              height: '100%',
              ...STATE_STYLES[b.state],
            }}
            title={`${b.state} ${b.t_start.toFixed(1)}s`}
          />
        )
      })}
    </div>
  )
}
