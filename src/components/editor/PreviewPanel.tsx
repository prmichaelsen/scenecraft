import { useRef } from 'react'
import { useCurrentTime } from './CurrentTimeContext'
import { usePreview } from './PreviewContext'
import { useEditorState } from './EditorStateContext'
import { BeatEffectPreview } from './BeatEffectPreview'
import { TransformHandles } from './TransformHandles'
import { scenecraftFileUrl } from '@/lib/scenecraft-client'
import { useEditorData } from './EditorDataContext'

export function PreviewPanel() {
  const data = useEditorData()
  const { currentTime, isPlaying } = useCurrentTime()
  const { crossfadeData, trackLayers, isTransitionLoading, hoverPreviewUrl, previewRef } = usePreview()
  const { selectedTransition } = useEditorState()
  const containerRef = useRef<HTMLDivElement>(null)

  const keyframes = data.keyframes.map((kf) => ({
    ...kf,
    timeSeconds: kf.timestamp.split(':').reduce((acc, part, i) => acc + parseFloat(part) * [3600, 60, 1][i], 0),
  }))

  const currentKeyframe = [...keyframes]
    .filter((kf) => kf.timeSeconds <= currentTime)
    .sort((a, b) => b.timeSeconds - a.timeSeconds)
    .find((kf) => kf.hasSelectedImage)
    || [...keyframes].reverse().find((kf) => kf.timeSeconds <= currentTime)

  const canvasWidth = data.meta.resolution?.[0] || 1920
  const canvasHeight = data.meta.resolution?.[1] || 1080

  return (
    <div className="h-full w-full bg-gray-950 flex items-center justify-center overflow-hidden">
      <div ref={containerRef} className="h-full aspect-video bg-gray-800 rounded overflow-hidden relative">
        {hoverPreviewUrl && (
          hoverPreviewUrl.endsWith('.mp4') ? (
            <video src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" autoPlay muted loop playsInline />
          ) : (
            <img src={hoverPreviewUrl} className="absolute inset-0 w-full h-full object-cover z-10" draggable={false} />
          )
        )}
        {currentKeyframe?.hasSelectedImage || crossfadeData.frameA ? (
          <BeatEffectPreview
            ref={previewRef}
            src={currentKeyframe?.hasSelectedImage
              ? scenecraftFileUrl(data.projectName, `selected_keyframes/${currentKeyframe.id}.png`) + `?v=${currentKeyframe.selected ?? 0}`
              : ''}
            beats={data.beats}
            audioEvents={data.audioEvents}
            userEffects={data.userEffects}
            suppressions={data.beatSuppressions}
            currentTime={currentTime}
            isPlaying={isPlaying}
            className="w-full h-full object-cover"
            canvasWidth={canvasWidth}
            canvasHeight={canvasHeight}
            transitionFrameA={crossfadeData.frameA}
            transitionFrameB={crossfadeData.frameB}
            blendFactor={crossfadeData.blendFactor}
            layers={trackLayers.length > 0 ? trackLayers : undefined}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600 text-sm">
            No image
          </div>
        )}
        {isTransitionLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/40 pointer-events-none">
            <span className="text-white/70 text-xs">Loading frames...</span>
          </div>
        )}
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
              const pts: [number, number][] = existing ? [...existing] : curveKey === 'transformZCurve' ? [[0, 1], [1, 1]] : [[0, 0], [1, 0]]
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
