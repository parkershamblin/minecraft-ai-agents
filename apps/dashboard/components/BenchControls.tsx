'use client'

import { useEffect, useMemo, useState } from 'react'

import type { BenchCommandId, BenchCommandMeta, BenchField } from '@/lib/bench/catalog'
import type { BenchJobSnapshot } from '@/lib/bench/types'

type BenchApi = {
  catalog: BenchCommandMeta[]
  job: BenchJobSnapshot
}

function defaultOptions(meta: BenchCommandMeta): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const field of meta.fields) {
    if (field.defaultValue !== undefined) out[field.key] = field.defaultValue
  }
  if (!out.label && (meta.id === 'race' || meta.id === 'race:practice' || meta.id === 'drill')) {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')
    out.label = `${meta.id.replace(':', '-')}-${stamp}`
  }
  return out
}

function FieldInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: BenchField
  value: unknown
  onChange: (v: unknown) => void
  disabled: boolean
}) {
  const base =
    'w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 disabled:opacity-50'

  if (field.kind === 'checkbox') {
    return (
      <label className="flex items-center gap-2 text-xs text-zinc-300">
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-zinc-600"
        />
        {field.label}
        {field.help && <span className="text-zinc-500">· {field.help}</span>}
      </label>
    )
  }

  if (field.kind === 'select') {
    return (
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">{field.label}</span>
        <select
          className={base}
          disabled={disabled}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(field.options ?? []).map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>
    )
  }

  if (field.kind === 'number') {
    return (
      <label className="block space-y-1">
        <span className="text-[11px] uppercase tracking-wide text-zinc-500">{field.label}</span>
        <input
          type="number"
          className={base}
          disabled={disabled}
          min={field.min}
          max={field.max}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      </label>
    )
  }

  return (
    <label className="block space-y-1">
      <span className="text-[11px] uppercase tracking-wide text-zinc-500">{field.label}</span>
      <input
        type="text"
        className={base}
        disabled={disabled}
        value={String(value ?? '')}
        placeholder={field.help}
        onChange={(e) => onChange(e.target.value)}
      />
      {field.help && field.kind === 'path' && <p className="text-[11px] text-zinc-500">{field.help}</p>}
    </label>
  )
}

