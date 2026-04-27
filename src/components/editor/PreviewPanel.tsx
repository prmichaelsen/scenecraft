import { useRef, useEffect } from 'react'
import { useCurrentTime, usePlaybackState } from './CurrentTimeContext'
import { usePreview } from './PreviewContext'
import { useEditorState } from './EditorStateContext'
import { PreviewViewport } from './PreviewViewport'
import { TransformHandles } from './TransformHandles'
import { useEditorData } from './EditorDataContext'

export function PreviewPanel() {
  const data = useEditorData()
  const { currentTime } = useCurrentTime()
  const { isPlaying } = usePlaybackState()
  const { hoverPreviewUrl, hoverVideo, previewRef } = usePreview()
  const { selectedTransition } = useEditorState()
  const containerRef = useRef<HTMLDivElement>(null)
  const hoverVideoRef = useRef<HTMLVideoElement>(null)

  const keyframes = data.keyframes.map((kf) => ({
    ...kf,
    timeSeconds: kf.timestamp.split(':').reduce((acc, part, i) => acc + parseFloat(part) * [3600, 60, 1][i], 0),
  }))

  // Sync hover video element with scrub/play state
  useEffect(() => {
    const video = hoverVideoRef.current
    if (!video || !hoverVideo) return
    if (video.src !== hoverVideo.url) {
      video.src = hoverVideo.url
      video.load()
    }
    if (hoverVideo.scrubProgress != null) {
      // Scrub mode — pause and seek
      video.pause()
      const seekTo = (video.duration || 0) * hoverVideo.scrubProgress
      if (isFinite(seekTo) && Math.abs(video.currentTime - seekTo) > 0.05) {
        video.currentTime = seekTo
      }
    } else {
      // Auto-play mode
      if (video.paused) video.play().catch(() => {})
    }
  }, [hoverVideo])

  return (
    <div className="h-full w-full bg-gray-950 flex items-center justify-center overflow-hidden">
      <div ref={containerRef} className="h-full aspect-video bg-gray-800 rounded overflow-hidden relative">
        {hoverVideo ? (
          <div className="absolute inset-0 z-10">
            <video
              ref={hoverVideoRef}
              className="w-full h-full object-cover"
              loop
              playsInline
              preload="auto"
            />
            {/* Red scrub line */}
            {hoverVideo.scrubProgress != null && (
              <div
                className="absolute top-0 bottom-0 w-0.5 bg-red-500 pointer-events-none"
                style={{ left: `${hoverVideo.scrubProgress * 100}%` }}
              />
            )}
          </div>
        ) : hoverPreviewUrl ? (
          hoverPreviewUrl.endsWith('.mp4') ? (
            <video src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" autoPlay muted loop playsInline />
          ) : (
            <img src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" draggable={false} />
          )
        ) : null}
        <PreviewViewport
          ref={previewRef}
          projectName={data.projectName}
          currentTime={currentTime}
          playing={isPlaying}
        />
        {selectedTransition && (
          <TransformHandles
            containerRef={containerRef}
            transition={selectedTransition}
            linearProgress={(() => {
              const fromKf = keyframes.find((k) => k.id === selectedTransition.from)
              const toKf = keyframes.find((k) => k.id === selectedTransition.to)
              if (!fromKf || !toKf || toKf.timeSeconds <= fromKf.timeSeconds) return 0
              return Math.max(0, Math.min(0.999, (currentTime - fromKf.timeSeconds) / (toKf.timeSeconds - fromKf.timeSeconds)))
            })()}
            transformMode={false}
            onCurvePinUpdate={async (trId, curveKey, progress, value) => {
              const styleKey = curveKey
              const existing = (selectedTransition as Record<string, unknown>)[curveKey] as [number, number][] | null
              // Scale curves default to a flat-at-1.0 curve; translate
              // curves default to flat-at-0.0. The scale axes replaced
              // the old single "z" axis after the z-to-scaleX/scaleY
              // split, so we match on either of the two new curve keys.
              const isScaleCurve = curveKey === 'transformScaleXCurve' || curveKey === 'transformScaleYCurve'
              const pts: [number, number][] = existing ? [...existing] : isScaleCurve ? [[0, 1], [1, 1]] : [[0, 0], [1, 0]]
              const idx = pts.findIndex((p) => Math.abs(p[0] - progress) < 0.005)
              if (idx >= 0) {
                pts[idx] = [pts[idx][0], value]
              } else {
                pts.push([progress, value])
                pts.sort((a, b) => a[0] - b[0])
              }
              ;(selectedTransition as Record<string, unknown>)[curveKey] = pts
              const { postUpdateTransitionStyle } = await import('@/lib/scenecraft-client')
              await postUpdateTransitionStyle(data.projectName, trId, { [styleKey]: pts } as never)
            }}
            onAnchorUpdate={async (trId, anchorX, anchorY) => {
              if (selectedTransition) { selectedTransition.anchorX = anchorX; selectedTransition.anchorY = anchorY }
              const { postUpdateTransitionStyle } = await import('@/lib/scenecraft-client')
              await postUpdateTransitionStyle(data.projectName, trId, { anchorX, anchorY } as never)
            }}
            onMaskCenterUpdate={async (trId, cx, cy) => {
              if (selectedTransition) { selectedTransition.maskCenterX = cx; selectedTransition.maskCenterY = cy }
              const { postUpdateTransitionStyle } = await import('@/lib/scenecraft-client')
              await postUpdateTransitionStyle(data.projectName, trId, { maskCenterX: cx, maskCenterY: cy } as never)
            }}
          />
        )}
      </div>
    </div>
  )
}
