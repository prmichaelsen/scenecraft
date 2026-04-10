/**
 * Hotkey registry — maps action names to key bindings and handler factories.
 *
 * For now this is a simple JS object. In the future, users will be able to
 * remap keys via a settings UI that reads/writes this registry.
 *
 * Each entry defines:
 * - `key`: the keyboard key (KeyboardEvent.key or KeyboardEvent.code)
 * - `code`: optional KeyboardEvent.code for keys where .key is ambiguous
 * - `ctrl`: requires Ctrl/Cmd
 * - `shift`: requires Shift
 * - `alt`: requires Alt
 * - `preventDefault`: whether to call e.preventDefault()
 */

export type HotkeyBinding = {
  key?: string
  code?: string
  ctrl?: boolean
  shift?: boolean
  alt?: boolean
  preventDefault?: boolean
}

export type HotkeyAction = {
  id: string
  label: string
  binding: HotkeyBinding
}

export const HOTKEYS: Record<string, HotkeyAction> = {
  playPause: {
    id: 'playPause',
    label: 'Play / Pause',
    binding: { code: 'Space', preventDefault: true },
  },
  toggleTransformMode: {
    id: 'toggleTransformMode',
    label: 'Toggle Transform Mode',
    binding: { key: 't' },
  },
  nextKeyframe: {
    id: 'nextKeyframe',
    label: 'Next Keyframe',
    binding: { key: 'ArrowRight', preventDefault: true },
  },
  prevKeyframe: {
    id: 'prevKeyframe',
    label: 'Previous Keyframe',
    binding: { key: 'ArrowLeft', preventDefault: true },
  },
  delete: {
    id: 'delete',
    label: 'Delete Selected',
    binding: { key: 'Delete' },
  },
  deleteAlt: {
    id: 'deleteAlt',
    label: 'Delete Selected (Backspace)',
    binding: { key: 'Backspace' },
  },
  copy: {
    id: 'copy',
    label: 'Copy',
    binding: { key: 'c', ctrl: true, preventDefault: true },
  },
  paste: {
    id: 'paste',
    label: 'Paste',
    binding: { key: 'v', ctrl: true, preventDefault: true },
  },
  selectAll: {
    id: 'selectAll',
    label: 'Select All',
    binding: { key: 'a', ctrl: true, preventDefault: true },
  },
  undo: {
    id: 'undo',
    label: 'Undo',
    binding: { key: 'z', ctrl: true, preventDefault: true },
  },
  nextCurvePin: {
    id: 'nextCurvePin',
    label: 'Next Curve Pin',
    binding: { key: ']' },
  },
  prevCurvePin: {
    id: 'prevCurvePin',
    label: 'Previous Curve Pin',
    binding: { key: '[' },
  },
}

/** Check if a KeyboardEvent matches a hotkey binding */
export function matchesBinding(e: KeyboardEvent, binding: HotkeyBinding): boolean {
  if (binding.code && e.code !== binding.code) return false
  if (binding.key && e.key.toLowerCase() !== binding.key.toLowerCase()) return false
  if (!binding.code && !binding.key) return false
  if (binding.ctrl && !(e.ctrlKey || e.metaKey)) return false
  if (!binding.ctrl && (e.ctrlKey || e.metaKey) && !binding.code) return false
  if (binding.shift && !e.shiftKey) return false
  if (binding.alt && !e.altKey) return false
  return true
}

/** Check if a KeyboardEvent matches a named hotkey action */
export function matchesHotkey(e: KeyboardEvent, actionId: string): boolean {
  const action = HOTKEYS[actionId]
  if (!action) return false
  return matchesBinding(e, action.binding)
}

/** If the matched binding has preventDefault, call it */
export function handlePreventDefault(e: KeyboardEvent, actionId: string): void {
  const action = HOTKEYS[actionId]
  if (action?.binding.preventDefault) e.preventDefault()
}
