/**
 * Audio-thread analyzer for level + low-band flux.
 *
 * Runs as an AudioWorkletProcessor — registered once per AudioContext,
 * loaded by the panel via Vite's `?url` static-asset import. Connected
 * downstream of the master AnalyserNode and the mic source so it sees
 * the same signal the panel's existing FFT path sees, but on the
 * dedicated audio thread that browsers do NOT throttle when the tab
 * is unfocused / occluded.
 *
 * For each audio quantum (128 samples by default):
 *   - sum-of-squares of the raw signal (overall RMS)
 *   - sum-of-squares of a 1-pole IIR low-pass at 150Hz cutoff (kick band)
 *
 * Once we've accumulated ~23ms of audio (1024 samples at 44.1kHz, 8
 * quanta), emit a metric snapshot via this.port:
 *   { rms, lowRms, flux }
 * where ``flux`` is the rectified delta of lowRms vs. the previous
 * snapshot — the same "rate of change in kick band" signal the
 * spectral-flux FFT path computed, but built from the time-domain
 * filtered envelope so we don't need an FFT in worklet scope.
 *
 * The processor returns ``true`` from process() so the runtime keeps
 * us alive even when no upstream node is feeding samples (analyser
 * outputs are usually silent if nothing's connected to destination,
 * but the AudioWorklet runs unconditionally as long as the context
 * is running).
 */

const LOW_CUTOFF_HZ = 150
const FRAMES_PER_SNAPSHOT = 1024  // ~23ms at 44.1kHz, ~21ms at 48kHz

class AudioMonitorProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    // 1-pole IIR low-pass state (filter memory, persists across quanta)
    this._lpY = 0
    // Per-snapshot accumulators
    this._sumSq = 0
    this._sumSqLow = 0
    this._n = 0
    // Last snapshot's lowRms, used to compute flux as rectified delta
    this._lastLow = 0
    // Pre-compute the IIR coefficient. ``sampleRate`` is the global the
    // AudioWorklet runtime exposes — guaranteed valid in this scope.
    this._alpha = 1 - Math.exp(-2 * Math.PI * LOW_CUTOFF_HZ / sampleRate)
  }

  process(inputs) {
    // inputs[0] is the first input port; [0] is the first channel.
    // If nothing's connected upstream we still get an empty input and
    // should return true to stay alive.
    const input = inputs[0]
    const ch = input && input[0]
    if (ch && ch.length) {
      const a = this._alpha
      let lp = this._lpY
      let sumSq = this._sumSq
      let sumSqLow = this._sumSqLow
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i]
        sumSq += x * x
        // y[n] = a*x[n] + (1-a)*y[n-1]
        lp = a * x + (1 - a) * lp
        sumSqLow += lp * lp
      }
      this._lpY = lp
      this._sumSq = sumSq
      this._sumSqLow = sumSqLow
      this._n += ch.length
    }

    if (this._n >= FRAMES_PER_SNAPSHOT) {
      const rms = Math.sqrt(this._sumSq / this._n)
      const lowRms = Math.sqrt(this._sumSqLow / this._n)
      // Flux = rectified positive delta. Same shape as the FFT-based
      // spectral flux signal the panel's onset detector consumes.
      const flux = Math.max(0, lowRms - this._lastLow)
      this._lastLow = lowRms
      this.port.postMessage({ rms, lowRms, flux })
      this._sumSq = 0
      this._sumSqLow = 0
      this._n = 0
    }
    return true
  }
}

registerProcessor('audio-monitor', AudioMonitorProcessor)
