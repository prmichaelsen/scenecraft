#!/usr/bin/env node
/**
 * Generate placeholder impulse response WAV files for M13 task-47.
 *
 * These are SYNTHETIC stand-ins: exponentially-decaying white noise with
 * per-preset decay time and low-pass character. They are audibly reasonable
 * as reverb IRs but are NOT sourced from real spaces. Replace with
 * CC-licensed or recorded IRs in a future task (see README.md).
 *
 * Run:  node src/assets/impulse_responses/generate.mjs
 *
 * Spec R53: total gzipped bundle should stay ≤ 200 KB; we use 22050 Hz /
 * 16-bit mono + short decay tails to keep individual files under ~40 KB.
 */
import { writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const SAMPLE_RATE = 22050

/** Build a mono 16-bit PCM WAV buffer from a Float32 signal in [-1, 1]. */
function encodeWav(signal) {
  const dataBytes = signal.length * 2
  const buf = Buffer.alloc(44 + dataBytes)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + dataBytes, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)            // PCM
  buf.writeUInt16LE(1, 22)            // 1 channel (mono)
  buf.writeUInt32LE(SAMPLE_RATE, 24)
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(dataBytes, 40)
  for (let i = 0; i < signal.length; i++) {
    const s = Math.max(-1, Math.min(1, signal[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

/** Deterministic PRNG (mulberry32) so IR bytes are reproducible across builds. */
function makeRng(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return (((t ^ (t >>> 14)) >>> 0) / 4294967296) * 2 - 1
  }
}

/** 1-pole IIR low-pass; higher `cutoffHz` = less filtering. */
function lowpass(signal, cutoffHz) {
  const a = Math.exp(-2 * Math.PI * cutoffHz / SAMPLE_RATE)
  const out = new Float32Array(signal.length)
  let y = 0
  for (let i = 0; i < signal.length; i++) {
    y = (1 - a) * signal[i] + a * y
    out[i] = y
  }
  return out
}

/** Synthesize a decaying-noise IR with pre-delay and LP shading. */
function synthIR({ decaySec, lpHz, preDelayMs, seed }) {
  const preDelay = Math.round(preDelayMs * SAMPLE_RATE / 1000)
  const bodyLen = Math.round(decaySec * SAMPLE_RATE)
  const total = preDelay + bodyLen
  const rng = makeRng(seed)
  const raw = new Float32Array(total)
  const k = Math.pow(0.001, 1 / bodyLen) // -60 dB over decaySec
  let env = 1
  for (let i = preDelay; i < total; i++) {
    raw[i] = rng() * env * 0.5
    env *= k
  }
  const filtered = lowpass(raw, lpHz)
  let peak = 0
  for (let i = 0; i < filtered.length; i++) {
    const a = Math.abs(filtered[i])
    if (a > peak) peak = a
  }
  if (peak > 0) {
    const g = 0.9 / peak
    for (let i = 0; i < filtered.length; i++) filtered[i] *= g
  }
  return filtered
}

const presets = [
  { name: 'room-small', decaySec: 0.35, lpHz: 4500, preDelayMs: 3, seed: 1 },
  { name: 'room-large', decaySec: 0.80, lpHz: 4200, preDelayMs: 8, seed: 2 },
  { name: 'hall',       decaySec: 1.80, lpHz: 3500, preDelayMs: 20, seed: 3 },
  { name: 'plate',      decaySec: 1.20, lpHz: 7000, preDelayMs: 0, seed: 4 },
  { name: 'spring',     decaySec: 0.60, lpHz: 5500, preDelayMs: 2, seed: 5 },
  { name: 'chamber',    decaySec: 1.00, lpHz: 4000, preDelayMs: 10, seed: 6 },
]

for (const p of presets) {
  const sig = synthIR(p)
  const wav = encodeWav(sig)
  const outPath = join(__dirname, `${p.name}.wav`)
  writeFileSync(outPath, wav)
  console.log(`wrote ${outPath}  ${wav.length} bytes (decay=${p.decaySec}s)`)
}
