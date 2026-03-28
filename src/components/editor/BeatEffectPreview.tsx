import { useRef, useEffect, useCallback } from 'react'
import type { Beat } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression } from '@/lib/beatlab-client'

type BeatEffectPreviewProps = {
  src: string
  beats: Beat[]
  userEffects?: UserEffect[]
  suppressions?: BeatSuppression[]
  currentTime: number
  isPlaying: boolean
  className?: string
  // Transition video overlay — when set, renders video frames through the shader instead of static image
  videoSrc?: string
  videoCurrentTime?: number  // progress 0-1 within the transition
  videoPlaybackRate?: number // if omitted, auto-computed from video duration / transition span
  videoPlaying?: boolean
}

const VERTEX_SHADER = `
  attribute vec2 a_position;
  attribute vec2 a_texCoord;
  varying vec2 v_texCoord;
  void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    v_texCoord = a_texCoord;
  }
`

const FRAGMENT_SHADER = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_image;
  uniform float u_intensity;   // 0.0 - 1.0 beat intensity
  uniform float u_decay;       // 0.0 - 1.0 time since beat (1.0 = on beat, decays to 0)

  void main() {
    float effect = u_intensity * u_decay;

    // Zoom toward center on beat
    vec2 center = vec2(0.5, 0.5);
    float zoom = 1.0 - effect * 0.06;
    vec2 uv = center + (v_texCoord - center) * zoom;

    vec4 color = texture2D(u_image, uv);

    // Brightness pulse
    color.rgb *= 1.0 + effect * 0.4;

    // Slight warm tint on strong beats
    color.r += effect * 0.03;
    color.g += effect * 0.01;

    gl_FragColor = color;
  }
