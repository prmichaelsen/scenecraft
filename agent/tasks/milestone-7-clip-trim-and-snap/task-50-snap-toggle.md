# Task 50: Snap Toggle Infrastructure

**Milestone**: [M7 — Clip Trim and Snap](../../milestones/milestone-7-clip-trim-and-snap.md)  
**Design**: [local.clip-trim-and-snap.md](../../design/local.clip-trim-and-snap.md)  
**Estimated Hours**: 2-3  
**Status**: Not Started  
**Dependencies**: Task 49 (Left-edge and modifiers)  

---

## Objective

Build the snap toggle infrastructure that Task 51 depends on. Snap is a global editor state (boolean) toggled via `s` keyboard shortcut and a magnet toolbar button, persisted to localStorage. This task does NOT implement the snap logic itself — only the plumbing to gate it.

---

## Steps

1. **Snap state store**:
   - Option A: small React context `SnapContext` with `{ enabled: boolean, toggle: () => void, setEnabled: (b) => void }`
   - Option B: Zustand/Jotai store if already in use; otherwise keep it local
   - Preferred: Context (matches existing patterns like `CurrentTimeContext`)
   - File: `src/components/editor/SnapContext.tsx`

2. **Initial value** (from localStorage):
   - Read `localStorage.getItem('scenecraft-snap-enabled')` on mount
   - If `'0'` → `false`
   - If `'1'` or absent → `true` (default ON)

3. **Persistence**:
   - On every `setEnabled` or `toggle`, write `'1'` or `'0'` to localStorage under the same key
   - Use a `useEffect` or inside the setter for immediate write

4. **Keyboard handler** in `Timeline.tsx` (near the existing `t` transform toggle at line 1804):
   - Add hotkey for `s`:
     - Bail if `ctrlKey || metaKey || shiftKey || altKey` held
     - Bail if `document.activeElement` is `INPUT`, `TEXTAREA`, or has `contentEditable === 'true'`
     - Call `toggle()` from `useSnap()`
     - Show toast via existing toast system: `"Snap: On"` or `"Snap: Off"`

5. **Toolbar button** next to the Transform T button (`Timeline.tsx:1969-1976`):
   - Component: new toolbar button using the `Magnet` icon from lucide-react
   - Pressed/active state when `snap.enabled === true` (same style as T button active state)
   - `onClick={() => snap.toggle()}`
   - `title="Snap (S)"` for tooltip

6. **Expose `useSnap` hook** from `SnapContext.tsx`:
   - `export function useSnap(): { enabled: boolean, toggle: () => void, setEnabled: (b: boolean) => void }`

7. **Wrap editor tree** with `<SnapProvider>` in the appropriate layout component (likely `EditorPanelLayout.tsx` or wherever existing contexts are stacked)

8. **Status bar indicator** (optional, nice-to-have): show a small magnet icon in the status bar when snap is ON, hidden when OFF

9. **Tests**:
   - `s` key toggles snap when not focused on text input
   - `s` key in an input field does NOT toggle (types the letter)
   - Toolbar button toggles
   - State persists across reload
   - Default ON for new users (no localStorage entry)

---

## Verification

- [ ] `SnapContext` and `useSnap` hook exported
- [ ] `s` key toggles snap with toast feedback
- [ ] `s` key does NOT toggle when typing in an input
- [ ] Magnet toolbar button appears next to T, correct active state
- [ ] localStorage persists on toggle, reads on mount
- [ ] Default ON when no localStorage entry
- [ ] Can disable snap and reload — stays disabled

---

**Next Task**: [Task 51: Snap targets + feedback](task-51-snap-targets.md)  
