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
  'iron_pickaxe',
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
  code: 'INVALID_PARAMS' | 'RESOURCE_NOT_FOUND' | 'TOOL_REQUIRED' | 'PATH_NOT_FOUND' | 'SMELT_FAILED',
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

/** What the furnace turns a carried item into, keyed by the MISSING
 *  ingredient (RB-1, absorbs SV-9). Growing this map is how future smelts
 *  (gold, cooked food as a craft input) join the chain-resolution. */
export const SMELTABLES: Record<string, string> = {
  iron_ingot: 'raw_iron',
}

/** Fuel ranking: smelts one item covers (vanilla burn time / 10s per smelt).
 *  Coal first — dense and purpose-built; wood products are the bootstrap
 *  fallback. Sticks deliberately excluded: half a smelt each means a chain
 *  could quietly burn a pack of tool handles. */
const FUEL_RANKING: ReadonlyArray<{ matches: (name: string) => boolean; smeltsPerItem: number }> = [
  { matches: (n) => n === 'coal' || n === 'charcoal', smeltsPerItem: 8 },
  { matches: (n) => n.endsWith('_planks'), smeltsPerItem: 1.5 },
  { matches: (n) => n.endsWith('_log'), smeltsPerItem: 1.5 },
]

/** Choose ONE carried stack to burn (a furnace fuel slot holds one item
 *  type): best-ranked class first, and within a class the deepest stack.
 *  Null when nothing carried covers the ask. */
export function pickFuel(carried: readonly CarriedStack[], smeltsNeeded: number): { name: string; count: number } | null {
  for (const rank of FUEL_RANKING) {
    const best = carried
      .filter((stack) => rank.matches(stack.name) && stack.count > 0)
      .sort((a, b) => b.count - a.count)[0]
    if (!best) {
      continue
    }
    const count = Math.ceil(smeltsNeeded / rank.smeltsPerItem)
    if (best.count >= count) {
      return { name: best.name, count }
    }
  }
  return null
}

export interface SmeltStep {
  /** concrete item fed into the furnace (raw_iron) */
  input: string
  /** what comes out (iron_ingot) */
  output: string
  /** items to smelt = the recipe's unmet count */
  count: number
  fuel: { name: string; count: number }
}

/**
 * Decide whether the chain-resolution should smelt before crafting: the ONLY
 * unmet gap is a smeltable ingredient AND the pack carries enough of its raw
 * input. Any other shortfall returns null so the missing-ingredients prose
 * teaches the earlier link instead (smelting first would waste furnace time
 * on a craft that still fails on sticks). Carrying the raw input but no fuel
 * IS a smelt problem — coded SMELT_FAILED, with the fix named.
 */
export function planSmeltStep(gaps: readonly IngredientGap[], carried: readonly CarriedStack[]): SmeltStep | null {
  const unmet = gaps.filter((gap) => gap.have < gap.required)
  const smeltable = unmet.find((gap) => SMELTABLES[gap.name])
  if (!smeltable || unmet.length !== 1) {
    return null
  }
  const input = SMELTABLES[smeltable.name]!
  const count = smeltable.required - smeltable.have
  const rawCarried = carried.filter((stack) => stack.name === input).reduce((sum, stack) => sum + stack.count, 0)
  if (rawCarried < count) {
    return null // a mining problem, not a smelting one — the gap prose teaches it
  }
  const fuel = pickFuel(carried, count)
  if (!fuel) {
    throw craftError(
      'SMELT_FAILED',
      `smelting ${count} ${display(smeltable.name)} needs fuel and nothing you carry burns — coal, planks, or logs all serve; gather wood or mine coal first`,
      false,
    )
  }
  return { input, output: smeltable.name, count, fuel }
}

export function noFurnaceMessage(): string {
  return (
    `smelting needs a furnace — none stands within ${CRAFT_TABLE_SEARCH_DISTANCE} blocks and you carry none; ` +
    `craft a furnace first (8 cobblestone at a crafting table)`
  )
}

export function smeltShortYieldMessage(step: SmeltStep, got: number): string {
  return (
    `the furnace gave ${got} of ${step.count} ${display(step.output)} before the fire died — ` +
    `carry more fuel (coal burns longest) and craft again; what was smelted is in your pack`
  )
}

