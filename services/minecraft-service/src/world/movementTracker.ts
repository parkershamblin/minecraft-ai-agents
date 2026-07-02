import { type Position, distance, round1, roundPos } from './position.ts'

export interface MoveEmission {
  from: Position
  to: Position
  distance: number
}

/**
 * Source-side throttling for VillagerMoved: at most one emission per
 * throttleMs while moving, and nothing when (nearly) stationary. Path
 * completion adds a final flush() in the command executor (CIV-5).
 * Pure logic — no bot, no clock of its own — so it is trivially testable.
 */
export class MovementTracker {
  private lastEmitted: Position | null = null
  private lastEmitAt = 0

  constructor(
    private readonly throttleMs: number,
    private readonly minBlocks = 1,
  ) {}

  /** Call on every position update; returns an emission when one is due. */
  check(position: Position, now: number): MoveEmission | null {
    if (this.lastEmitted === null) {
      this.lastEmitted = roundPos(position)
      this.lastEmitAt = now
      return null
    }
    if (now - this.lastEmitAt < this.throttleMs) {
      return null
    }
    const moved = distance(this.lastEmitted, position)
    if (moved < this.minBlocks) {
      return null
    }
    const emission: MoveEmission = {
      from: this.lastEmitted,
      to: roundPos(position),
      distance: round1(moved),
    }
    this.lastEmitted = emission.to
    this.lastEmitAt = now
    return emission
  }

  /** Path completion: emit whatever displacement is pending, ignoring the clock. */
  flush(position: Position, now: number): MoveEmission | null {
    if (this.lastEmitted === null) {
      return null
    }
    const moved = distance(this.lastEmitted, position)
    if (moved < this.minBlocks) {
      return null
    }
    const emission: MoveEmission = {
      from: this.lastEmitted,
      to: roundPos(position),
      distance: round1(moved),
    }
    this.lastEmitted = emission.to
    this.lastEmitAt = now
    return emission
  }
}
