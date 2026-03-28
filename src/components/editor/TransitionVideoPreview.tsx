import { useRef, useEffect, useCallback } from 'react'
import { beatlabFileUrl } from '@/lib/beatlab-client'

type TransitionVideoPreviewProps = {
  projectName: string
  transitionId: string
  slotIndex: number
  currentTime: number
  transitionStart: number  // fromKf.timeSeconds
  transitionEnd: number    // toKf.timeSeconds
  isPlaying: boolean
  className?: string
}

export function TransitionVideoPreview({
  projectName,
  transitionId,
  slotIndex,
  currentTime,
  transitionStart,
  transitionEnd,
  isPlaying,
  className,
}: TransitionVideoPreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const durationKnown = useRef(false)
  const timelineDuration = transitionEnd - transitionStart

  const videoUrl = beatlabFileUrl(
    projectName,
    `selected_transitions/${transitionId}_slot_${slotIndex}.mp4`
  )

  // Set playback rate once we know the video's actual duration
  const handleLoadedMetadata = useCallback(() => {
    const video = videoRef.current
    if (!video || timelineDuration <= 0) return
    durationKnown.current = true
    const rate = video.duration / timelineDuration
    // Clamp playback rate to browser limits (typically 0.25 - 16)
    video.playbackRate = Math.max(0.25, Math.min(16, rate))
  }, [timelineDuration])

  // Seek to the correct position within the transition
  useEffect(() => {
    const video = videoRef.current
    if (!video || !durationKnown.current) return

    const progress = Math.max(0, Math.min(1, (currentTime - transitionStart) / timelineDuration))
    const targetVideoTime = progress * video.duration

    if (!isPlaying) {
      // When paused/seeking, set video time directly
      video.currentTime = targetVideoTime
    }
  }, [currentTime, transitionStart, timelineDuration, isPlaying])

  // Play/pause sync
  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    if (isPlaying) {
      // Seek to correct position before playing
      if (durationKnown.current) {
        const progress = Math.max(0, Math.min(1, (currentTime - transitionStart) / timelineDuration))
        video.currentTime = progress * video.duration
      }
      video.play().catch(() => {})
    } else {
      video.pause()
    }
  }, [isPlaying, currentTime, transitionStart, timelineDuration])

  return (
    <video
      ref={videoRef}
      src={videoUrl}
      className={className}
      muted
      playsInline
      onLoadedMetadata={handleLoadedMetadata}
    />
  )
}
