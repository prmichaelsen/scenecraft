/**
 * Timeline lane for the light_show plugin.
 *
 * Renders each row in ``light_show__scene_placements`` as a colored bar
 * positioned by ``start_time`` / ``end_time``, labeled with the bound
 * scene's label, and tagged on a 4-color palette derived from the
 * placement id so the same placement keeps the same color across
 * re-renders. Subscribes to ``light_show__changed`` over WS so chat-
 * driven mutations land within ~50ms instead of waiting for a poll.
 *
 * Rendering is purely visual: clicks don't currently mutate placements
 * — that path stays via MCP tools and the LightShow3D panel for now.
 * The whole component fits the M17 ``TrackTypeContribution`` shape so
 * the editor's Timeline doesn't need to know about light_show.
 */

import { useEffect, useState, useMemo } from 'react'
import { subscribePluginEvent } from '@/hooks/useScenecraftSocket'
import type { TrackRendererProps } from '@/lib/plugin-host'
import {
  fetchScenes,
  fetchPlacements,
  fetchLiveOverride,
  type SceneRow,
  type PlacementRow,
  type LiveOverrideRow,
} from './light-show-client'

// Stable per-placement color so the same bar reads the same across
// frames. Hash the id to a palette index. Palette tuned for legibility
// against the dark timeline background.
const PALETTE = [
  'bg-purple-700/80 border-purple-400',
  'bg-cyan-700/80 border-cyan-400',
  'bg-amber-700/80 border-amber-400',
  'bg-rose-700/80 border-rose-400',
  'bg-emerald-700/80 border-emerald-400',
  'bg-indigo-700/80 border-indigo-400',
]

function _hashColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0
  return PALETTE[Math.abs(h) % PALETTE.length]
}

export function LightShowTrack({
  pxPerSec,
  scrollLeft,
  viewportWidth,
  currentTime,
  projectName,
}: TrackRendererProps) {
  const [scenes, setScenes] = useState<SceneRow[]>([])
  const [placements, setPlacements] = useState<readonly PlacementRow[]>([])
  const [live, setLive] = useState<LiveOverrideRow>({ active: false })
  // Map keyed by id for O(1) label lookup when rendering bars.
  const sceneById = useMemo(() => new Map(scenes.map((s) => [s.id, s])), [scenes])

  // Fetch + subscribe. Same pattern as LightShow3DPanel: initial fetch on
  // mount, refetch on the plugin's WS 'changed' event. No polling — the
  // event coverage handles every mutation surface (REST, MCP, chat).
  useEffect(() => {
    if (!projectName) return
    let cancelled = false
    const refresh = async () => {
      try {
        const [sceneRes, placementRes, liveRow] = await Promise.all([
          fetchScenes(projectName),
          fetchPlacements(projectName),
          fetchLiveOverride(projectName),
        ])
        if (cancelled) return
        setScenes(sceneRes.scenes)
        setPlacements(placementRes.placements)
        setLive(liveRow)
      } catch (e) {
        // Silent — the panel surfaces error state already; the lane just
        // shows whatever we last had.
        console.warn('[LightShowTrack] refresh failed:', e)
      }
    }
    void refresh()
    const unsub = subscribePluginEvent('light_show', 'changed', (msg) => {
      if (msg.projectName === projectName) void refresh()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [projectName])

  // Viewport culling: skip placements wholly outside the visible window
  // so a 10k-placement project stays cheap. BUFFER_PX adds a margin so
  // bars at the edge transition in smoothly during scroll.
  const BUFFER_PX = 200
  const visibleStart = Math.max(0, (scrollLeft - BUFFER_PX) / pxPerSec)
  const visibleEnd = (scrollLeft + viewportWidth + BUFFER_PX) / pxPerSec

  // Identify which placement (if any) is currently driving the timeline
  // layer at the playhead. Highest display_order wins, ties broken by
  // oldest created_at — same rule as the scene evaluator.
  const activePlacementId = useMemo(() => {
    let best: PlacementRow | null = null
    for (const p of placements) {
      if (p.start_time > currentTime || currentTime > p.end_time) continue
      if (!best) { best = p; continue }
      if (p.display_order > best.display_order) best = p
      else if (p.display_order === best.display_order && p.created_at < best.created_at) best = p
    }
    return best?.id ?? null
  }, [placements, currentTime])

  return (
    <div className="absolute inset-0">
      {placements.map((p) => {
        if (p.end_time < visibleStart || p.start_time > visibleEnd) return null
        const left = p.start_time * pxPerSec
        const width = Math.max(2, (p.end_time - p.start_time) * pxPerSec)
        const scene = sceneById.get(p.scene_id)
        const label = scene?.label ?? p.scene_id.slice(0, 8)
        const isActive = p.id === activePlacementId
        const color = _hashColor(p.id)
        return (
          <div
            key={p.id}
            className={`absolute top-1 bottom-1 rounded border ${color} ${isActive ? 'ring-2 ring-white/70 z-10' : ''} overflow-hidden`}
            style={{ left, width }}
            title={`${label} (${p.start_time.toFixed(2)}s → ${p.end_time.toFixed(2)}s)`}
          >
            <div className="px-1 py-0.5 text-[10px] text-white/90 truncate font-medium">
              {label}
            </div>
            {/* Fade-in / fade-out shading so the envelope is visible at a glance */}
            {p.fade_in_sec > 0 && (
              <div
                className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-black/50 to-transparent pointer-events-none"
                style={{ width: Math.min(width, p.fade_in_sec * pxPerSec) }}
              />
            )}
            {p.fade_out_sec > 0 && (
              <div
                className="absolute top-0 bottom-0 right-0 bg-gradient-to-l from-black/50 to-transparent pointer-events-none"
                style={{ width: Math.min(width, p.fade_out_sec * pxPerSec) }}
              />
            )}
          </div>
        )
      })}

      {/* Live override indicator: persistent strip along the bottom of
          the lane while a live override is active. Doesn't have a
          start/end time so it's drawn full-width with a distinct color. */}
      {live.active && (
        <div
          className="absolute bottom-0 left-0 right-0 h-1.5 bg-red-500/70 border-t border-red-300/80"
          title={`LIVE: ${live.label || live.scene_id || 'inline'}`}
        />
      )}
    </div>
  )
}
