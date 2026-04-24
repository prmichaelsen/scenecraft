/**
 * Centralized variant_kind → color map for audio clips on the timeline.
 *
 * Introduced by M18 (foley=orange). M16 task-134 will add music=purple
 * when it ships. Consumed by AudioLane and any other component that
 * renders clip blocks.
 *
 * Returns Tailwind class fragments (bg-*, border-*, ring-*, text-*) as
 * an object — caller merges them into className strings.
 */

export type ClipColorScheme = {
  bg: string
  bgHover: string
  border: string
  borderSelected: string
  ring: string
  text: string
  waveform: string
}

const FOLEY: ClipColorScheme = {
  bg: 'bg-orange-900/30',
  bgHover: 'hover:bg-orange-900/50',
  border: 'border-orange-700/60',
  borderSelected: 'border-orange-300',
  ring: 'ring-orange-300/60',
  text: 'text-orange-100',
  waveform: 'text-orange-400',
}

const MUSIC: ClipColorScheme = {
  bg: 'bg-purple-900/30',
  bgHover: 'hover:bg-purple-900/50',
  border: 'border-purple-700/60',
  borderSelected: 'border-purple-300',
  ring: 'ring-purple-300/60',
  text: 'text-purple-100',
  waveform: 'text-purple-400',
}

const LIPSYNC: ClipColorScheme = {
  bg: 'bg-teal-900/30',
  bgHover: 'hover:bg-teal-900/50',
  border: 'border-teal-700/60',
  borderSelected: 'border-teal-300',
  ring: 'ring-teal-300/60',
  text: 'text-teal-100',
  waveform: 'text-teal-400',
}

const DEFAULT: ClipColorScheme = {
  bg: 'bg-cyan-900/30',
  bgHover: 'hover:bg-cyan-900/50',
  border: 'border-cyan-700/60',
  borderSelected: 'border-cyan-300',
  ring: 'ring-cyan-300/60',
  text: 'text-cyan-100',
  waveform: 'text-cyan-400',
}

const VARIANT_KIND_MAP: Record<string, ClipColorScheme> = {
  foley: FOLEY,
  music: MUSIC,
  lipsync: LIPSYNC,
}

export function getClipColorScheme(variantKind?: string | null): ClipColorScheme {
  if (variantKind && variantKind in VARIANT_KIND_MAP) {
    return VARIANT_KIND_MAP[variantKind]
  }
  return DEFAULT
}
