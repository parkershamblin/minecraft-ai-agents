/** Allowlisted civ-bench commands + safe arg builders for the dashboard. */

export type BenchCommandId =
  | 'race'
  | 'race:practice'
  | 'drill'
  | 'drill:body'
  | 'replay'
  | 'skill-bench'
  | 'aggregate'
  | 'sweep'

export type FieldKind = 'text' | 'number' | 'select' | 'checkbox' | 'path'

export type BenchField = {
  key: string
  label: string
  kind: FieldKind
  optional?: boolean
  defaultValue?: string | number | boolean
  options?: { value: string; label: string }[]
  min?: number
  max?: number
  help?: string
}

export type BenchCommandMeta = {
  id: BenchCommandId
  title: string
  summary: string
  needs: string
  /** Minutes-scale hint for the UI (not enforced). */
  durationHint: string
  fields: BenchField[]
}

export const BENCH_COMMANDS: BenchCommandMeta[] = [
  {
    id: 'race',
    title: 'Full race (3v3)',
    summary: 'Red vs Blue race to iron pickaxe — live stack + Paper RCON.',
    needs: 'app profile up · compose Paper (`--profile minecraft`) · 6 racers seeded',
    durationHint: 'often 10–60+ min',
    fields: [
      { key: 'label', label: 'Label', kind: 'text', optional: true, help: 'Receipt / Mission Control label' },
      {
        key: 'difficulty',
        label: 'Difficulty',
        kind: 'select',
        defaultValue: 'peaceful',
        options: [
          { value: 'peaceful', label: 'peaceful' },
          { value: 'easy', label: 'easy' },
          { value: 'normal', label: 'normal' },
          { value: 'hard', label: 'hard' },
        ],
      },
      { key: 'practice', label: 'Practice mode', kind: 'checkbox', defaultValue: false, help: 'Skip hard budget/tick preset checks' },
      { key: 'mobs', label: 'Hostile mobs', kind: 'checkbox', defaultValue: false },
      {
        key: 'stallMinutes',
        label: 'Stall minutes',
        kind: 'number',
        optional: true,
        defaultValue: 75,
        min: 5,
        max: 180,
      },
    ],
  },
  {
    id: 'race:practice',
    title: 'Practice race',
    summary: 'Same as race with --practice.',
    needs: 'same as full race',
    durationHint: 'often 10–60+ min',
    fields: [
      { key: 'label', label: 'Label', kind: 'text', optional: true },
      {
        key: 'difficulty',
        label: 'Difficulty',
        kind: 'select',
        defaultValue: 'peaceful',
        options: [
          { value: 'peaceful', label: 'peaceful' },
          { value: 'easy', label: 'easy' },
          { value: 'normal', label: 'normal' },
          { value: 'hard', label: 'hard' },
        ],
      },
      { key: 'mobs', label: 'Hostile mobs', kind: 'checkbox', defaultValue: false },
    ],
  },
  {
    id: 'drill',
    title: 'Live brain drill',
    summary: 'One bot, staged arena, honest ladder — minutes, not hours.',
    needs: 'app profile up · MC with RCON (compose minecraft)',
    durationHint: '~5–15 min',
    fields: [
      { key: 'label', label: 'Label', kind: 'text', optional: true, defaultValue: 'rb2-drill' },
      {
        key: 'bot',
        label: 'Bot',
        kind: 'select',
        defaultValue: 'Elara',
        options: ['Elara', 'Bram', 'Wren', 'Ansel', 'Petra', 'Fen'].map((n) => ({ value: n, label: n })),
      },
      {
        key: 'stallMinutes',
        label: 'Stall minutes',
        kind: 'number',
        optional: true,
        defaultValue: 8,
        min: 2,
        max: 60,
      },
    ],
  },
  {
    id: 'drill:body',
    title: 'Body / rig drill',
    summary: 'RB-1 staged gifts on the raw command plane (no brain).',
    needs: 'app profile up · MC RCON · Fen outside ticked fleet',
    durationHint: 'a few minutes',
    fields: [],
  },
  {
    id: 'replay',
    title: 'Offline brain replay',
    summary: 'Sample race-brain decisions against Ollama — no world / no docker tick.',
    needs: 'Ollama with the model pulled · agent-service venv',
    durationHint: 'depends on --n',
    fields: [
      {
        key: 'rung',
        label: 'Rung',
        kind: 'select',
        defaultValue: 'bare',
        options: ['bare', 'coal', 'iron', 'furnace', 'ingot', 'win', 'all'].map((v) => ({
          value: v,
          label: v,
        })),
      },
      { key: 'n', label: 'Samples', kind: 'number', defaultValue: 20, min: 1, max: 200 },
      { key: 'model', label: 'Ollama model', kind: 'text', optional: true, help: 'Override; blank = settings/env' },
    ],
  },
  {
    id: 'skill-bench',
    title: 'Skill bench',
    summary: 'Ported-skill chain to iron_pickaxe (no LLM). Cold inventory per run.',
    needs: 'vanilla/Paper on localhost:25565 · script pinned to MC 1.21.6',
    durationHint: 'minutes × runs',
    fields: [
      { key: 'runs', label: 'Runs', kind: 'number', defaultValue: 3, min: 1, max: 20 },
    ],
  },
  {
    id: 'aggregate',
    title: 'Aggregate reports',
    summary: 'Rebuild RACE_REPORT.md / AXIS_REPORT.md from the sweep manifest.',
    needs: 'prior sweep rows under bench/results/',
    durationHint: 'seconds',
    fields: [],
  },
  {
    id: 'sweep',
    title: 'Model / axis sweep',
    summary: 'Honesty-gated sweep — writes bench/results/sweep/manifest.json.',
    needs: 'full race stack · pristine world snapshot (.tgz)',
    durationHint: 'hours',
    fields: [
      {
        key: 'worldSnapshot',
        label: 'World snapshot (.tgz)',
        kind: 'path',
        help: 'Absolute path to pristine world tarball',
      },
      {
        key: 'models',
        label: 'Models',
        kind: 'text',
        defaultValue: 'llama3.1:8b',
        help: 'Comma-separated Ollama tags',
      },
      { key: 'runs', label: 'Runs per model', kind: 'number', defaultValue: 1, min: 1, max: 10 },
    ],
  },
]

