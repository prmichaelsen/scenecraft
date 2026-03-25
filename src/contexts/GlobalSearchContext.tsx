import { createContext, useContext, useRef, useState, useEffect, useCallback } from 'react'
import type { ReactNode } from 'react'

type Subscriber = () => void

interface Store {
  values: Map<string, string>
  subscribers: Map<string, Set<Subscriber>>
}

const GlobalSearchContext = createContext<Store | null>(null)

export function GlobalSearchProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<Store>({
    values: new Map(),
    subscribers: new Map(),
  })
  return (
    <GlobalSearchContext.Provider value={storeRef.current}>
      {children}
    </GlobalSearchContext.Provider>
  )
}

export function useGlobalSearch(key: string): [string, (value: string) => void] {
  const store = useContext(GlobalSearchContext)
  if (!store) {
    throw new Error('useGlobalSearch must be used within a GlobalSearchProvider')
  }
  const [, setTick] = useState(0)

  useEffect(() => {
    if (!store.subscribers.has(key)) store.subscribers.set(key, new Set())
    const subscriber = () => setTick((t) => t + 1)
    store.subscribers.get(key)!.add(subscriber)
    return () => {
      store.subscribers.get(key)?.delete(subscriber)
    }
  }, [key, store])

  const query = store.values.get(key) ?? ''
  const setQuery = useCallback(
    (value: string) => {
      store.values.set(key, value)
      store.subscribers.get(key)?.forEach((fn) => fn())
    },
    [key, store],
  )

  return [query, setQuery]
}
