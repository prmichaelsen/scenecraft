import { useEffect, useRef, useState } from 'react'
import { fetchPeaks } from '@/lib/waveform-cache'

type AudioWaveformProps = {
  projectName: string
  clipId: string
  width: number
  height: number
  durationSeconds: number
  color?: string
  /** Peaks-per-second resolution requested from the server. */
  resolution?: number
}

/**
 * Canvas-based waveform renderer. Fetches a float16 peak array once per clip
 * (cached module-wide) and draws vertical mirrored peaks across the canvas.
 *
 * Skips draw entirely below 16 px width — too small to be meaningful.
 */
export function AudioWaveform({
  projectName,
  clipId,
  width,
  height,
  durationSeconds,
  color = '#22d3ee', // cyan-400
  resolution = 400,
}: AudioWaveformProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [failed, setFailed] = useState(false)

  // Fetch peaks once per clip
  useEffect(() => {
    if (!clipId || durationSeconds <= 0) return
    let cancelled = false
    fetchPeaks(projectName, clipId, resolution)
      .then((p) => { if (!cancelled) setPeaks(p) })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [projectName, clipId, durationSeconds, resolution])

  // Draw whenever peaks or size change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks || width < 16) return

    const dpr = window.devicePixelRatio || 1
    const pxW = Math.max(1, Math.floor(width * dpr))
    const pxH = Math.max(1, Math.floor(height * dpr))
    canvas.width = pxW
    canvas.height = pxH
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, pxW, pxH)

    const mid = pxH / 2
    const n = peaks.length
    if (n === 0) return

    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, dpr * 0.8)
    ctx.beginPath()

    // Draw one vertical line per output pixel, max-pooled from the peaks array
    // when the array has more peaks than pixels (common case).
    const step = n / pxW
    for (let x = 0; x < pxW; x++) {
      const i0 = Math.floor(x * step)
      const i1 = Math.min(n, Math.max(i0 + 1, Math.floor((x + 1) * step)))
      let m = 0
      for (let i = i0; i < i1; i++) {
        const v = peaks[i]
        if (v > m) m = v
      }
      const h = Math.max(1, m * (pxH - 2) * 0.5)
      ctx.moveTo(x + 0.5, mid - h)
      ctx.lineTo(x + 0.5, mid + h)
    }
    ctx.stroke()
  }, [peaks, width, height, color])

  if (width < 16 || durationSeconds <= 0) return null

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 pointer-events-none"
      style={{ width, height, opacity: failed ? 0 : 0.9 }}
    />
  )
}