const LABEL_RE = /^[a-zA-Z0-9._-]{1,64}$/
const MODEL_RE = /^[a-zA-Z0-9._:+-]{1,80}$/
const MODELS_RE = /^[a-zA-Z0-9._:+,-]{1,200}$/
const PATH_RE = /^[A-Za-z]:[\\/][\w.\\/\- ]+\.tgz$/i
const POSIX_PATH_RE = /^\/[\w./\- ]+\.tgz$/

export function getCommand(id: string): BenchCommandMeta | undefined {
  return BENCH_COMMANDS.find((c) => c.id === id)
}

/** Turn UI options into argv for `node scripts/civ-bench.mjs <id> ...`. */
export function buildBenchArgs(id: BenchCommandId, options: Record<string, unknown>): string[] {
  const args: string[] = []

  const label = optionalString(options.label)
  if (label !== undefined) {
    if (!LABEL_RE.test(label)) throw new Error('label must be 1–64 chars: letters, digits, ._-')
    args.push('--label', label)
  }

  switch (id) {
    case 'race':
    case 'race:practice': {
      const difficulty = String(options.difficulty ?? 'peaceful')
      const allowed = new Set(['peaceful', 'easy', 'normal', 'hard'])
      if (!allowed.has(difficulty)) throw new Error('difficulty must be peaceful|easy|normal|hard')
      args.push('--difficulty', difficulty)
      if (options.mobs === true) args.push('--mobs')
      if (id === 'race' && options.practice === true) args.push('--practice')
      const stall = optionalNumber(options.stallMinutes)
      if (stall !== undefined) {
        if (stall < 5 || stall > 180) throw new Error('stallMinutes out of range')
        args.push('--stall-minutes', String(stall))
      }
      return args
    }
    case 'drill': {
      const bot = String(options.bot ?? 'Elara')
      const allowed = new Set(['Elara', 'Bram', 'Wren', 'Ansel', 'Petra', 'Fen'])
      if (!allowed.has(bot)) throw new Error(`bot must be one of ${[...allowed].join(', ')}`)
      args.push('--bot', bot)
      const stall = optionalNumber(options.stallMinutes)
      if (stall !== undefined) {
        if (stall < 2 || stall > 60) throw new Error('stallMinutes out of range')
        args.push('--stall-minutes', String(stall))
      }
      return args
    }
    case 'drill:body':
    case 'aggregate':
      return args
    case 'replay': {
      const rung = String(options.rung ?? 'bare')
      const rungs = new Set(['bare', 'coal', 'iron', 'furnace', 'ingot', 'win', 'all'])
      if (!rungs.has(rung)) throw new Error('invalid rung')
      args.push('--rung', rung)
      const n = optionalNumber(options.n) ?? 20
      if (n < 1 || n > 200) throw new Error('n out of range')
      args.push('--n', String(n))
      const model = optionalString(options.model)
      if (model !== undefined) {
        if (!MODEL_RE.test(model)) throw new Error('invalid model string')
        args.push('--model', model)
      }
      return args
    }
    case 'skill-bench': {
      // positional runs count — civ-bench forwards argv as-is to skill-bench.ts
      const runs = optionalNumber(options.runs) ?? 3
      if (runs < 1 || runs > 20) throw new Error('runs out of range')
      return [String(runs)]
    }
    case 'sweep': {
      const snap = optionalString(options.worldSnapshot)
      if (!snap) throw new Error('worldSnapshot is required')
      if (!PATH_RE.test(snap) && !POSIX_PATH_RE.test(snap)) {
        throw new Error('worldSnapshot must be an absolute .tgz path')
      }
      args.push('--world-snapshot', snap)
      const models = optionalString(options.models) ?? 'llama3.1:8b'
      if (!MODELS_RE.test(models)) throw new Error('invalid models string')
      args.push('--models', models)
      const runs = optionalNumber(options.runs) ?? 1
      if (runs < 1 || runs > 10) throw new Error('runs out of range')
      args.push('--runs', String(runs))
      return args
    }
    default:
      throw new Error(`unknown command ${id}`)
  }
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  return String(value).trim()
}

function optionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  if (!Number.isFinite(n)) throw new Error('expected a number')
  return n
}