export function BenchControls({ compact }: { compact?: boolean }) {
  const [catalog, setCatalog] = useState<BenchCommandMeta[]>([])
  const [commandId, setCommandId] = useState<BenchCommandId>('race')
  const [options, setOptions] = useState<Record<string, unknown>>({})
  const [job, setJob] = useState<BenchJobSnapshot | null>(null)
  const [logs, setLogs] = useState<string[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [bootError, setBootError] = useState<string | null>(null)

  const meta = useMemo(() => catalog.find((c) => c.id === commandId) ?? null, [catalog, commandId])
  const running = job?.status === 'running'

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/bench')
        if (!res.ok) throw new Error(`bench status ${res.status}`)
        const data = (await res.json()) as BenchApi
        if (cancelled) return
        setCatalog(data.catalog)
        setJob(data.job)
        setLogs(data.job.recentLogs)
        const first = data.catalog[0]
        if (first) {
          setCommandId(first.id)
          setOptions(defaultOptions(first))
        }
      } catch (err) {
        if (!cancelled) setBootError(String(err))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const es = new EventSource('/api/bench/stream')
    es.onopen = () => setLogs([])
    es.addEventListener('log', (ev) => {
      try {
        const { line } = JSON.parse((ev as MessageEvent).data) as { line: string }
        setLogs((prev) => {
          const next = [...prev, line]
          return next.length > 800 ? next.slice(-800) : next
        })
      } catch {
        /* ignore */
      }
    })
    es.addEventListener('status', (ev) => {
      try {
        setJob(JSON.parse((ev as MessageEvent).data) as BenchJobSnapshot)
      } catch {
        /* ignore */
      }
    })
    es.onerror = () => {
      /* browser will retry */
    }
    return () => es.close()
  }, [])

  const selectCommand = (id: BenchCommandId) => {
    setCommandId(id)
    const next = catalog.find((c) => c.id === id)
    if (next) setOptions(defaultOptions(next))
    setMessage(null)
  }

  const start = async () => {
    setMessage(null)
    setLogs([])
    const res = await fetch('/api/bench', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: commandId, options }),
    })
    const data = await res.json()
    if (!res.ok) {
      setMessage(data.error || `start failed (${res.status})`)
      return
    }
    setJob(data.job)
    setMessage(`started ${commandId}`)
  }

  const cancel = async () => {
    const res = await fetch('/api/bench', { method: 'DELETE' })
    const data = await res.json()
    if (!res.ok) {
      setMessage(data.error || `cancel failed (${res.status})`)
      return
    }
    setJob(data.job)
    setMessage('cancel requested')
  }

  if (bootError) {
    return (
      <p className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm text-red-300">
        Bench controls unavailable: {bootError}
      </p>
    )
  }

  if (!meta) {
    return <p className="text-sm text-zinc-500">Loading bench controls…</p>
  }

  const statusColor =
    job?.status === 'running'
      ? 'text-amber-300'
      : job?.status === 'succeeded'
        ? 'text-emerald-300'
        : job?.status === 'failed' || job?.status === 'cancelled'
          ? 'text-rose-300'
          : 'text-zinc-400'

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-zinc-200">Benchmarks & races</h3>
        <p className={`text-xs ${statusColor}`}>
          {job?.status ?? 'idle'}
          {job?.command ? ` · ${job.command}` : ''}
          {job?.pid ? ` · pid ${job.pid}` : ''}
        </p>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Runs <code className="text-zinc-400">scripts/civ-bench.mjs</code> on this host (same as{' '}
        <code className="text-zinc-400">npm run race</code>). Mission Control lights up from{' '}
        <code className="text-zinc-400">AttemptStarted</code>.
      </p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {catalog.map((cmd) => (
          <button
            key={cmd.id}
            type="button"
            disabled={running}
            onClick={() => selectCommand(cmd.id)}
            className={`rounded-lg px-2.5 py-1 text-[11px] disabled:cursor-not-allowed disabled:opacity-40 ${
              cmd.id === commandId
                ? 'bg-sky-900/70 text-sky-100 ring-1 ring-sky-700'
                : 'border border-zinc-700 bg-zinc-800 text-zinc-300'
            }`}
          >
            {cmd.title}
          </button>
        ))}
      </div>

      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
        <p className="text-xs text-zinc-300">{meta.summary}</p>
        <p className="mt-1 text-[11px] text-zinc-500">
          needs: {meta.needs} · {meta.durationHint}
        </p>

        {meta.fields.length > 0 && (
          <div className={`mt-3 grid gap-3 ${compact ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
            {meta.fields.map((field) => (
              <FieldInput
                key={field.key}
                field={field}
                value={options[field.key]}
                disabled={running}
                onChange={(v) => setOptions((prev) => ({ ...prev, [field.key]: v }))}
              />
            ))}
          </div>
        )}

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={running}
            onClick={() => void start()}
            className="rounded-lg bg-sky-800 px-3 py-1.5 text-xs font-medium text-sky-50 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Start {meta.id}
          </button>
          <button
            type="button"
            disabled={!running}
            onClick={() => void cancel()}
            className="rounded-lg border border-rose-900/60 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-100 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          {(job?.status === 'succeeded' || job?.status === 'failed') && (
            <a
              href="/mission-control"
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
            >
              Open Mission Control →
            </a>
          )}
        </div>
      </div>

      {message && <p className="mt-2 text-xs text-zinc-400">{message}</p>}
      {job?.error && job.status !== 'running' && (
        <p className="mt-1 text-xs text-rose-300">{job.error}</p>
      )}

      <pre className="mt-3 max-h-72 overflow-auto rounded-lg border border-zinc-800 bg-black/60 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
        {logs.length ? logs.join('\n') : 'Logs appear here when a job runs…'}
      </pre>
    </div>
  )
}
