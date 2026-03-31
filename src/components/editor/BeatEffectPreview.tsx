import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react'
import type { Beat } from '@/routes/project/$name/editor'
import type { UserEffect, BeatSuppression, AudioEvent, EffectType } from '@/lib/beatlab-client'

import type { BlendMode } from '@/lib/beatlab-client'

export type TrackLayer = {
  frameA: ImageBitmap | null
  frameB: ImageBitmap | null
  blendFactor: number
  opacity: number
  blendMode: BlendMode
}

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
  // Single-track (legacy) or multi-track layers
  transitionFrameA?: ImageBitmap | null
  transitionFrameB?: ImageBitmap | null
  blendFactor?: number
  layers?: TrackLayer[]
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
  uniform float u_echo;        // 0.0 = no echo, higher = more echo layers visible

  vec4 sampleBlended(vec2 uv) {
    return mix(texture2D(u_imageA, uv), texture2D(u_imageB, uv), u_blend);
  }

  void main() {
    float effect = u_intensity * u_decay;
    vec2 center = vec2(0.5, 0.5);

    // Base zoom toward center on beat
    float zoom = 1.0 - effect * 0.06;
    vec2 uv = center + (v_texCoord - center) * zoom;
    vec4 color = sampleBlended(uv);

    // Echo: stack multiple zoom layers with increasing zoom + decreasing opacity
    if (u_echo > 0.01) {
      float echoLayers = 5.0;
      for (float i = 1.0; i <= 5.0; i += 1.0) {
        float layerZoom = zoom - u_echo * 0.04 * i; // each layer zooms further in
        vec2 layerUv = center + (v_texCoord - center) * layerZoom;
        vec4 layerColor = sampleBlended(layerUv);
        float layerAlpha = u_echo * (1.0 - i / (echoLayers + 1.0)) * 0.4;
        color = mix(color, layerColor, layerAlpha);
      }
    }

    // Brightness pulse
    color.rgb *= 1.0 + effect * 0.4;

    // Slight warm tint on strong beats
    color.r += effect * 0.03;
    color.g += effect * 0.01;

    gl_FragColor = color;
  }
`


// Compositor shader: blends a layer onto an accumulator with blend modes
const COMPOSITE_SHADER = `
  precision mediump float;
  varying vec2 v_texCoord;
  uniform sampler2D u_base;    // accumulator
  uniform sampler2D u_layerA;  // track frame A
  uniform sampler2D u_layerB;  // track frame B
  uniform float u_layerBlend;  // crossfade A->B
  uniform float u_opacity;
  uniform int u_blendMode;     // 0=normal,1=multiply,2=screen,3=overlay,4=difference,5=add

  void main() {
    vec4 base = texture2D(u_base, v_texCoord);
    vec4 lA = texture2D(u_layerA, v_texCoord);
    vec4 lB = texture2D(u_layerB, v_texCoord);
    vec3 layer = mix(lA.rgb, lB.rgb, u_layerBlend);

    vec3 blended;
    if (u_blendMode == 1) { blended = base.rgb * layer; }                                      // multiply
    else if (u_blendMode == 2) { blended = 1.0 - (1.0 - base.rgb) * (1.0 - layer); }          // screen
    else if (u_blendMode == 3) { blended = mix(2.0*base.rgb*layer, 1.0-2.0*(1.0-base.rgb)*(1.0-layer), step(0.5, base.rgb)); } // overlay
    else if (u_blendMode == 4) { blended = abs(base.rgb - layer); }                            // difference
    else if (u_blendMode == 5) { blended = min(base.rgb + layer, 1.0); }                       // add
    else { blended = layer; }                                                                   // normal

    gl_FragColor = vec4(mix(base.rgb, blended, u_opacity), 1.0);
  }
