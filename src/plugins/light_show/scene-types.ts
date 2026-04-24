/**
 * Shared scene types — kept separate so audio-reactive scenes and regular
 * scenes can both reference them without a circular import.
 */

import type { FixtureState } from './fixtures'

/**
 * Per-frame information a scene can consult. Always provided by the scene
 * runner; scenes that don't need audio can ignore it.
 */
export interface SceneContext {
  /** scenecraft main audio playhead (seconds). 0 if no audio loaded. */
  playheadTime: number
  /** Seconds since the most recent beat crossed by the playhead.
   *  Infinity if no beats exist or playhead is before the first beat. */
  beatAge: number
  /** Intensity value of the most recent beat (0..1-ish). 0 if none. */
  lastBeatIntensity: number
  /** Monotonic counter: how many beats have fired since the playhead was 0.
   *  Increments on each beat crossing; useful for scenes that step on beats. */
  beatIndex: number
  /** True if the scenecraft audio is currently playing. Scenes that want
   *  to pause animation when the timeline is paused can check this. */
  isPlaying: boolean
}

export interface SceneDef {
  id: string
  label: string
  /** Mutates ``states`` in place to reflect the scene at time ``t`` (seconds,
   *  scene-internal clock). ``context`` carries main-timeline playhead and
   *  beat info for audio-reactive scenes. */
  apply: (t: number, states: FixtureState[], context?: SceneContext) => void
}
