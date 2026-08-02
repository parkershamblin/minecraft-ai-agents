#!/usr/bin/env node
// Unified CLI for built-in races / drills / benches.
// Usage: node scripts/civ-bench.mjs <command> [args...]
//        npm run bench -- <command> [args...]
//        task race -- --label my-take   (Taskfile wrappers below)
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath

const COMMANDS = {
  race: {
    summary: 'Full 3v3 Red-vs-Blue race to iron pickaxe (live stack + MC RCON)',
    needs: 'app profile up · containerized Paper (`--profile minecraft`) · 6 racers seeded',
    run: (args) => runNode('scripts/race-rb2.mjs', args),
    examples: [
      'node scripts/civ-bench.mjs race --label my-race --difficulty normal --mobs',
      'node scripts/civ-bench.mjs race --label practice --practice --difficulty easy',
    ],
  },
  'race:practice': {
    summary: 'Same as race, with --practice (skips hard budget/tick preset checks)',
    needs: 'same as race',
    run: (args) => runNode('scripts/race-rb2.mjs', ['--practice', ...args]),
    examples: ['node scripts/civ-bench.mjs race:practice --label soak'],
  },
  drill: {
    summary: 'Fast LIVE brain drill — one bot, staged arena, honest ladder (minutes)',
    needs: 'app profile up · MC with RCON (compose minecraft profile)',
    run: (args) => runNode('scripts/drill-rb2.mjs', args),
    examples: [
      'node scripts/civ-bench.mjs drill --bot Elara --stall-minutes 8',
    ],
  },
  'drill:body': {
    summary: 'RB-1 body/rig drill — staged RCON gifts, raw command plane (no brain)',
    needs: 'app profile up · MC RCON · Fen outside ticked fleet',
    run: (args) => runNode('scripts/drill-rb1.mjs', args),
    examples: ['node scripts/civ-bench.mjs drill:body'],
  },
  replay: {
    summary: 'OFFLINE race-brain replay at a rung (Ollama, no world / no docker tick)',
    needs: 'Ollama with the model pulled · agent-service venv',
    run: (args) => runUvAgent(['scripts/replay_race_brain.py', ...args]),
    examples: [
      'node scripts/civ-bench.mjs replay --rung bare --n 20',
      'node scripts/civ-bench.mjs replay --rung win --n 10',
    ],
  },
  'skill-bench': {
    summary: 'Ported-skill chain to iron_pickaxe (no LLM). Cold inventory per run.',
    needs: 'vanilla/Paper on localhost:25565 · currently pinned MC 1.21.6 in the script',
    run: (args) =>
      runCmd(node, [
        path.join(root, 'node_modules/tsx/dist/cli.mjs'),
        path.join(root, 'scripts/skill-bench.ts'),
        ...args,
      ]),
    examples: ['node scripts/civ-bench.mjs skill-bench 3'],
  },
  sweep: {
    summary: 'Honesty-gated model/axis sweep (writes bench/results/sweep/manifest.json)',
    needs: 'full race stack · pristine world snapshot path · see docs/runbooks/race-sensitivity-sweep.md',
    run: (args) =>
      runCmd('uv', ['run', '--with', 'httpx', 'python', 'bench/sweep_race.py', ...args]),
    examples: [
      'node scripts/civ-bench.mjs sweep --models llama3.1:8b --runs 1 --world-snapshot <path.tgz>',
    ],
  },
  aggregate: {
    summary: 'Rebuild RACE_REPORT.md / AXIS_REPORT.md from the sweep manifest',
    needs: 'prior sweep rows under bench/results/',
    run: (args) => runCmd('uv', ['run', 'python', 'bench/aggregate_race.py', ...args]),
    examples: ['node scripts/civ-bench.mjs aggregate'],
  },
  list: {
    summary: 'List commands (same as --help)',
    needs: '—',
    run: () => {
      printHelp()
      return 0
    },
    examples: [],
  },
}

function runNode(relScript, args) {
  return runCmd(node, [path.join(root, relScript), ...args])
}

function runUvAgent(args) {
  return runCmd('uv', ['run', 'python', ...args], {
    cwd: path.join(root, 'services', 'agent-service'),
  })
}

function runCmd(cmd, args, { cwd = root } = {}) {
  console.log(`→ ${cmd} ${args.join(' ')}`)
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false })
  if (result.error) {
    console.error(result.error.message)
    return 1
  }
  return result.status ?? 1
}

function printHelp() {
  console.log(`AI Civilization Engine — benchmark CLI

Usage:
  node scripts/civ-bench.mjs <command> [args...]
  npm run bench -- <command> [args...]
  task <race|race:practice|race:drill|...> -- [args...]

Commands:`)
  for (const [name, meta] of Object.entries(COMMANDS)) {
    if (name === 'list') continue
    console.log(`\n  ${name}`)
    console.log(`    ${meta.summary}`)
    console.log(`    needs: ${meta.needs}`)
    for (const ex of meta.examples) {
      console.log(`    ex: ${ex}`)
    }
  }
  console.log(`
Notes:
  · Mission Control (:3000/mission-control) lights up from AttemptStarted — start a race/drill to feed it.
  · race / drill / drill:body expect the compose Paper profile (RCON via docker exec).
  · skill-bench talks to host :25565 and is still version-pinned to 1.21.6 in-script.
  · Your current 26.2 host-on-:55916 village is for free play; races want the Paper pin.`)
}

const argv = process.argv.slice(2)
if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
  printHelp()
  process.exit(0)
}

const [command, ...rest] = argv
const meta = COMMANDS[command]
if (!meta) {
  console.error(`Unknown command: ${command}\n`)
  printHelp()
  process.exit(2)
}

process.exit(meta.run(rest))
