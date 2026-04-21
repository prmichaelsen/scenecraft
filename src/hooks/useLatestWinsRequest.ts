import { useEffect, useRef } from 'react'

/**
 * Latest-wins async request queue.
 *
 * When a new request arrives while a previous one is still in flight, the
 * previous request is aborted (via AbortSignal) and discarded. Only the most
 * recent request's result ever lands.
 *
 * Intended for scrub interactions — a user dragging the playhead emits many
 * frame requests per second; we only care about the position they stopped
 * at. Older requests are wasted work and cause stale-frame flicker if they
 * resolve out of order.
 *
 * Usage:
 *   const { request } = useLatestWinsRequest<number>()
 *   request(currentTime, (t, signal) => fetchScrubFrame(project, t, 85, signal)
 *     .then((bitmap) => setBitmap(bitmap))
 *     .catch(() => { /* aborted, ignore *\/ }))
 */
export function useLatestWinsRequest<TKey>() {
  const pending = useRef<AbortController | null>(null)

  // Abort any outstanding request when the owning component unmounts.
  useEffect(() => () => {
    pending.current?.abort()
    pending.current = null
  }, [])

  const request = (
    key: TKey,
    fn: (key: TKey, signal: AbortSignal) => Promise<void> | void,
  ): void => {
    pending.current?.abort()
    const controller = new AbortController()
    pending.current = controller

    try {
      const result = fn(key, controller.signal)
      if (result && typeof (result as Promise<void>).finally === 'function') {
        ;(result as Promise<void>).finally(() => {
          if (pending.current === controller) pending.current = null
        })
      } else {
        if (pending.current === controller) pending.current = null
      }
    } catch (err) {
      if (pending.current === controller) pending.current = null
      throw err
    }
  }

  return { request }
}
