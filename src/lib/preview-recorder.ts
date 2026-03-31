/**
 * Records a preview by capturing the BeatEffectPreview canvas + audio
 * using MediaRecorder API. Outputs a WebM file.
 */

export type RecordingState = {
  status: 'idle' | 'recording' | 'finishing'
  startTime: number
  endTime: number
  progress: number
}

export async function recordPreview(opts: {
  canvas: HTMLCanvasElement
  audioElement: HTMLAudioElement
  startTime: number
  endTime: number
  onProgress: (progress: number) => void
}): Promise<Blob> {
  const { canvas, audioElement, startTime, endTime, onProgress } = opts
  const duration = endTime - startTime

  // Capture video stream from canvas
  const videoStream = canvas.captureStream(24)

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
      try { source.disconnect(dest) } catch {}
      try { audioCtx.close() } catch {}
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
