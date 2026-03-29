import { useRef, useEffect, useCallback } from 'react'
import type { Beat } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression, AudioEvent, EffectType } from '@/lib/beatlab-client'

type BeatEffectPreviewProps = {
  src: string
  beats: Beat[]
  audioEvents?: AudioEvent[]
  userEffects?: UserEffect[]
  suppressions?: BeatSuppression[]
  currentTime: number
  isPlaying: boolean
  className?: string
  canvasWidth?: number
  canvasHeight?: number
  // Crossfade pair: frameA is outgoing, frameB is incoming, blendFactor controls mix
  transitionFrameA?: ImageBitmap | null
  transitionFrameB?: ImageBitmap | null
  blendFactor?: number // 0.0 = all A, 1.0 = all B
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
  uniform sampler2D u_imageA;
  uniform sampler2D u_imageB;
  uniform float u_blend;       // 0.0 = imageA only, 1.0 = imageB only
  uniform float u_intensity;   // 0.0 - 1.0 beat intensity
  uniform float u_decay;       // 0.0 - 1.0 time since beat (1.0 = on beat, decays to 0)

  void main() {
    float effect = u_intensity * u_decay;

    // Zoom toward center on beat
    vec2 center = vec2(0.5, 0.5);
    float zoom = 1.0 - effect * 0.06;
    vec2 uv = center + (v_texCoord - center) * zoom;

    vec4 colorA = texture2D(u_imageA, uv);
    vec4 colorB = texture2D(u_imageB, uv);
    vec4 color = mix(colorA, colorB, u_blend);

    // Brightness pulse
    color.rgb *= 1.0 + effect * 0.4;

    // Slight warm tint on strong beats
    color.r += effect * 0.03;
    color.g += effect * 0.01;

    gl_FragColor = color;
  }
`

function isTimeSuppressed(time: number, suppressions: BeatSuppression[], effectType?: string): boolean {
  return suppressions.some((s) => {
    if (time < s.from || time > s.to) return false
    if (!s.effectTypes || s.effectTypes.length === 0) return true
    return effectType ? s.effectTypes.includes(effectType as EffectType) : true
  })
}

function findEffectIntensity(
  beats: Beat[],
  audioEvents: AudioEvent[],
  userEffects: UserEffect[],
  suppressions: BeatSuppression[],
  time: number,
): { intensity: number; decay: number } {
  let bestIntensity = 0
  let bestDecay = 0

  // Prefer audio intelligence events over raw beats
  if (audioEvents.length > 0) {
    // Audio events are sorted by time — binary search for nearby events
    let lo = 0
    let hi = audioEvents.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (audioEvents[mid].time <= time) {
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    // Check events near the current time (search backward from hi)
    for (let i = hi; i >= Math.max(0, hi - 5); i--) {
      const ev = audioEvents[i]
      const dist = time - ev.time
      if (dist < 0) continue
      if (dist > ev.duration + 0.1) break
      // Per-event suppression: check this event's effect type against suppression zones
      if (isTimeSuppressed(time, suppressions, ev.effect)) continue
      if (dist <= ev.duration) {
        const decay = Math.max(0, 1 - dist / ev.duration)
        const d = decay * decay
        if (ev.intensity * d > bestIntensity * bestDecay) {
          bestIntensity = ev.intensity
          bestDecay = d
        }
      }
    }
  } else if (beats.length > 0 && !isTimeSuppressed(time, suppressions)) {
    // Fallback to raw beats (no effect type — global suppression check)
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

export function BeatEffectPreview({ src, beats, audioEvents = [], userEffects = [], suppressions = [], currentTime, isPlaying, className, canvasWidth = 256, canvasHeight = 144, transitionFrameA, transitionFrameB, blendFactor = 0 }: BeatEffectPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const glRef = useRef<{
    gl: WebGLRenderingContext
    program: WebGLProgram
    textureA: WebGLTexture
    textureB: WebGLTexture
    intensityLoc: WebGLUniformLocation
    decayLoc: WebGLUniformLocation
    blendLoc: WebGLUniformLocation
  } | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const animRef = useRef<number>(0)
  const currentSrc = useRef('')

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

    // Create two textures for crossfade blending
    const textureA = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, textureA)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    const textureB = gl.createTexture()!
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, textureB)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)

    // Bind sampler uniforms to texture units
    gl.uniform1i(gl.getUniformLocation(program, 'u_imageA'), 0)
    gl.uniform1i(gl.getUniformLocation(program, 'u_imageB'), 1)

    return {
      gl,
      program,
      textureA,
      textureB,
      intensityLoc: gl.getUniformLocation(program, 'u_intensity')!,
      decayLoc: gl.getUniformLocation(program, 'u_decay')!,
      blendLoc: gl.getUniformLocation(program, 'u_blend')!,
    }
  }, [])

  // Init WebGL on mount or when canvas dimensions change
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    glRef.current = initGL(canvas)
    return () => {
      cancelAnimationFrame(animRef.current)
    }
  }, [initGL, canvasWidth, canvasHeight])

  // Load image when src changes
  useEffect(() => {
    if (!src) {
      // No image — clear stale reference so we don't render the wrong keyframe
      imgRef.current = null
      currentSrc.current = ''
      return
    }
    if (src === currentSrc.current) return
    currentSrc.current = src

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      imgRef.current = img
      const ctx = glRef.current
      if (!ctx) return
      ctx.gl.activeTexture(ctx.gl.TEXTURE0)
      ctx.gl.bindTexture(ctx.gl.TEXTURE_2D, ctx.textureA)
      ctx.gl.texImage2D(ctx.gl.TEXTURE_2D, 0, ctx.gl.RGBA, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, img)
      // Draw once immediately
      render(0, 0, 0)
    }
    img.src = src
  }, [src])

  const render = useCallback((intensity: number, decay: number, blend: number) => {
    const ctx = glRef.current
    if (!ctx) return

    const sourceA = transitionFrameA || imgRef.current
    if (!sourceA) return
    // When no B frame, use A for both so blend has no visual effect
    const sourceB = transitionFrameB || sourceA

    ctx.gl.activeTexture(ctx.gl.TEXTURE0)
    ctx.gl.bindTexture(ctx.gl.TEXTURE_2D, ctx.textureA)
    ctx.gl.texImage2D(ctx.gl.TEXTURE_2D, 0, ctx.gl.RGBA, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, sourceA)

    ctx.gl.activeTexture(ctx.gl.TEXTURE1)
    ctx.gl.bindTexture(ctx.gl.TEXTURE_2D, ctx.textureB)
    ctx.gl.texImage2D(ctx.gl.TEXTURE_2D, 0, ctx.gl.RGBA, ctx.gl.RGBA, ctx.gl.UNSIGNED_BYTE, sourceB)

    const canvas = canvasRef.current
    if (!canvas) return

    ctx.gl.viewport(0, 0, canvas.width, canvas.height)
    ctx.gl.uniform1f(ctx.intensityLoc, intensity)
    ctx.gl.uniform1f(ctx.decayLoc, decay)
    ctx.gl.uniform1f(ctx.blendLoc, blend)
    ctx.gl.drawArrays(ctx.gl.TRIANGLES, 0, 6)
  }, [transitionFrameA, transitionFrameB])

  // Render loop when playing
  useEffect(() => {
    if (!isPlaying) {
      render(0, 0, blendFactor)
      return
    }

    const loop = () => {
      const { intensity, decay } = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
      render(intensity, decay, blendFactor)
      animRef.current = requestAnimationFrame(loop)
    }
    loop()

    return () => cancelAnimationFrame(animRef.current)
  }, [isPlaying, beats, audioEvents, userEffects, suppressions, currentTime, render, blendFactor])

  // Render on time changes when paused (seeking) or when frame/effects change
  useEffect(() => {
    if (isPlaying) return
    const { intensity, decay } = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
    render(intensity, decay, blendFactor)
  }, [currentTime, isPlaying, beats, audioEvents, userEffects, suppressions, render, transitionFrameA, transitionFrameB, blendFactor])

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      className={className}
    />
  )
}
