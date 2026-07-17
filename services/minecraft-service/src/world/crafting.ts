import type { Position } from './position.ts'
import { RESOURCE_BLOCKS } from './resources.ts'

/**
 * The craft verb's pure logic (SV-3): item-family resolution, the
 * table-acquire decision tree, prescriptive failure prose, and announcements.
 * Orchestration mirrors SV-2's gatherSession — every world touch is injected,
 * so the decision tree that matters (table acquire/place, missing-ingredient
 * teaching, honest zero-craft, watchdog abandonment) is unit-testable
 * without a bot.
 */

/** The contract's CraftParams.item enum, verbatim. The tripwire test asserts
 *  this list matches the committed schema exactly — a contract commit that
 *  grows the enum (SV-11's leather armor) fails LOUD here until the body
 *  handles the new entries. */
export const CRAFTABLE_ITEMS = [
  'planks',
  'sticks',
  'crafting_table',
  'wooden_axe',
  'wooden_pickaxe',
  'wooden_sword',
  'stone_axe',
  'stone_pickaxe',
  'stone_sword',
  'furnace',
] as const

/** log → plank family map, derived from the gather families so the two verbs
 *  can never disagree about what wood is. */
const LOG_TO_PLANKS: Record<string, string> = Object.fromEntries(
  (RESOURCE_BLOCKS.wood as readonly string[]).map((log) => [log, log.replace(/_log$/, '_planks')]),
)

/** How far the flow looks for a standing crafting table. Small on purpose:
 *  the walk has to fit inside the act node's 30s watchdog alongside the
 *  craft itself (the per-verb timeout table is SV-4's). */
export const CRAFT_TABLE_SEARCH_DISTANCE = 16

/** Coded, prescriptive craft failure — the executor passes code + retryable
 *  through to ActionFailed verbatim; the message is the villager's next
 *  percept, so it must teach the next step, not just report the gap. */
export function craftError(
  code: 'INVALID_PARAMS' | 'RESOURCE_NOT_FOUND' | 'TOOL_REQUIRED' | 'PATH_NOT_FOUND',
  message: string,
  retryable: boolean,
): Error {
  const err = new Error(message) as Error & { code?: string; retryable?: boolean }
  err.code = code
  err.retryable = retryable
  return err
}

export interface CarriedStack {
  name: string
  count: number
}

/**
 * Contract item → concrete registry item. planks/sticks are wood-type-
 * abstract families (the GatherParams resource-family precedent): planks
 * resolve against the logs the villager actually carries — most-carried log
 * wins, so a mixed pack crafts the wood it has depth in.
 */
export function resolveCraftTarget(item: string, carried: readonly CarriedStack[]): string {
  if (item === 'planks') {
    const perLog = new Map<string, number>()
    for (const stack of carried) {
      if (LOG_TO_PLANKS[stack.name]) {
        perLog.set(stack.name, (perLog.get(stack.name) ?? 0) + stack.count)
      }
    }
    let bestLog: string | null = null
    let bestCount = 0
    for (const [log, count] of perLog) {
      if (count > bestCount) {
        bestLog = log
        bestCount = count
      }
    }
    if (!bestLog) {
      throw craftError('RESOURCE_NOT_FOUND', 'planks come from logs and you carry none — gather wood first, then craft again', false)
    }
    return LOG_TO_PLANKS[bestLog]!
  }
  if (item === 'sticks') {
    return 'stick'
  }
  if ((CRAFTABLE_ITEMS as readonly string[]).includes(item)) {
    return item
  }
  throw craftError('INVALID_PARAMS', unknownItemMessage(item), false)
}

export function unknownItemMessage(item: string): string {
  return `'${item}' is not something you know how to craft — the craftable items are: ${CRAFTABLE_ITEMS.join(', ')}`
}

export interface IngredientGap {
  name: string
  required: number
  have: number
}

/** Progression materials the affordance prose teaches — preferred when
 *  recipe variants tie, so a failure names planks/sticks/cobblestone rather
 *  than exotic equivalents (bamboo sticks, blackstone furnaces). */
function knownMaterial(name: string): boolean {
  return (
    name.endsWith('_planks') || name.endsWith('_log') || name === 'stick' || name === 'cobblestone' || name === 'crafting_table'
  )
}

/** Can the villager plausibly produce this missing ingredient from what's
 *  already in the pack? (dark_oak_planks ← dark_oak_log, stick ← any wood.)
 *  Steers the tie-break so prose never sends a dark-oak villager hunting
 *  cherry trees — llama reads failure messages literally. */
