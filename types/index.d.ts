/** A cold send the guard is holding until the person picks a button. */
export type Held = {
  /** The message as typed. */
  text: string
  /** The context the resend would re-write, in tokens. */
  tokens: number
  /** The cache-write rate as shown, such as `$10/MTok`. */
  rate: string
  /** What sending now costs: the re-write at the cache-write rate; null when the model has no price row. */
  coldUsd: number | null
  /** What a warm turn would have cost: the same context at the cache-read rate. */
  warmUsd: number | null
  /** Shown by `/cache-watch preview`: nothing is held, and every button only closes the card. */
  isPreview?: boolean
}

/** A paid cold write, shown as a pill under the row until the next prompt or for 15 minutes. */
export type Receipt = {
  /** Tokens the write re-wrote. */
  tokens: number
  /** What it cost at list prices; null when the model has no price row. */
  usd: number | null
  /** When it was scored, in `$.clock.now()` milliseconds. */
  at: number
  /** How long keepwarm now holds the cache, in milliseconds; 0 when no new window was armed. */
  warmForMs: number
  /** Why the message went through without the card, when it did. */
  note: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'cache-watch': { held: Held | null; showStatus: boolean; receipt: Receipt | null }
  }
}
