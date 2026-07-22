// Prometheus HTTP API client, proxied same-origin via /api/prometheus
// (next.config.ts rewrite — no CORS, matching the repo's BFF convention).

export interface PromSample {
  metric: Record<string, string>
  value: [number, string]
}

export interface PromSeries {
  metric: Record<string, string>
  values: [number, string][]
}

async function promFetch<T>(path: string, params: Record<string, string>, signal?: AbortSignal): Promise<T> {
  const qs = new URLSearchParams(params).toString()
  const response = await fetch(`/api/prometheus/api/v1/${path}?${qs}`, { signal })
  if (!response.ok) {
    throw new Error(`prometheus ${response.status}`)
  }
  const body = await response.json()
  if (body.status !== 'success') {
    throw new Error(`prometheus query failed: ${body.error ?? 'unknown'}`)
  }
  return body.data.result as T
}

export function promQuery(query: string, signal?: AbortSignal): Promise<PromSample[]> {
  return promFetch<PromSample[]>('query', { query }, signal)
}

export function promRange(
  query: string,
  start: number,
  end: number,
  step: number,
  signal?: AbortSignal,
): Promise<PromSeries[]> {
  return promFetch<PromSeries[]>('query_range', {
    query,
    start: String(start),
    end: String(end),
    step: String(step),
  }, signal)
}

export async function probePrometheus(): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 3000)
  try {
    await promQuery('up', controller.signal)
    return true
  } finally {
    clearTimeout(timeout)
  }
}

// Resample one Prometheus matrix series onto n evenly spaced points across
// [start, end]. Gap policy is explicit: last-observed carry-forward, and 0
// before the first sample — path() must never see NaN or holes (Prometheus
// staleness gaps would otherwise draw spikes to the chart floor).
export function resample(values: [number, string][], n: number, start: number, end: number): number[] {
  const out: number[] = []
  let idx = 0
  let last = 0
  let seen = false
  for (let i = 0; i < n; i++) {
    const t = start + (i / (n - 1)) * (end - start)
    while (idx < values.length && values[idx][0] <= t) {
      const v = Number(values[idx][1])
      if (Number.isFinite(v)) {
        last = v
        seen = true
      }
      idx++
    }
    out.push(seen ? last : 0)
  }
  return out
}

// Group a matrix by one label and resample every series to n points.
export function matrixByLabel(
  matrix: PromSeries[],
  label: string,
  n: number,
  start: number,
  end: number,
): Map<string, number[]> {
  const out = new Map<string, number[]>()
  for (const series of matrix) {
    out.set(series.metric[label] ?? '', resample(series.values, n, start, end))
  }
  return out
}

export function vectorValue(samples: PromSample[]): number {
  let sum = 0
  for (const s of samples) {
    const v = Number(s.value[1])
    if (Number.isFinite(v)) sum += v
  }
  return sum
}

export function vectorByLabel(samples: PromSample[], label: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of samples) {
    const v = Number(s.value[1])
    if (!Number.isFinite(v)) continue
    const key = s.metric[label] ?? ''
    out.set(key, (out.get(key) ?? 0) + v)
  }
  return out
}
