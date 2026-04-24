import { type RefObject, useEffect } from 'react'

/**
 * Mirror `scrollTop` between two scrollable containers. Used by the timeline's
 * split-column layout so the left headers column and the right content
 * scroller stay aligned vertically regardless of which one the user scrolls.
 *
 * Semantics:
 *   - Either ref scrolling updates the other, guarded against re-entry so
 *     the mirror write doesn't echo back as a fresh scroll event.
 *   - Horizontal axis is NOT mirrored — only the right container scrolls
 *     horizontally, and that is intentional.
 *   - Safe if either ref is null (no-op until both are attached).
 */
export function useVerticalScrollSync(
  a: RefObject<HTMLElement | null>,
  b: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const elA = a.current
    const elB = b.current
    if (!elA || !elB) return

    // Re-entry guard — programmatic scrollTop write fires a fresh scroll
    // event, which without this flag would bounce back and create a loop.
    let syncing = false

    const onA = () => {
      if (syncing) return
      syncing = true
      elB.scrollTop = elA.scrollTop
      queueMicrotask(() => { syncing = false })
    }
    const onB = () => {
      if (syncing) return
      syncing = true
      elA.scrollTop = elB.scrollTop
      queueMicrotask(() => { syncing = false })
    }

    elA.addEventListener('scroll', onA, { passive: true })
    elB.addEventListener('scroll', onB, { passive: true })
    return () => {
      elA.removeEventListener('scroll', onA)
      elB.removeEventListener('scroll', onB)
    }
  }, [a, b])
}
