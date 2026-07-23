import type { Config } from '../config.ts'

/**
 * Deterministic cam→racer→port assignment. Tile order is a contract with
 * PovGrid.tsx and film/pov-grid.html (both hardcode :3100..:3105 in
 * villagers.json seed order), so the mapping comes from POV_ROSTER config,
 * not from spawn order — villagers.json itself isn't baked into the image,
 * and the old in-process pool handed ports out in whatever order spawns
 * happened to land.
 */
export interface CamAssignment {
  /** racer this cam films (must match the racer's Minecraft username) */
  racer: string
  /** cam bot's own username — Minecraft charset [A-Za-z0-9_], ≤16 chars */
  camName: string
  /** prismarine-viewer HTTP port for this tile */
  port: number
  index: number
}

export function buildRoster(config: Pick<Config, 'POV_ROSTER' | 'POV_PORT_BASE' | 'POV_VIEWER_COUNT'>): CamAssignment[] {
  const names = config.POV_ROSTER.split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
  if (names.length === 0) {
    throw new Error('POV_ROSTER is empty — nothing to film')
  }
  if (new Set(names).size !== names.length) {
    throw new Error(`POV_ROSTER has duplicate racers: ${config.POV_ROSTER}`)
  }
  return names.slice(0, config.POV_VIEWER_COUNT).map((racer, index) => ({
    racer,
    camName: `pov_cam_${index + 1}`,
    port: config.POV_PORT_BASE + index,
    index,
  }))
}
