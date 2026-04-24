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

export const VARIANT_KIND_COLORS: Record<string, string> = {
  music: 'bg-purple-500/70 border-purple-400',
  lipsync: 'bg-teal-500/70 border-teal-400',
}

export const DEFAULT_CLIP_COLOR = 'bg-blue-500/70 border-blue-400'

export function getClipColorClass(variantKind: string | null | undefined): string {
  if (variantKind && VARIANT_KIND_COLORS[variantKind]) {
    return VARIANT_KIND_COLORS[variantKind]
  }
  return DEFAULT_CLIP_COLOR
}
