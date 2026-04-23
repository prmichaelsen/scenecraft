/**
 * IsolateVocalsRunForm — inline Run form hosted inside AudioIsolationsPanel.
 *
 * No modal, no confirm step on the UI side: the panel's Run button kicks off
 * the DFN3 job immediately (chat tool is the surface that keeps elicitation).
 * The form lets the user pick full-source vs. a trim subset, displays the
 * model + ETA, and forwards kickoff to `callIsolateVocals`.
 */

import { useState } from 'react'

import {
  callIsolateVocals,
  type EntityType,
  type IsolateKickoff,
} from './isolate-vocals-client'

export type RunFormEntity = {
  type: EntityType
  id: string
  durationSeconds?: number
  label?: string
}

export type IsolateVocalsRunFormProps = {
  entity: RunFormEntity
  projectName: string
  onStart?: (kickoff: IsolateKickoff) => void
}

export function IsolateVocalsRunForm({
  entity,
  projectName,
  onStart,
}: IsolateVocalsRunFormProps) {
  const [rangeMode, setRangeMode] = useState<'full' | 'subset'>('full')
  const [trimIn, setTrimIn] = useState<number | ''>('')
  const [trimOut, setTrimOut] = useState<number | ''>('')
  const [running, setRunning] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const totalDur = entity.durationSeconds ?? 0
  const activeDur =
    rangeMode === 'full'
      ? totalDur
      : Math.max(0, (Number(trimOut) || totalDur) - (Number(trimIn) || 0))
  const etaLow = Math.max(1, Math.ceil(activeDur * 1.0))
  const etaHigh = Math.max(2, Math.ceil(activeDur * 2.0))

  const onRun = async () => {
    setRunning(true)
    setErr(null)
    try {
      const kickoff = await callIsolateVocals(projectName, {
        entity_type: entity.type,
        entity_id: entity.id,
        range_mode: rangeMode,
        trim_in:
          rangeMode === 'subset' && trimIn !== '' ? Number(trimIn) : undefined,
        trim_out:
          rangeMode === 'subset' && trimOut !== ''
            ? Number(trimOut)
            : undefined,
      })
      onStart?.(kickoff)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setErr(msg)
    } finally {
      setRunning(false)
    }
  }

  return (
    <fieldset className="p-3 border border-gray-700 rounded space-y-2">
      <legend className="text-xs text-gray-400">New isolation</legend>

      <div className="flex gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={rangeMode === 'full'}
            onChange={() => setRangeMode('full')}
          />
          Full source
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            checked={rangeMode === 'subset'}
            onChange={() => setRangeMode('subset')}
          />
          Subset
        </label>
      </div>

      {rangeMode === 'subset' && (
        <div className="flex gap-2 text-xs">
          <input
            type="number"
            placeholder="in (s)"
            aria-label="trim in (seconds)"
            value={trimIn}
            onChange={(e) =>
              setTrimIn(e.target.value === '' ? '' : Number(e.target.value))
            }
            className="w-20 bg-gray-800 rounded px-1"
          />
          <input
            type="number"
            placeholder="out (s)"
            aria-label="trim out (seconds)"
            value={trimOut}
            onChange={(e) =>
              setTrimOut(e.target.value === '' ? '' : Number(e.target.value))
            }
            className="w-20 bg-gray-800 rounded px-1"
          />
        </div>
      )}

      <div className="text-[11px] text-gray-500">
        Model: DeepFilterNet3 · ~{etaLow}–{etaHigh}s on CPU · Outputs: vocal +
        background stems
      </div>

      {err && <div className="text-xs text-red-400">{err}</div>}

      <div className="flex justify-end">
        <button
          onClick={onRun}
          disabled={running}
          className="px-3 py-1 text-sm rounded bg-amber-700 hover:bg-amber-600 disabled:opacity-50 text-white"
        >
          {running ? 'Starting…' : 'Run'}
        </button>
      </div>
    </fieldset>
  )
}