function makeableFrom(missingName: string, carried: readonly CarriedStack[]): boolean {
  if (carried.some((stack) => stack.name === missingName && stack.count > 0)) {
    return true
  }
  if (missingName.endsWith('_planks')) {
    const log = missingName.replace(/_planks$/, '_log')
    return carried.some((stack) => stack.name === log && stack.count > 0)
  }
  if (missingName === 'stick') {
    return carried.some((stack) => (stack.name.endsWith('_planks') || LOG_TO_PLANKS[stack.name]) && stack.count > 0)
  }
  return false
}

/**
 * Choose which recipe variant's ingredient list to teach: fewest missing
 * items first (a half-stocked pack should hear about its actual shortfall,
 * not a from-scratch variant); ties break toward ingredients the villager
 * can make from the pack, then toward known progression materials.
 */
export function cheapestGaps(
  perRecipe: readonly (readonly IngredientGap[])[],
  carried: readonly CarriedStack[] = [],
): IngredientGap[] {
  let best: readonly IngredientGap[] | null = null
  let bestMissing = Infinity
  let bestAffinity = -1
  let bestKnown = false
  for (const gaps of perRecipe) {
    const missing = gaps.reduce((sum, gap) => sum + Math.max(0, gap.required - gap.have), 0)
    const affinity = gaps.filter((gap) => gap.have < gap.required && makeableFrom(gap.name, carried)).length
    const known = gaps.every((gap) => knownMaterial(gap.name))
    const wins =
      missing < bestMissing ||
      (missing === bestMissing && affinity > bestAffinity) ||
      (missing === bestMissing && affinity === bestAffinity && known && !bestKnown)
    if (wins) {
      best = gaps
      bestMissing = missing
      bestAffinity = affinity
      bestKnown = known
    }
  }
  return best ? [...best] : []
}

function display(name: string): string {
  return name.replace(/_/g, ' ')
}

/** The next concrete step up the recipe chain, keyed by what's missing —
 *  every failure ends by naming an action the villager can take THIS tick. */
function chainHint(missingName: string): string {
  if (missingName.endsWith('_planks')) {
    return 'craft planks from your logs first (gather wood if you carry none)'
  }
  if (missingName === 'stick') {
    return 'craft sticks from planks first'
  }
  if (missingName === 'cobblestone') {
    return 'gather stone first — it only drops to a pickaxe in hand'
  }
  if (missingName.endsWith('_log')) {
    return 'gather wood first'
  }
  return 'gather or craft the missing materials first'
}

/**
 * Prescriptive MISSING-INGREDIENTS prose: the full recipe, the actual
 * shortfall, and the chain hint. "You lack materials" taught nothing; "you
 * carry no sticks; craft sticks from planks first" is a plan.
 */
export function missingIngredientsMessage(itemName: string, gaps: readonly IngredientGap[]): string {
  if (gaps.length === 0) {
    return `there is no recipe for ${display(itemName)} that you know`
  }
  const recipe = gaps.map((gap) => `${gap.required} ${display(gap.name)}`).join(' + ')
  const short = gaps.filter((gap) => gap.have < gap.required)
  const shortfall =
    short
      .map((gap) => (gap.have === 0 ? `no ${display(gap.name)}` : `${gap.have} of the ${gap.required} ${display(gap.name)}`))
      .join(' and ') || 'less than it takes'
  const hint = short.length > 0 ? chainHint(short[0]!.name) : 'check your pack and try again'
  return `crafting ${display(itemName)} takes ${recipe} — you carry ${shortfall}; ${hint}`
}

export function tableRequiredMessage(itemName: string): string {
  return (
    `crafting ${display(itemName)} needs a crafting table — none stands within ${CRAFT_TABLE_SEARCH_DISTANCE} blocks ` +
    `and you carry none; craft a crafting_table first (4 planks of any wood)`
  )
}

export function noPlacementMessage(): string {
  return 'no clear level ground within reach to set your crafting table on — move to open ground and try again'
}

/** Spoken on success — world-visible chat, so a craft becomes social
 *  information the way SV-2's hauls did. Never spoken for a zero craft. */
export function craftAnnouncement(itemName: string, crafted: number): string {
  const what = display(itemName)
  return crafted === 1 ? `Crafted a ${what}!` : `Crafted ${crafted} ${what}${itemName.endsWith('s') ? '' : 's'}!`
}

/** A placed table is village infrastructure — announcing it tells every
 *  villager in earshot (and the audience) where the workbench stands. */
export function tablePlacedAnnouncement(position: Position): string {
  return `Set up a crafting table at (${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}).`
}

/** The slice of world the placement scan reads — structural, tests fake it. */
export interface PlacementCell {
  air: boolean
  solid: boolean
}

export interface TableSpot {
  /** the solid block the table is placed against (its top face) */
  ground: Position
  /** where the table will stand */
  spot: Position
}

