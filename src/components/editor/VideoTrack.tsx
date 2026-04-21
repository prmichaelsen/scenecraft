import { useState, memo, type RefObject } from 'react'
import type { KeyframeWithTime } from './Timeline'
import { scenecraftFileUrl } from '@/lib/scenecraft-client'

type VideoTrackProps = {
  keyframes: KeyframeWithTime[]
  pxPerSec: number
  projectName: string
  selectedId: string | null
  selectedIds: Set<string>
  duration: number
  onKeyframeClick: (kf: KeyframeWithTime, shiftKey?: boolean) => void
  scrollRef: RefObject<HTMLDivElement | null>
  scrollLeft: number
  viewportWidth: number
  onDropVideo?: (keyframeId: string, poolPath: string) => void
  onDropImage?: (keyframeId: string, imagePath: string) => void
  onDropStagedImage?: (keyframeId: string, stagingId: string, variant: number) => void
}

export const VideoTrack = memo(function VideoTrack({
  keyframes,
  pxPerSec,
  projectName,
  selectedId,
  selectedIds,
  onKeyframeClick,
  scrollLeft,
  viewportWidth,
  onDropVideo,
  onDropImage,
  onDropStagedImage,
}: VideoTrackProps) {
  const [dropTarget, setDropTarget] = useState<string | null>(null)

  const BUFFER_PX = 300

  return (
    <div className="relative h-full overflow-visible">
      {keyframes.map((kf, i) => {
        const x = kf.timeSeconds * pxPerSec
        const nextKf = keyframes[i + 1]
        const nextX = nextKf ? nextKf.timeSeconds * pxPerSec : x + 60
        const width = Math.max(nextX - x, 2)
        // Viewport culling: skip keyframes outside visible range
        if (nextX < scrollLeft - BUFFER_PX || x > scrollLeft + viewportWidth + BUFFER_PX) return null
        const isSelected = kf.id === selectedId || selectedIds.has(kf.id)

        return (
          <div
            key={kf.id}
            className={`absolute top-0 h-full group ${dropTarget === kf.id ? 'bg-green-500/20 ring-1 ring-green-500' : ''} ${isSelected ? 'bg-teal-500/30 ring-1 ring-teal-500/50' : ''}`}
            style={{ left: x, width }}
            onClick={(e) => {
              e.stopPropagation()
              onKeyframeClick(kf, e.shiftKey)
            }}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('application/x-scenecraft-pool-path') || e.dataTransfer.types.includes('application/x-scenecraft-staging-path')) {
                e.preventDefault()
                e.dataTransfer.dropEffect = 'copy'
                setDropTarget(kf.id)
              }
            }}
            onDragLeave={() => setDropTarget((prev) => prev === kf.id ? null : prev)}
            onDrop={(e) => {
              e.preventDefault()
              setDropTarget(null)
              const poolPath = e.dataTransfer.getData('application/x-scenecraft-pool-path')
              if (poolPath) {
                const isImage = /\.(png|jpg|jpeg|webp)$/i.test(poolPath)
                if (isImage && onDropImage) {
                  onDropImage(kf.id, poolPath)
                } else if (!isImage && onDropVideo) {
                  onDropVideo(kf.id, poolPath)
                }
                return
              }
              const stagingId = e.dataTransfer.getData('application/x-scenecraft-staging-id')
              const variant = e.dataTransfer.getData('application/x-scenecraft-variant')
              if (stagingId && variant && onDropStagedImage) {
                onDropStagedImage(kf.id, stagingId, parseInt(variant, 10))
              }
            }}
          >
            {/* Keyframe marker — visual anchor only; kf-drag is owned by TransitionTrack boundary handles */}
            <div className={`absolute top-0 left-0 w-px h-full pointer-events-none z-30 ${isSelected ? 'bg-teal-400' : 'bg-gray-700'}`} />

            {/* Thumbnail — skip when region is too narrow to see it */}
            {kf.hasSelectedImage && width > 20 ? (
              <img
                src={`${scenecraftFileUrl(projectName, `selected_keyframes/${kf.id}.png`)}?v=${kf.selected ?? 0}`}
                alt={kf.id}
                className={`absolute top-1 left-3 h-[calc(100%-8px)] aspect-video object-cover rounded-sm transition-opacity cursor-grab active:cursor-grabbing ${isSelected ? 'opacity-100 ring-1 ring-teal-400' : 'opacity-70 group-hover:opacity-100'}`}
                loading="lazy"
                draggable={false}
              />
            ) : (
              <div className="absolute top-1 left-3 h-[calc(100%-8px)] aspect-video bg-gray-800/50 rounded-sm flex items-center justify-center cursor-grab active:cursor-grabbing">
                <span className="text-[8px] text-gray-600">{kf.id}</span>
              </div>
            )}

            {/* KF ID */}
            <div className="absolute top-0.5 right-0.5 text-[7px] text-gray-500/70 font-mono pointer-events-none">{kf.id.replace('kf_', '')}</div>

            {/* Label / section */}
            <div className="absolute bottom-0.5 left-3 text-[8px] truncate max-w-[80px]" style={kf.labelColor ? { color: kf.labelColor } : undefined}>
              {kf.label ? (
                <span className="font-medium">{kf.label}</span>
              ) : (
                <span className="text-gray-500">{kf.section}</span>
              )}
            </div>

            {/* Hover tooltip */}
            <div className="absolute top-full left-0 mt-1 hidden group-hover:block bg-gray-800 text-xs text-gray-300 px-2 py-1 rounded shadow-lg whitespace-nowrap z-50 pointer-events-none">
              {kf.id} @ {formatTimestamp(kf.timeSeconds)} — {kf.section}
              <span className="text-gray-500 ml-1">
                ({formatDuration(nextKf ? nextKf.timeSeconds - kf.timeSeconds : 0)})
              </span>
            </div>
          </div>
        )
      })}
    </div>
  )
})

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  const whole = Math.floor(s)
  const frac = s - whole
  if (frac < 0.005) {
    return `${m}:${whole.toString().padStart(2, '0')}`
  }
  return `${m}:${whole.toString().padStart(2, '0')}.${Math.round(frac * 100).toString().padStart(2, '0')}`
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${Math.round(s)}s`
}
