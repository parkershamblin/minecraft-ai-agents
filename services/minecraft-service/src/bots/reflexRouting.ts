/**
 * Tier 1 plugin routing (demo-sprint): which mineflayer plugins load in
 * BotSession.wire(), and which hand-rolled reflex watchers stand down
 * because a plugin replaces them. Pure and botless — BotSession holds a
 * real mineflayer Bot and is not instantiable under vitest, so the ROUTING
 * DECISION lives here where tests can reach it; BotSession only obeys the
 * booleans.
 *
 * Flags are 0/1 config knobs (the PHYSICS_SIM_BLOCK_CACHE precedent),
 * default ON per the owner's decision. Flag 0 = off/fallback: the plugin
 * never loads and the hand-rolled path (EatWatcher / ArmorWatcher) runs
 * exactly as before.
 *
 * Reflex discipline (the guardTether contract): auto-eat and armor-manager
 * are BELOW-deliberation reflexes. They must never claim the busy seam —
 * and on the plugin path they structurally cannot: the only code that ever
 * mapped eating to busy ('eat') is the EatWatcher, which does not start
 * when its plugin flag is on, and armor equips never claimed busy on
 * either path.
 */

/** The five plugin flags, structurally satisfied by Config. */
export interface PluginFlags {
  PLUGIN_COLLECTBLOCK: number
  PLUGIN_TOOL: number
  PLUGIN_PVP: number
  PLUGIN_AUTO_EAT: number
  PLUGIN_ARMOR_MANAGER: number
}

export interface ReflexRouting {
  /** loadPlugin only — bot.collectBlock for future assembly wiring */
  loadCollectBlock: boolean
  /** loadPlugin only — bot.tool for future assembly wiring */
  loadTool: boolean
  /** loadPlugin only — bot.pvp for the killMob primitive */
  loadPvp: boolean
  /** true: load auto-eat, EatWatcher does NOT start; false: watcher runs */
  useAutoEatPlugin: boolean
  /** true: load armor-manager, ArmorWatcher does NOT start; false: watcher runs */
  useArmorManagerPlugin: boolean
}

export function resolveReflexRouting(flags: PluginFlags): ReflexRouting {
  return {
    loadCollectBlock: flags.PLUGIN_COLLECTBLOCK === 1,
    loadTool: flags.PLUGIN_TOOL === 1,
    loadPvp: flags.PLUGIN_PVP === 1,
    useAutoEatPlugin: flags.PLUGIN_AUTO_EAT === 1,
    useArmorManagerPlugin: flags.PLUGIN_ARMOR_MANAGER === 1,
  }
}
