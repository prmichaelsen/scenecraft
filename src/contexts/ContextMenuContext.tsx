import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type MenuItem =
  | {
      id: string
      label: string
      onClick?: () => void
      icon?: React.ComponentType<{ size?: number; className?: string }>
      shortcut?: string // display-only, e.g. "⌘K"
      disabled?: boolean
      danger?: boolean
      divider?: never
    }
  | { divider: true; id?: string; label?: never; onClick?: never }

type MenuState = {
  items: MenuItem[]
  x: number
  y: number
}

type ContextMenuValue = {
  show: (e: { clientX: number; clientY: number; preventDefault: () => void }, items: MenuItem[]) => void
  close: () => void
}

const ContextMenuContext = createContext<ContextMenuValue>({
  show: () => {},
  close: () => {},
})

export function useContextMenu(): ContextMenuValue {
  return useContext(ContextMenuContext)
}

const MENU_MIN_WIDTH = 180
const MENU_ITEM_HEIGHT = 28
const MENU_PADDING_Y = 4
const MENU_MAX_VIEWPORT_MARGIN = 8

/**
 * Estimated menu height given N items. Used for viewport-edge flipping.
 * Dividers are thinner than items; we over-estimate to stay conservative.
 */
function estimateMenuHeight(items: MenuItem[]): number {
  let h = MENU_PADDING_Y * 2
  for (const item of items) {
    h += 'divider' in item && item.divider ? 9 : MENU_ITEM_HEIGHT
  }
  return h
}

function clampToViewport(x: number, y: number, items: MenuItem[]): { x: number; y: number } {
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1920
  const vh = typeof window !== 'undefined' ? window.innerHeight : 1080
  const h = estimateMenuHeight(items)
  const w = MENU_MIN_WIDTH
  // Flip horizontally if menu would run off the right edge
  const fx = x + w + MENU_MAX_VIEWPORT_MARGIN > vw ? Math.max(MENU_MAX_VIEWPORT_MARGIN, x - w) : x
  // Flip vertically if menu would run off the bottom edge
  const fy = y + h + MENU_MAX_VIEWPORT_MARGIN > vh ? Math.max(MENU_MAX_VIEWPORT_MARGIN, y - h) : y
  return { x: fx, y: fy }
}

function MenuList({
  state,
  onClose,
}: {
  state: MenuState
  onClose: () => void
}) {
  const { items, x, y } = state
  const listRef = useRef<HTMLUListElement>(null)

  // Actionable (non-divider, non-disabled) indices for keyboard navigation
  const actionable = useMemo(
    () =>
      items
        .map((item, i) => ({ item, i }))
        .filter(({ item }) => !('divider' in item && item.divider) && !(item as { disabled?: boolean }).disabled)
        .map(({ i }) => i),
    [items],
  )

  const [focusedItemIdx, setFocusedItemIdx] = useState<number | null>(null)
  useEffect(() => {
    setFocusedItemIdx(actionable[0] ?? null)
  }, [actionable])

  // Close on Escape, arrow nav, Enter, outside click, scroll, window blur
  useEffect(() => {
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault()
        onClose()
        return
      }
      if (ev.key === 'ArrowDown') {
        ev.preventDefault()
        setFocusedItemIdx((cur) => {
          if (cur === null) return actionable[0] ?? null
          const pos = actionable.indexOf(cur)
          return actionable[(pos + 1) % actionable.length] ?? cur
        })
        return
      }
      if (ev.key === 'ArrowUp') {
        ev.preventDefault()
        setFocusedItemIdx((cur) => {
          if (cur === null) return actionable[actionable.length - 1] ?? null
          const pos = actionable.indexOf(cur)
          return actionable[(pos - 1 + actionable.length) % actionable.length] ?? cur
        })
        return
      }
      if (ev.key === 'Enter') {
        if (focusedItemIdx === null) return
        const item = items[focusedItemIdx]
        if (item && !('divider' in item && item.divider) && !item.disabled) {
          ev.preventDefault()
          item.onClick?.()
          onClose()
        }
      }
    }
    const onDocMouseDown = (ev: MouseEvent) => {
      if (listRef.current && !listRef.current.contains(ev.target as Node)) {
        onClose()
      }
    }
    const onScroll = () => onClose()
    const onBlur = () => onClose()

    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onDocMouseDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onDocMouseDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [actionable, focusedItemIdx, items, onClose])

  const { x: cx, y: cy } = useMemo(() => clampToViewport(x, y, items), [x, y, items])

  return (
    <ul
      ref={listRef}
      role="menu"
      className="fixed z-[100] bg-gray-900 border border-gray-700 rounded shadow-xl py-1 text-[12px] select-none"
      style={{ left: cx, top: cy, minWidth: MENU_MIN_WIDTH }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        if ('divider' in item && item.divider) {
          return <li key={item.id ?? `div-${i}`} role="separator" className="my-1 border-t border-gray-800" />
        }
        const Icon = item.icon
        const focused = focusedItemIdx === i
        const baseCls =
          'flex items-center gap-2 px-3 py-1 cursor-pointer whitespace-nowrap outline-none'
        const stateCls = item.disabled
          ? 'text-gray-600 cursor-not-allowed'
          : item.danger
            ? `${focused ? 'bg-red-600/40 text-red-100' : 'text-red-300 hover:bg-red-600/25'}`
            : `${focused ? 'bg-blue-600/40 text-gray-100' : 'text-gray-200 hover:bg-gray-800'}`
        return (
          <li
            key={item.id}
            role="menuitem"
            aria-disabled={item.disabled || undefined}
            tabIndex={-1}
            onMouseEnter={() => !item.disabled && setFocusedItemIdx(i)}
            onClick={(e) => {
              e.stopPropagation()
              if (item.disabled) return
              item.onClick?.()
              onClose()
            }}
            className={`${baseCls} ${stateCls}`}
          >
            {Icon ? (
              <span className="w-4 h-4 shrink-0 flex items-center justify-center">
                <Icon size={12} />
              </span>
            ) : (
              <span className="w-4 shrink-0" />
            )}
            <span className="flex-1 truncate">{item.label}</span>
            {item.shortcut ? (
              <span className="ml-4 text-[10px] text-gray-500 font-mono">{item.shortcut}</span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

export function ContextMenuProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<MenuState | null>(null)

  const close = useCallback(() => setState(null), [])

  const show = useCallback<ContextMenuValue['show']>((e, items) => {
    e.preventDefault()
    if (!items || items.length === 0) return
    setState({ items, x: e.clientX, y: e.clientY })
  }, [])

  const value = useMemo<ContextMenuValue>(() => ({ show, close }), [show, close])

  return (
    <ContextMenuContext.Provider value={value}>
      {children}
      {state && typeof document !== 'undefined'
        ? createPortal(<MenuList state={state} onClose={close} />, document.body)
        : null}
    </ContextMenuContext.Provider>
  )
}