`

function isTimeSuppressed(time: number, suppressions: BeatSuppression[]): boolean {
  return suppressions.some((s) => time >= s.from && time <= s.to)
}

function findEffectIntensity(
  beats: Beat[],
  userEffects: UserEffect[],
  suppressions: BeatSuppression[],
  time: number,
): { intensity: number; decay: number } {
  let bestIntensity = 0
  let bestDecay = 0

  // Check auto-beats (unless suppressed)
  if (beats.length > 0 && !isTimeSuppressed(time, suppressions)) {
    let lo = 0
    let hi = beats.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (beats[mid].time <= time) {
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (hi >= 0) {
      const dist = time - beats[hi].time
      if (dist <= 0.3) {
        const decay = Math.max(0, 1 - dist / 0.2)
        const d = decay * decay
        if (beats[hi].intensity * d > bestIntensity * bestDecay) {
          bestIntensity = beats[hi].intensity
          bestDecay = d
        }
      }
    }
  }

  // Check user effects (always active, never suppressed)
  for (const fx of userEffects) {
    const dist = time - fx.time
    if (dist >= 0 && dist <= fx.duration) {
      const decay = Math.max(0, 1 - dist / fx.duration)
      const d = decay * decay
      if (fx.intensity * d > bestIntensity * bestDecay) {
        bestIntensity = fx.intensity
        bestDecay = d
      }
    }
  }

  return { intensity: bestIntensity, decay: bestDecay }
}

export function BeatEffectPreview({ src, beats, userEffects = [], suppressions = [], currentTime, isPlaying, className, videoSrc, videoCurrentTime, videoPlaybackRate, videoPlaying }: BeatEffectPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<{
    gl: WebGLRenderingContext
    program: WebGLProgram
    texture: WebGLTexture
    intensityLoc: WebGLUniformLocation
    decayLoc: WebGLUniformLocation
  } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const animRef = useRef<number>(0)
  const currentSrc = useRef('')
  const currentVideoSrc = useRef('')
  const useVideo = useRef(false)

  const initGL = useCallback((canvas: HTMLCanvasElement) => {
    const gl = canvas.getContext('webgl', { premultipliedAlpha: false })
    if (!gl) return null

    // Compile shaders
    const vs = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(vs, VERTEX_SHADER)
    gl.compileShader(vs)

    const fs = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(fs, FRAGMENT_SHADER)
    gl.compileShader(fs)

    const program = gl.createProgram()!
    gl.attachShader(program, vs)
    gl.attachShader(program, fs)
    gl.linkProgram(program)
    gl.useProgram(program)

    // Quad vertices (position + texcoord)
    const posLoc = gl.getAttribLocation(program, 'a_position')
    const texLoc = gl.getAttribLocation(program, 'a_texCoord')

    const posBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      -1, -1, 1, -1, -1, 1,
      -1, 1, 1, -1, 1, 1,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(posLoc)
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0)

    const texBuf = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, texBuf)
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
      0, 1, 1, 1, 0, 0,
      0, 0, 1, 1, 1, 0,
    ]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(texLoc)
    gl.vertexAttribPointer(texLoc, 2, gl.FLOAT, false, 0, 0)

    const texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    return {
      gl,
      program,
      texture,
      intensityLoc: gl.getUniformLocation(program, 'u_intensity')!,
      decayLoc: gl.getUniformLocation(program, 'u_decay')!,
    }
  }, [])

  // Init WebGL on mount
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    glRef.current = initGL(canvas)
    return () => {
      cancelAnimationFrame(animRef.current)
    }
  }, [initGL])

  // Load image when src changes
  useEffect(() => {
    if (!src || src === currentSrc.current) return
    currentSrc.current = src

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      const ctx = glRef.current
      if (!ctx) return
      ctx.gl.bindTexture(ctx.gl.TEXTURE_2D, ctx.texture)
      ctx.gl.texImage2D(ctx.gl.TEXTURE_2D, 0, ctx.gl.RGBA, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, img)
      // Draw once immediately
      render(0, 0)
    }
    img.src = src
  }, [src])

  // Load/manage transition video
  useEffect(() => {
    if (!videoSrc) {
      useVideo.current = false
      if (videoRef.current) {
        videoRef.current.pause()
        videoRef.current.src = ''
        videoRef.current = null
        currentVideoSrc.current = ''
      }
      return
    }
    if (videoSrc === currentVideoSrc.current) return
    currentVideoSrc.current = videoSrc

    const video = document.createElement('video')
    video.crossOrigin = 'anonymous'
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'

    video.onloadeddata = () => {
      videoRef.current = video
      useVideo.current = true
      if (videoPlaybackRate) video.playbackRate = Math.max(0.25, Math.min(16, videoPlaybackRate))
    }

    video.src = videoSrc
    video.load()

    return () => {
      video.pause()
      video.src = ''
    }
  }, [videoSrc, videoPlaybackRate])

  // Control video playback
  useEffect(() => {
    const video = videoRef.current
    if (!video || !useVideo.current) return
    if (videoPlaybackRate) video.playbackRate = Math.max(0.25, Math.min(16, videoPlaybackRate))

    const seekTime = videoCurrentTime !== undefined ? videoCurrentTime * video.duration : undefined

    if (videoPlaying) {
      if (seekTime !== undefined && isFinite(seekTime)) {
        video.currentTime = seekTime
      }
      video.play().catch(() => {})
    } else {
      video.pause()
      if (seekTime !== undefined && isFinite(seekTime)) {
        video.currentTime = seekTime
      }
    }
  }, [videoPlaying, videoCurrentTime, videoPlaybackRate])

  const render = useCallback((intensity: number, decay: number) => {
    const ctx = glRef.current
    if (!ctx) return

    // Upload video frame or static image as texture
    const video = videoRef.current
    const hasVideo = useVideo.current && video && video.readyState >= 2
    const source = hasVideo ? video : imgRef.current
    if (!source) return

    if (hasVideo) {
      // Re-upload video frame every render tick
      ctx.gl.bindTexture(ctx.gl.TEXTURE_2D, ctx.texture)
      ctx.gl.texImage2D(ctx.gl.TEXTURE_2D, 0, ctx.gl.RGBA, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, video)
    }

    const canvas = canvasRef.current
    if (!canvas) return

    ctx.gl.viewport(0, 0, canvas.width, canvas.height)
    ctx.gl.uniform1f(ctx.intensityLoc, intensity)
    ctx.gl.uniform1f(ctx.decayLoc, decay)
    ctx.gl.drawArrays(ctx.gl.TRIANGLES, 0, 6)
  }, [])

  // Render loop when playing
  useEffect(() => {
    if (!isPlaying) {
      // When paused, render with no effect
      render(0, 0)
      return
    }

    const loop = () => {
      const { intensity, decay } = findEffectIntensity(beats, userEffects, suppressions, currentTime)
      render(intensity, decay)
      animRef.current = requestAnimationFrame(loop)
    }
    loop()

    return () => cancelAnimationFrame(animRef.current)
  }, [isPlaying, beats, currentTime, render])

  // Also render on time changes when paused (seeking)
  useEffect(() => {
    if (isPlaying) return
    const { intensity, decay } = findEffectIntensity(beats, userEffects, suppressions, currentTime)
    render(intensity, decay)
  }, [currentTime, isPlaying, beats, render])

  return (
    <canvas
      ref={canvasRef}
      width={256}
      height={144}
      className={className}
    />
  )
}
