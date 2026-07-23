import { describe, expect, it } from 'vitest'
import { buildRoster } from '../src/pov/roster.ts'

const cfg = (over: Partial<{ POV_ROSTER: string; POV_PORT_BASE: number; POV_VIEWER_COUNT: number }> = {}) => ({
  POV_ROSTER: 'Elara,Bram,Wren,Ansel,Petra,Fen',
  POV_PORT_BASE: 3100,
  POV_VIEWER_COUNT: 6,
  ...over,
})

describe('buildRoster', () => {
  it('maps the default roster deterministically in tile order — Elara:3100 … Fen:3105', () => {
    const roster = buildRoster(cfg())
    expect(roster.map((r) => `${r.racer}:${r.port}`)).toEqual([
      'Elara:3100',
      'Bram:3101',
      'Wren:3102',
      'Ansel:3103',
      'Petra:3104',
      'Fen:3105',
    ])
  })

  it('assigns Minecraft-charset cam names pov_cam_1..6', () => {
    const roster = buildRoster(cfg())
    expect(roster.map((r) => r.camName)).toEqual(['pov_cam_1', 'pov_cam_2', 'pov_cam_3', 'pov_cam_4', 'pov_cam_5', 'pov_cam_6'])
    for (const { camName } of roster) {
      expect(camName).toMatch(/^[A-Za-z0-9_]{1,16}$/)
    }
  })

  it('clamps to POV_VIEWER_COUNT', () => {
    const roster = buildRoster(cfg({ POV_VIEWER_COUNT: 2 }))
    expect(roster).toHaveLength(2)
    expect(roster[1]).toMatchObject({ racer: 'Bram', port: 3101 })
  })

  it('trims whitespace and drops empty segments', () => {
    const roster = buildRoster(cfg({ POV_ROSTER: ' Elara , Bram ,, ' }))
    expect(roster.map((r) => r.racer)).toEqual(['Elara', 'Bram'])
  })

  it('rejects an empty roster', () => {
    expect(() => buildRoster(cfg({ POV_ROSTER: ' ,, ' }))).toThrow(/empty/)
  })

  it('rejects duplicate racers', () => {
    expect(() => buildRoster(cfg({ POV_ROSTER: 'Elara,Elara' }))).toThrow(/duplicate/)
  })
})
