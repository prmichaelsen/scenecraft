import { memo, useEffect, useRef, useState } from 'react'
import type { Transition } from '@/routes/project/$name/editor'

const SCENECRAFT_API_URL = import.meta.env.VITE_SCENECRAFT_API_URL || 'http://localhost:8890'

type Props = {
  projectName: string
  transition: Transition
  /** Width of the transition block in CSS pixels (drives thumbnail count). */
  blockWidth: number
  /** Minimum thumbnail width below which we skip the strip (solid block looks better). */
  minThumbWidthPx?: number
  /** Source aspect ratio, default 16:9. */
  aspectRatio?: number
  /** Max number of thumbs regardless of pixel budget — perception caps around 12. */
  maxThumbs?: number
}

/**
 * Filmstrip-style thumbnails rendered along a transition's timeline block.
 *
 * Samples frames from the transition's selected video at even intervals across
 * the clip's trim range. Self-measures height via ResizeObserver so track-height
 * changes ripple through. Silently skips rendering when blocks are too narrow
 * for useful thumbnails (< minThumbWidthPx) or when the transition has no
 * selected video / known source duration.
 *
 * Thumbnail URLs hit `GET /api/projects/:name/transitions/:id/filmstrip`, which
 * caches extracted JPEGs on disk keyed by `(tr_id, mtime, t_ms, height)`.
 */
export const TransitionFilmstrip = memo(function TransitionFilmstrip({
  projectName,
  transition,
  blockWidth,
  minThumbWidthPx = 32,
  aspectRatio = 16 / 9,
  maxThumbs = 12,
}: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      const h = entries[0].contentRect.height
      if (h > 0) setHeight(Math.round(h))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  if (!transition.hasSelectedVideo) return <div ref={ref} className="absolute inset-0 pointer-events-none" />
  const sourceDuration = transition.sourceVideoDuration ?? null
  if (sourceDuration == null || sourceDuration <= 0) return <div ref={ref} className="absolute inset-0 pointer-events-none" />
  if (height < 16) return <div ref={ref} className="absolute inset-0 pointer-events-none" />

  const thumbHeight = Math.max(16, height)
  const thumbWidth = Math.round(thumbHeight * aspectRatio)

  const fitCount = Math.max(1, Math.floor(blockWidth / thumbWidth))
  if (fitCount < 2 || thumbWidth < minThumbWidthPx) {
    return <div ref={ref} className="absolute inset-0 pointer-events-none" />
  }

  const trimIn = transition.trimIn ?? 0
  const trimOut = transition.trimOut ?? sourceDuration
  const sourceSpan = Math.max(0, trimOut - trimIn)
  if (sourceSpan <= 0) return <div ref={ref} className="absolute inset-0 pointer-events-none" />

  const n = Math.min(fitCount, maxThumbs)
  const step = n > 1 ? sourceSpan / (n - 1) : 0

  const encodedProject = encodeURIComponent(projectName)
  const encodedTr = encodeURIComponent(transition.id)

  return (
    <div ref={ref} className="absolute inset-0 pointer-events-none flex items-center justify-between px-0.5 overflow-hidden">
      {Array.from({ length: n }, (_, i) => {
        const t = trimIn + i * step
        const url = `${SCENECRAFT_API_URL}/api/projects/${encodedProject}/transitions/${encodedTr}/filmstrip?t=${t.toFixed(3)}&height=${thumbHeight}`
        return (
          <img
            key={i}
            src={url}
            alt=""
            loading="lazy"
            decoding="async"
            draggable={false}
            className="rounded-[2px] opacity-70"
            style={{
              width: thumbWidth,
              height: thumbHeight,
              objectFit: 'cover',
              flex: '0 0 auto',
            }}
            onError={(e) => {
              ;(e.currentTarget as HTMLImageElement).style.visibility = 'hidden'
            }}
          />
        )
      })}
    </div>
  )
})
