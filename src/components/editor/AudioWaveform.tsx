import { useEffect, useMemo, useRef, useState } from 'react'
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

// Each tile renders as its own canvas at native DPR. A fixed CSS width
// keeps the internal buffer (CSS * dpr) well under every browser's per-axis
// canvas limit (Chrome ~32k, Safari ~16k) and avoids the pixelation you get
// from scaling one giant clamped canvas. 2048 at dpr=2 → 4096 internal —
// plenty of room.
const TILE_WIDTH_CSS_PX = 2048

/**
 * Canvas-based waveform renderer. Fetches a float16 peak array once per clip
 * (cached module-wide) and draws vertical mirrored peaks across a row of
 * fixed-width canvas tiles. Below 16 px total width, renders nothing.
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

  const tiles = useMemo(() => {
    if (width < 16) return []
    const n = Math.max(1, Math.ceil(width / TILE_WIDTH_CSS_PX))
    const arr: Array<{ leftCss: number; widthCss: number }> = []
    for (let i = 0; i < n; i++) {
      const leftCss = i * TILE_WIDTH_CSS_PX
      const widthCss = Math.min(TILE_WIDTH_CSS_PX, width - leftCss)
      if (widthCss > 0) arr.push({ leftCss, widthCss })
    }
    return arr
  }, [width])

  if (width < 16 || durationSeconds <= 0) return null

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{ opacity: failed ? 0 : 0.9 }}
    >
      {tiles.map((tile, i) => (
        <WaveformTile
          key={i}
          leftCss={tile.leftCss}
          widthCss={tile.widthCss}
          totalWidthCss={width}
          height={height}
          peaks={peaks}
          color={color}
        />
      ))}
    </div>
  )
}

type WaveformTileProps = {
  leftCss: number
  widthCss: number
  totalWidthCss: number
  height: number
  peaks: Float32Array | null
  color: string
}

function WaveformTile({ leftCss, widthCss, totalWidthCss, height, peaks, color }: WaveformTileProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !peaks) return

    const dpr = window.devicePixelRatio || 1
    const pxW = Math.max(1, Math.floor(widthCss * dpr))
    const pxH = Math.max(1, Math.floor(height * dpr))
    canvas.width = pxW
    canvas.height = pxH
    canvas.style.width = `${widthCss}px`
    canvas.style.height = `${height}px`

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, pxW, pxH)

    const mid = pxH / 2
    const n = peaks.length
    if (n === 0) return

    // Figure out which slice of the peaks array covers this tile. Each tile's
    // CSS span [leftCss, leftCss + widthCss) maps to [leftCss/total,
    // (leftCss + widthCss)/total] of the full peaks range.
    const peakStart = (leftCss / totalWidthCss) * n
    const peakEnd = ((leftCss + widthCss) / totalWidthCss) * n
    const peakSpan = peakEnd - peakStart

    ctx.strokeStyle = color
    ctx.lineWidth = Math.max(1, dpr * 0.8)
    ctx.beginPath()

    // Draw one vertical line per output pixel, max-pooled from the tile's
    // peak slice. When this tile has more peaks than pixels (zoomed out,
    // many peaks per px) we max-pool; when fewer (zoomed in, one peak stretches
    // across many pixels) each peak covers multiple output lines.
    for (let x = 0; x < pxW; x++) {
      const i0 = Math.floor(peakStart + (x / pxW) * peakSpan)
      const i1 = Math.min(n, Math.max(i0 + 1, Math.floor(peakStart + ((x + 1) / pxW) * peakSpan)))
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
  }, [peaks, widthCss, height, color, leftCss, totalWidthCss])

  return (
    <canvas
      ref={canvasRef}
      className="absolute top-0 pointer-events-none"
      style={{ left: leftCss, width: widthCss, height }}
    />
  )
}
