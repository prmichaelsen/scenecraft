/**
 * Clip color mapping by `pool_segments.variant_kind`.
 *
 * variant_kind is an optional classifier on the underlying pool_segment;
 * it stays null for regular user-imported audio and is set by plugins
 * that generate or transform audio:
 *   - 'music'    — M16 generate_music (purple)
 *   - 'lipsync'  — M13 audio-sync (teal) — reserved, lands with M13
 *
 * Styling lives off the variant kind (not the drop path) so the same
 * color fires whether a clip was created by drag-drop, chat tool, or
 * any other future surface — the data determines the UI, not the event.
 */

export type ClipColors = {
  bg: string
  bgHover: string
  borderDefault: string
  borderSelected: string
}

const VARIANT_KIND_COLORS: Record<string, ClipColors> = {
  music: {
    bg: 'bg-purple-900/30',
    bgHover: 'hover:bg-purple-900/50',
    borderDefault: 'border-purple-700/60',
    borderSelected: 'border-purple-300',
  },
  lipsync: {
    bg: 'bg-teal-900/30',
    bgHover: 'hover:bg-teal-900/50',
    borderDefault: 'border-teal-700/60',
    borderSelected: 'border-teal-300',
  },
}

const DEFAULT_CLIP_COLORS: ClipColors = {
  bg: 'bg-cyan-900/30',
  bgHover: 'hover:bg-cyan-900/50',
  borderDefault: 'border-cyan-700/60',
  borderSelected: 'border-cyan-300',
}

export function getClipColors(variantKind: string | null | undefined): ClipColors {
  if (variantKind && VARIANT_KIND_COLORS[variantKind]) {
    return VARIANT_KIND_COLORS[variantKind]
  }
  return DEFAULT_CLIP_COLORS
}