`

const BLEND_MODE_MAP: Record<string, number> = {
  normal: 0, multiply: 1, screen: 2, overlay: 3, difference: 4, add: 5, 'soft-light': 3, // soft-light → overlay fallback
}

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
): { intensity: number; decay: number; echoIntensity: number } {
  let bestIntensity = 0
  let bestDecay = 0
  let echoIntensity = 0

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
        // Echo effect: track separately
        if (ev.effect === 'echo' || ev.effect === 'echo_pulse') {
          const e = ev.intensity * d
          if (e > echoIntensity) echoIntensity = e
        } else if (ev.intensity * d > bestIntensity * bestDecay) {
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
      if (fx.type === 'echo') {
        const e = fx.intensity * d
        if (e > echoIntensity) echoIntensity = e
      } else if (fx.intensity * d > bestIntensity * bestDecay) {
        bestIntensity = fx.intensity
        bestDecay = d
      }
    }
  }

  return { intensity: bestIntensity, decay: bestDecay, echoIntensity }
}

export type BeatEffectPreviewHandle = {
  getCanvas: () => HTMLCanvasElement | null
}

export const BeatEffectPreview = forwardRef<BeatEffectPreviewHandle, BeatEffectPreviewProps>(function BeatEffectPreview({ src, beats, audioEvents = [], userEffects = [], suppressions = [], currentTime, isPlaying, className, canvasWidth = 256, canvasHeight = 144, transitionFrameA, transitionFrameB, blendFactor = 0, layers }, ref) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useImperativeHandle(ref, () => ({
    getCanvas: () => canvasRef.current,
  }), [])
  const glRef = useRef<{
    gl: WebGLRenderingContext
    program: WebGLProgram
    textureA: WebGLTexture
    textureB: WebGLTexture
    intensityLoc: WebGLUniformLocation
    decayLoc: WebGLUniformLocation
    blendLoc: WebGLUniformLocation
    echoLoc: WebGLUniformLocation
    // Compositor
    compProgram: WebGLProgram
    compBaseTex: WebGLTexture
    compFbo: WebGLFramebuffer
    compAccumTex: WebGLTexture
    compFbo2: WebGLFramebuffer
    compAccumTex2: WebGLTexture
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
    gl.bindAttribLocation(program, 0, 'a_position')
    gl.bindAttribLocation(program, 1, 'a_texCoord')
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

    // ── Compositor program ───────────────────────────────────
    const compVs = gl.createShader(gl.VERTEX_SHADER)!
    gl.shaderSource(compVs, VERTEX_SHADER)
    gl.compileShader(compVs)
    const compFs = gl.createShader(gl.FRAGMENT_SHADER)!
    gl.shaderSource(compFs, COMPOSITE_SHADER)
    gl.compileShader(compFs)
    const compProgram = gl.createProgram()!
    gl.attachShader(compProgram, compVs)
    gl.attachShader(compProgram, compFs)
    gl.bindAttribLocation(compProgram, 0, 'a_position')
    gl.bindAttribLocation(compProgram, 1, 'a_texCoord')
    gl.linkProgram(compProgram)

    // FBO helper
    function makeFbo() {
      const tex = gl!.createTexture()!
      gl!.bindTexture(gl!.TEXTURE_2D, tex)
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, canvas.width, canvas.height, 0, gl!.RGBA, gl!.UNSIGNED_BYTE, null)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE)
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE)
      const fbo = gl!.createFramebuffer()!
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo)
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, tex, 0)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null)
      return { fbo, tex }
    }
    const accum1 = makeFbo()
    const accum2 = makeFbo()

    return {
      gl,
      program,
      textureA,
      textureB,
      intensityLoc: gl.getUniformLocation(program, 'u_intensity')!,
      decayLoc: gl.getUniformLocation(program, 'u_decay')!,
      blendLoc: gl.getUniformLocation(program, 'u_blend')!,
      echoLoc: gl.getUniformLocation(program, 'u_echo')!,
      compProgram,
      compBaseTex: textureA, // reuse for uploads
      compFbo: accum1.fbo,
      compAccumTex: accum1.tex,
      compFbo2: accum2.fbo,
      compAccumTex2: accum2.tex,
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

  const render = useCallback((intensity: number, decay: number, blend: number, echoMix: number = 0) => {
    const ctx = glRef.current
    if (!ctx) return
    const { gl } = ctx
    const canvas = canvasRef.current
    if (!canvas) return

    const activeLayers = layers && layers.length > 0 ? layers : null

    if (activeLayers && activeLayers.length > 1) {
      // ── Multi-track compositing ──
      // Pass 1: render bottom layer directly to accumulator FBO
      const bottom = activeLayers[0]
      const bottomA = bottom.frameA || imgRef.current
      if (!bottomA) return
      const bottomB = bottom.frameB || bottomA

      gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.compFbo)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(ctx.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, ctx.textureA)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bottomA)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, ctx.textureB)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bottomB)
      gl.uniform1f(ctx.intensityLoc, 0)
      gl.uniform1f(ctx.decayLoc, 0)
      gl.uniform1f(ctx.blendLoc, bottom.blendFactor)
      gl.uniform1f(ctx.echoLoc, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // Pass 2..N: composite each subsequent layer onto accumulator
      let readFbo = ctx.compFbo
      let readTex = ctx.compAccumTex
      let writeFbo = ctx.compFbo2
      let writeTex = ctx.compAccumTex2

      for (let i = 1; i < activeLayers.length; i++) {
        const layer = activeLayers[i]
        const layerA = layer.frameA
        if (!layerA) { /* skip empty layers — ping-pong so accumulator stays current */ const tmp = readFbo; readFbo = writeFbo; writeFbo = tmp; const tmpT = readTex; readTex = writeTex; writeTex = tmpT; continue }
        const layerB = layer.frameB || layerA

        gl.bindFramebuffer(gl.FRAMEBUFFER, writeFbo)
        gl.viewport(0, 0, canvas.width, canvas.height)
        gl.useProgram(ctx.compProgram)

        // unit 0 = accumulator (base)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, readTex)
        gl.uniform1i(gl.getUniformLocation(ctx.compProgram, 'u_base'), 0)

        // unit 1 = layer frame A
        gl.activeTexture(gl.TEXTURE1)
        gl.bindTexture(gl.TEXTURE_2D, ctx.textureA)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layerA)
        gl.uniform1i(gl.getUniformLocation(ctx.compProgram, 'u_layerA'), 1)

        // unit 2 = layer frame B
        gl.activeTexture(gl.TEXTURE2)
        gl.bindTexture(gl.TEXTURE_2D, ctx.textureB)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layerB)
        gl.uniform1i(gl.getUniformLocation(ctx.compProgram, 'u_layerB'), 2)

        gl.uniform1f(gl.getUniformLocation(ctx.compProgram, 'u_layerBlend'), layer.blendFactor)
        gl.uniform1f(gl.getUniformLocation(ctx.compProgram, 'u_opacity'), layer.opacity)
        gl.uniform1i(gl.getUniformLocation(ctx.compProgram, 'u_blendMode'), BLEND_MODE_MAP[layer.blendMode] ?? 0)
        gl.drawArrays(gl.TRIANGLES, 0, 6)

        // Ping-pong
        const tmp = readFbo; readFbo = writeFbo; writeFbo = tmp
        const tmpT = readTex; readTex = writeTex; writeTex = tmpT
      }

      // Final pass: draw composited result to screen with beat effects
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(ctx.program)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, readTex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, readTex) // same tex for both slots (no crossfade at this stage)
      gl.uniform1f(ctx.intensityLoc, intensity)
      gl.uniform1f(ctx.decayLoc, decay)
      gl.uniform1f(ctx.blendLoc, 0) // no crossfade, already composited
      gl.uniform1f(ctx.echoLoc, echoMix)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    } else {
      // ── Single-track (original path) ──
      const singleLayer = activeLayers?.[0]
      const sourceA = singleLayer?.frameA || transitionFrameA || imgRef.current
      if (!sourceA) return
      const sourceB = singleLayer?.frameB || transitionFrameB || sourceA
      const singleBlend = singleLayer?.blendFactor ?? blend

      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, ctx.textureA)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceA)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, ctx.textureB)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceB)
      gl.viewport(0, 0, canvas.width, canvas.height)
      gl.useProgram(ctx.program)
      gl.uniform1f(ctx.intensityLoc, intensity)
      gl.uniform1f(ctx.decayLoc, decay)
      gl.uniform1f(ctx.blendLoc, singleBlend)
      gl.uniform1f(ctx.echoLoc, echoMix)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  }, [transitionFrameA, transitionFrameB, layers])

  // Render loop when playing
  useEffect(() => {
    if (!isPlaying) {
      render(0, 0, blendFactor)
      return
    }

    const loop = () => {
      const { intensity, decay, echoIntensity } = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
      render(intensity, decay, blendFactor, echoIntensity)
      animRef.current = requestAnimationFrame(loop)
    }
    loop()

    return () => cancelAnimationFrame(animRef.current)
  }, [isPlaying, beats, audioEvents, userEffects, suppressions, currentTime, render, blendFactor])

  // Render on time changes when paused (seeking) or when frame/effects change
  useEffect(() => {
    if (isPlaying) return
    const { intensity, decay, echoIntensity } = findEffectIntensity(beats, audioEvents, userEffects, suppressions, currentTime)
    render(intensity, decay, blendFactor, echoIntensity)
  }, [currentTime, isPlaying, beats, audioEvents, userEffects, suppressions, render, transitionFrameA, transitionFrameB, blendFactor])

  return (
    <canvas
      ref={canvasRef}
      width={canvasWidth}
      height={canvasHeight}
      className={className}
    />
  )
})