export function smeltAnnouncement(output: string, count: number): string {
  return `Smelted ${count} ${display(output)}${count === 1 ? '' : 's'}!`
}

/** A placed furnace is village infrastructure, same as SV-3's table. */
export function furnacePlacedAnnouncement(position: Position): string {
  return `Set up a furnace at (${Math.round(position.x)}, ${Math.round(position.y)}, ${Math.round(position.z)}).`
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
  if (missingName === 'iron_ingot' || missingName === 'raw_iron') {
    return 'iron ingots are smelted from raw iron — gather iron_ore (a stone pickaxe or better makes it drop), and keep fuel; your body works the furnace when you craft'
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
  /** the furnace flow's world touches (RB-1 chain-resolution) — same shape
   *  as the table trio */
  findFurnace(): Position | null
  placeFurnace(): Promise<Position>
  /** run one smelt batch at a placed furnace; returns items actually taken
   *  from the output slot (the honest count — short on fuel starve or
   *  watchdog abandonment) */
  smelt(step: SmeltStep, furnaceAt: Position): Promise<number>
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
  /** ingots produced by the chain-resolution's furnace errand; 0 = no smelt */
  smelted: number
  furnaceUsed: boolean
  furnacePlaced: boolean
  position: Position
}

/**
 * One craft = one recipe application (a tick buys one world action — the
 * log→planks→table→tool chain is the MIND's multi-tick project, which is
 * the point of the whole arc). RB-1's one exception (ADR-10): when the only
 * unmet ingredient is smeltable from the pack, the furnace errand happens
 * INSIDE this action — smelting is the body's job, not a verb. Failures are
 * coded and prescriptive; the result reports the honest inventory delta.
 */
export async function runCraftFlow(item: string, deps: CraftFlowDeps): Promise<CraftResult> {
  const itemName = resolveCraftTarget(item, deps.carried())
  let smelted = 0
  let furnaceUsed = false
  let furnacePlaced = false

  if (!deps.craftableNow(itemName, true)) {
    const gaps = deps.ingredientGaps(itemName)
    const step = planSmeltStep(gaps, deps.carried())
    if (!step) {
      // Ingredients are the deeper gap — teach them before any table talk
      // (with an empty pack the right next action is gathering, not carpentry).
      throw craftError('RESOURCE_NOT_FOUND', missingIngredientsMessage(itemName, gaps), false)
    }

    // Chain-resolution (absorbs SV-9): acquire a furnace the way SV-3
    // acquires a table — walk to a standing one, else place a carried one.
    let furnaceAt = deps.findFurnace()
    if (furnaceAt) {
      await deps.walkTo(furnaceAt)
    } else if (deps.carried().some((stack) => stack.name === 'furnace' && stack.count > 0)) {
      furnaceAt = await deps.placeFurnace()
      furnacePlaced = true
      if (deps.bodyStillOurs()) {
        deps.announce(furnacePlacedAnnouncement(furnaceAt))
      }
    } else {
      throw craftError('SMELT_FAILED', noFurnaceMessage(), false)
    }

    if (!deps.bodyStillOurs()) {
      throw new Error('craft abandoned by the watchdog')
    }
    furnaceUsed = true
    smelted = await deps.smelt(step, furnaceAt)
    if (smelted < step.count) {
      // Retryable, unlike most craft failures: what did smelt is in the pack
      // and a re-run picks up where the fire died.
      throw craftError('SMELT_FAILED', smeltShortYieldMessage(step, smelted), true)
    }
    if (deps.bodyStillOurs()) {
      deps.announce(smeltAnnouncement(step.output, smelted))
    }
    if (!deps.craftableNow(itemName, true)) {
      // The smelt landed but the recipe still doesn't close — teach the
      // remaining gap honestly (planSmeltStep guards against reaching here,
      // but the world can shift mid-errand).
      throw craftError(
        'RESOURCE_NOT_FOUND',
        missingIngredientsMessage(itemName, deps.ingredientGaps(itemName)),
        false,
      )
    }
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
  return {
    item,
    itemName,
    crafted,
    tableUsed: tableAt !== null,
    tablePlaced,
    smelted,
    furnaceUsed,
    furnacePlaced,
    position: deps.position(),
  }
}
