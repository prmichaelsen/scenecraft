/**
 * Records a preview of the editor by capturing the active <PreviewViewport>
 * surface (canvas when paused, <video> during MSE playback) plus audio, using
 * the MediaRecorder API. Outputs a WebM file.
 *
 * The recorder delegates surface choice to the component handle — during scrub
 * the canvas is on top and is what a user sees; during playback the video
 * element is. Both expose `.captureStream()` so the rest of the pipeline is
 * identical.
 */

import type { PreviewViewportHandle } from '@/components/editor/PreviewViewport'

export type RecordingState = {
  status: 'idle' | 'recording' | 'finishing'
  startTime: number
  endTime: number
  progress: number
}

export async function recordPreview(opts: {
  handle: PreviewViewportHandle
  audioElement: HTMLAudioElement
  startTime: number
  endTime: number
  onProgress: (progress: number) => void
}): Promise<Blob> {
  const { handle, audioElement, startTime, endTime, onProgress } = opts
  const duration = endTime - startTime

  const surface = handle.getActiveSurface()
  if (!surface) {
    throw new Error('Preview surface not ready (no canvas or video yet)')
  }

  // Capture the current surface — works for both HTMLCanvasElement and
  // HTMLVideoElement since both implement captureStream(). TS's HTMLVideoElement
  // lib types omit it, so cast to the common shape.
  const videoStream = (surface as unknown as { captureStream: (fps?: number) => MediaStream }).captureStream(24)

  // Capture audio stream from audio element
  const audioCtx = new AudioContext()
  const source = audioCtx.createMediaElementSource(audioElement)
  const dest = audioCtx.createMediaStreamDestination()
  source.connect(dest)
  source.connect(audioCtx.destination) // keep audible

  // Combine video + audio streams
  const combined = new MediaStream([
    ...videoStream.getVideoTracks(),
    ...dest.stream.getAudioTracks(),
  ])

  const chunks: Blob[] = []
  const recorder = new MediaRecorder(combined, {
    mimeType: 'video/webm;codecs=vp9,opus',
    videoBitsPerSecond: 5_000_000,
  })

  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  return new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => {
      // Disconnect audio routing
      try { source.disconnect(dest) } catch { /* noop */ }
      try { audioCtx.close() } catch { /* noop */ }
      resolve(new Blob(chunks, { type: 'video/webm' }))
    }
    recorder.onerror = (e) => reject(e)

    // Seek to start and play
    audioElement.currentTime = startTime
    recorder.start(100) // collect chunks every 100ms

    const checkProgress = () => {
      const elapsed = audioElement.currentTime - startTime
      onProgress(Math.min(elapsed / duration, 1))
      if (audioElement.currentTime >= endTime) {
        audioElement.pause()
        recorder.stop()
        return
      }
      if (recorder.state === 'recording') {
        requestAnimationFrame(checkProgress)
      }
    }

    audioElement.play().then(() => {
      requestAnimationFrame(checkProgress)
    }).catch(reject)
  })
}