/**
 * Find a clear cell beside the bot to set a table on: solid ground with two
 * blocks of air above it, one or two blocks away horizontally (never the
 * cell the bot occupies — placement into your own body fails), nearest
 * first, one step up or down tolerated for hillsides.
 */
export function pickTableSpot(origin: Position, cellAt: (p: Position) => PlacementCell | null): TableSpot | null {
  const ox = Math.floor(origin.x)
  const oy = Math.floor(origin.y)
  const oz = Math.floor(origin.z)
  const offsets: Array<[number, number]> = []
  for (let dx = -2; dx <= 2; dx++) {
    for (let dz = -2; dz <= 2; dz++) {
      if (dx !== 0 || dz !== 0) {
        offsets.push([dx, dz])
      }
    }
  }
  offsets.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]))
  for (const [dx, dz] of offsets) {
    for (const dy of [0, -1, 1]) {
      const ground = { x: ox + dx, y: oy + dy - 1, z: oz + dz }
      const spot = { x: ground.x, y: ground.y + 1, z: ground.z }
      const above = { x: ground.x, y: ground.y + 2, z: ground.z }
      if (cellAt(ground)?.solid && cellAt(spot)?.air && cellAt(above)?.air) {
        return { ground, spot }
      }
    }
  }
  return null
}

export interface CraftFlowDeps {
  carried(): readonly CarriedStack[]
  /** recipes performable NOW from the pack; allowTable answers the
   *  hypothetical "could I, standing at a table?" */
  craftableNow(itemName: string, allowTable: boolean): boolean
  /** the chosen recipe variant's full ingredient list vs the pack (table
   *  assumed available); [] when the item has no recipe at all */
  ingredientGaps(itemName: string): IngredientGap[]
  findTable(): Position | null
  walkTo(position: Position): Promise<void>
  /** place a carried table beside the bot; throws coded PATH_NOT_FOUND when
   *  no clear ground is in reach */
  placeTable(): Promise<Position>
  craft(itemName: string, tableAt: Position | null): Promise<void>
  countItem(itemName: string): number
  /** The executor's busy seam (the SV-2 cancellation signal): false means
   *  the watchdog timed the command out and abandoned this promise — the
   *  zombie must fall silent (no placing, crafting, or chat). */
  bodyStillOurs(): boolean
  announce(line: string): void
  position(): Position
}

export interface CraftResult {
  /** the contract item asked for (family) */
  item: string
  /** the concrete item crafted (planks → 'spruce_planks') */
  itemName: string
  /** honest inventory delta — 0 means the craft did not really land */
  crafted: number
  tableUsed: boolean
  tablePlaced: boolean
  position: Position
}

/**
 * One craft = one recipe application (a tick buys one world action — the
 * log→planks→table→tool chain is the MIND's multi-tick project, which is
 * the point of the whole arc). Failures are coded and prescriptive; the
 * result reports the honest inventory delta.
 */
export async function runCraftFlow(item: string, deps: CraftFlowDeps): Promise<CraftResult> {
  const itemName = resolveCraftTarget(item, deps.carried())

  if (!deps.craftableNow(itemName, true)) {
    // Ingredients are the deeper gap — teach them before any table talk
    // (with an empty pack the right next action is gathering, not carpentry).
    throw craftError('RESOURCE_NOT_FOUND', missingIngredientsMessage(itemName, deps.ingredientGaps(itemName)), false)
  }

  let tableAt: Position | null = null
  let tablePlaced = false
  if (!deps.craftableNow(itemName, false)) {
    tableAt = deps.findTable()
    if (tableAt) {
      await deps.walkTo(tableAt)
    } else if (deps.carried().some((stack) => stack.name === 'crafting_table' && stack.count > 0)) {
      tableAt = await deps.placeTable()
      tablePlaced = true
      if (deps.bodyStillOurs()) {
        deps.announce(tablePlacedAnnouncement(tableAt))
      }
    } else {
      throw craftError('TOOL_REQUIRED', tableRequiredMessage(itemName), false)
    }
  }

  if (!deps.bodyStillOurs()) {
    // The watchdog settled this command while we walked/placed — the mind
    // already heard TIMEOUT; a zombie craft would put unexplained items in
    // the pack and unexplained chat in the plaza. (The outcome latch has
    // already suppressed this promise — the throw is just the stop.)
    throw new Error('craft abandoned by the watchdog')
  }

  const before = deps.countItem(itemName)
  await deps.craft(itemName, tableAt)
  const crafted = Math.max(0, deps.countItem(itemName) - before)

  if (crafted > 0 && deps.bodyStillOurs()) {
    deps.announce(craftAnnouncement(itemName, crafted))
  }
  return { item, itemName, crafted, tableUsed: tableAt !== null, tablePlaced, position: deps.position() }
}
