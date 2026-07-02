export interface Position {
  x: number
  y: number
  z: number
}

export function distance(a: Position, b: Position): number {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2)
}

export function round1(value: number): number {
  return Math.round(value * 10) / 10
}

export function roundPos(p: Position): Position {
  return { x: round1(p.x), y: round1(p.y), z: round1(p.z) }
}
