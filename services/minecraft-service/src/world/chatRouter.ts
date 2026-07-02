import { type Position, distance } from './position.ts'

export interface ChatObservation {
  speakerVillagerId: string | null
  speakerUsername: string
  message: string
  heardByIds: string[]
  position: Position
}

export interface ChatSession {
  villagerId: string
  username: string
  position: Position | null
}

interface Deps {
  rosterByUsername: (username: string) => string | undefined
  activeSessions: () => ChatSession[]
  earshotBlocks: number
  emit: (observation: ChatObservation) => void
  now?: () => number
}

/**
 * Minecraft chat is global and every bot in the process hears every line —
 * naive per-bot emission would produce N-1 duplicate ChatObserved facts and
 * an echo loop. This router enforces the two CIV-4 rules:
 *  - self-filter: a bot never observes its own utterance
 *  - single emission: the first non-speaker session to report a line wins;
 *    duplicates within the dedupe window are dropped
 * heardByIds is the roster in earshot of the speaker, excluding the speaker.
 */
export class ChatRouter {
  private static readonly DEDUPE_WINDOW_MS = 1_500

  private recent = new Map<string, number>()

  constructor(private readonly deps: Deps) {}

  onChat(
    observer: ChatSession,
    speakerUsername: string,
    message: string,
    speakerPosition: Position | null,
  ): void {
    if (observer.username === speakerUsername) {
      return // self-filter: the echo loop dies here
    }
    const now = this.deps.now?.() ?? Date.now()
    const key = `${speakerUsername}|${message}`
    const seenAt = this.recent.get(key)
    if (seenAt !== undefined && now - seenAt < ChatRouter.DEDUPE_WINDOW_MS) {
      return // another session already reported this line
    }
    this.recent.set(key, now)
    this.gc(now)

    // Speaker position: their entity as seen by the observer, else fall back
    // to the observer's own position (chat is global; position is best-effort).
    const position = speakerPosition ?? observer.position ?? { x: 0, y: 0, z: 0 }
    const heardByIds = this.deps
      .activeSessions()
      .filter((s) => s.username !== speakerUsername)
      .filter((s) => s.position !== null && distance(s.position, position) <= this.deps.earshotBlocks)
      .map((s) => s.villagerId)

    this.deps.emit({
      speakerVillagerId: this.deps.rosterByUsername(speakerUsername) ?? null,
      speakerUsername,
      message,
      heardByIds,
      position,
    })
  }

  private gc(now: number): void {
    if (this.recent.size < 500) {
      return
    }
    for (const [key, at] of this.recent) {
      if (now - at > ChatRouter.DEDUPE_WINDOW_MS * 2) {
        this.recent.delete(key)
      }
    }
  }
}
