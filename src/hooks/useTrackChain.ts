import { useEffect, useRef, useState } from 'react'
import {
  buildTrackChain,
  type TrackChain,
  type TrackEffect,
  type TrackSend,
  type SendBus,
  SendBusGraph,
} from '@/lib/audio-graph'

/**
 * M13 task-47: React hook that keeps a `TrackChain` in sync with the
 * effect/send rows for a single audio track.
 *
 * Ownership:
 *   - The `AudioContext` is owned upstream (same instance as the streaming
 *     `useAudioMixer`); we accept it via the `ctx` arg so the two graphs
 *     can share nodes without contending over state.
 *   - The returned chain's `input` is the caller's attach point — wire
 *     `volume_gain.connect(chain.input)` after the hook returns a chain.
 *
 * Rebuild policy (R14):
 *   - Chain is rebuilt when the track's `effects` list identity changes
 *     (add/remove/reorder). Enable/disable toggles DO NOT rebuild — they
 *     call `chain.setEffectEnabled(id, enabled)` in place.
 *   - Send rows rebuild the chain too, since send taps are part of the
 *     chain's output fan-out. A future optimization is to rebuild only the
 *     sends fan-out; TODO(task-48).
 *
 * Returns `null` until the first build (e.g. during SSR or before the
 * parent has a ctx).
 *
 * TODO(task-52): the caller currently supplies `effects`/`sends`/`buses`
 * from local state; wire these to /api/track-effects + /api/track-sends +
 * /api/send-buses endpoints when they land.
 */
export function useTrackChain(
  ctx: AudioContext | null,
  trackId: string,
  effects: readonly TrackEffect[],
  sends: readonly TrackSend[],
  buses: readonly SendBus[],
  busGraph: SendBusGraph | null,
): TrackChain | null {
  const [chain, setChain] = useState<TrackChain | null>(null)
  const chainRef = useRef<TrackChain | null>(null)

  // Rebuild trigger: effects / sends / buses identity change. We detect
  // add/remove/reorder via a signature. Enable/disable toggles are handled
  // separately (below) without touching the chain's topology.
  const effectsSig = effects.map((e) => `${e.id}:${e.order_index}`).join('|')
  const sendsSig = sends.filter((s) => s.track_id === trackId).map((s) => `${s.bus_id}`).join('|')
  const busesSig = buses.map((b) => b.id).join('|')

  useEffect(() => {
    if (!ctx) return
    // Tear down the previous chain before rebuilding.
    chainRef.current?.dispose()
    const next = buildTrackChain(ctx, trackId, effects, sends, buses)
    // Connect send taps into the bus graph if provided.
    if (busGraph) {
      for (const [busId, g] of next.sends) busGraph.connectSend(busId, g)
    }
    chainRef.current = next
    setChain(next)
    return () => {
      // Guarded in case another effect cycle already replaced this chain.
      if (chainRef.current === next) {
        next.dispose()
        chainRef.current = null
        setChain(null)
      } else {
        next.dispose()
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, trackId, effectsSig, sendsSig, busesSig, busGraph])

  // Enabled-toggle path (R14/R15): apply in place without rebuilding.
  useEffect(() => {
    const c = chainRef.current
    if (!c) return
    for (const e of effects) {
      const chained = c.effects.find((ce) => ce.row.id === e.id)
      if (chained && chained.enabled !== e.enabled) {
        c.setEffectEnabled(e.id, e.enabled)
      }
    }
    // Intentionally compares against the `effects` array on each render —
    // the above signatures only cover structural changes, so enabled
    // flips fall through to this effect with a new `effects` reference.
  }, [effects])

  return chain
}
