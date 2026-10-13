// cache-watch: karanb192/cache-tax 2.2.1 (MIT) with a hold card. A cold send
// is held above the prompt with its price and three buttons, instead of being
// dropped with the price as text. Everything else is upstream's.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import type { Held, Receipt, ResumeNote } from '../types'
import { statusIcons } from './status-icons'

const TTL_MS = 60 * 60 * 1000
const PING_AFTER_MS = 55 * 60 * 1000
const MIN_PING_MS = 60 * 1000
const AUTO_WARM_MS = 3 * 60 * 60 * 1000
const RESUME_TIP = "A cold cache means the AI has to re-read everything in the session all over again. If the juice isn't worth the squeeze, consider starting a fresh chat."
const DEFAULT_WINDOW_MS = 6 * 60 * 60 * 1000
const BIG_TOKENS = 50000
const PING_PROMPT = 'Reply with the single word: warm'
const KEY_DEADLINE = 'deadline'
const KEY_EVERY = 'every'
const KEY_GUARD = 'guard'
const KEY_ALWAYS = 'always'
const KEY_FOOTER = 'footer'

// $ per million tokens, [cache read, 1h cache write, output], list prices September 2026.
// Longer family names first: a model id matches the first row it contains.
const PRICES: Array<[string, number, number, number]> = [
  ['fable-5-1', 0.25, 20, 50],
  ['fable-5', 1, 20, 50],
  ['opus-5', 0.5, 10, 25],
  ['opus-4', 0.5, 10, 25],
  ['sonnet-5', 0.2, 4, 10],
  ['sonnet', 0.3, 6, 15],
  ['haiku', 0.1, 2, 5],
]

type PingRecord = { at: number; read: number; write: number; usd: number | null; warm: boolean }
type Miss = { at: number; tokens: number; usd: number | null }
type GuardMode = 'refuse' | 'warn'

export type State = {
  hasBand: boolean
  sid: string
  deadline: number
  every: number
  always: boolean
  lastRequestAt: number
  lastModel: string | null
  ctx: number
  compacted: boolean
  guard: GuardMode
  ackedAt: number
  coldWritePending: boolean
  misses: Miss[]
  pending: { cancel: () => void } | null
  last: PingRecord | null
  stopped: string | null
  /** Why the pending cold write went through without the card, for its receipt. */
  note: string | null
}

function priceOf(model: string | null): [number, number, number] | null {
  const m = (model ?? '').toLowerCase().replace(/[\s.]+/g, '-')
  for (const [family, read, write, output] of PRICES) if (m.includes(family)) return [read, write, output]
  return null
}

export function parseDuration(text: string): number | null {
  const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(text.trim())
  if (!m || (m[1] === undefined && m[2] === undefined)) return null
  return (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60 * 1000
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 60000))
  const h = Math.floor(total / 60)
  const m = total % 60
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

function fmtUsd(usd: number | null): string {
  return usd == null ? 'n/a' : '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function coldUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[1] / 1e6 : null
}

function warmUsd(s: State): number | null {
  const price = priceOf(s.lastModel)
  return price ? s.ctx * price[0] / 1e6 : null
}

/** Everything a fork bills: the cache read, any cache write, uncached input at the base rate (half the 1h write rate), and the output. */
function pingUsd(u: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }, price: [number, number, number]): number {
  return (u.cache_read_input_tokens * price[0] + u.cache_creation_input_tokens * price[1] + u.input_tokens * price[1] / 2 + u.output_tokens * price[2]) / 1e6
}

/** The read-only upper bound: pings at the cache-read rate that cost as much as one cold write of the same context. */
function breakEvenPings(s: State): number | null {
  const price = priceOf(s.lastModel)
  if (!price || s.ctx <= 0) return null
  return Math.floor(price[1] / price[0])
}

function isCold(s: State, now: number): boolean {
  return s.lastRequestAt > 0 && !s.compacted && now - s.lastRequestAt >= TTL_MS
}

function guardText(s: State, now: number): string {
  const price = priceOf(s.lastModel)
  const rate = price ? `$${price[1]}/MTok` : 'the cache-write rate'
  const warm = warmUsd(s)
  return `the prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago. Sending this re-writes ` +
    `up to ${s.ctx.toLocaleString('en-US')} tokens at ${rate} = ${fmtUsd(coldUsd(s))}` +
    (warm == null ? '' : ` (a warm turn would have cost ${fmtUsd(warm)})`) + '.'
}

export type ResumeFields = {
  source: string
  model?: string
  context_tokens?: number
  seconds_since_last_response?: number
  prompt_cache_likely_expired?: boolean
  estimated_cache_write_usd?: number
}

/** /clear starts a new conversation in the same process; nothing priced before it still exists. */
export function resetForClear(s: State) {
  s.ctx = 0
  s.lastRequestAt = 0
  s.compacted = false
  s.ackedAt = 0
  s.coldWritePending = false
  s.misses = []
  disarm(s)
}

/** Applies a resumed session's fields to the state; returns the line to log, if any. */
export function seedFromResume(s: State, e: ResumeFields, now: number): string | null {
  if (e.source !== 'resume' && e.source !== 'fork') return null
  if (typeof e.context_tokens === 'number' && e.context_tokens > 0) s.ctx = e.context_tokens
  if (typeof e.seconds_since_last_response === 'number') s.lastRequestAt = now - e.seconds_since_last_response * 1000
  if (typeof e.model === 'string') s.lastModel = e.model
  s.compacted = false
  if (e.prompt_cache_likely_expired !== true || s.ctx < BIG_TOKENS) return null
  const usd = typeof e.estimated_cache_write_usd === 'number' ? fmtUsd(e.estimated_cache_write_usd) : fmtUsd(coldUsd(s))
  return `resuming cold. The first message re-writes ${s.ctx.toLocaleString('en-US')} tokens, about ${usd}. ${RESUME_TIP}`
}

/** The resume card's figures: Claude Code's own estimate of the cold write when the resume carried one, else the price table's. */
export function resumeNoteFrom(s: State, estimate: unknown): ResumeNote {
  const price = priceOf(s.lastModel)
  const engine = typeof estimate === 'number' && s.ctx > 0
  return {
    tokens: s.ctx,
    rate: engine ? `$${Number((estimate / s.ctx * 1e6).toPrecision(2))}/MTok` : price ? `$${price[1]}/MTok` : 'the cache-write rate',
    coldUsd: engine ? estimate : coldUsd(s),
    warmUsd: warmUsd(s),
  }
}

/** The row above the prompt: keepwarm's status while a window is armed, else the cache clock on its own. */
export function rowText(s: State, now: number): string | undefined {
  const keepwarm = statusText(s, now)
  if (keepwarm) return keepwarm
  if (!s.lastRequestAt || s.compacted) return undefined
  return isCold(s, now) ? `cold for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}` : `goes cold in ${fmtDuration(s.lastRequestAt + TTL_MS - now)}`
}

function statusText(s: State, now: number): string | undefined {
  if (s.stopped) return `keepwarm stopped: ${s.stopped}`
  if (!s.deadline) return undefined
  const pingText = s.last ? ` · last ping read ${fmtTok(s.last.read)} ${fmtUsd(s.last.usd)}` : ''
  const nextText = !s.lastRequestAt ? ' · waiting for the first turn'
    : s.compacted ? ' · waiting for the first turn after compaction'
    : isCold(s, now) ? ` · cold now, first ping ${fmtDuration(s.every)} after the next turn`
    : ` · ping in ${fmtDuration(s.lastRequestAt + s.every - now)}`
  return `keepwarm ${fmtDuration(s.deadline - now)} left${nextText}${pingText}`
}

function updateStatus($: EngineInterface, s: State, now: number) {
  if (s.hasBand) $.ui.invalidate('ui.render')
  else $.ui.status(rowText(s, now))
}

/**
 * The status in the prompt footer, beside the app's own mode labels (`SessionMode`), instead of a
 * row in the band. The Code tab draws a Box and coloured Text there but drops an Svg, and cuts the
 * label at about 26 characters, so it says less than the row did: `/keepwarm status` has the rest.
 */
export type FooterMode = 'on' | 'off'

export type FooterLabel = { state: 'warm' | 'cold' | null; detail: string; sep: ' · ' | ' ' }

/**
 * A warm cache always reads `cache warm · 2h07m left`: how long it stays warm, keepwarm's window while
 * one runs, else until its hour runs out. A cold one reads `cache cold for 6m`. Before the first turn
 * there is no state: `cache · keepwarm 2h07m` or `cache · keepwarm stopped`. 24 characters at most,
 * because the font's digits differ in width and `cache warm · keepwarm 6h00m` (27) was cut where
 * `… 5h58m` fitted.
 */
export function footerLabel(s: State, now: number): FooterLabel | undefined {
  if (s.deadline && now >= s.deadline) return undefined
  if (!s.lastRequestAt || s.compacted) {
    if (s.deadline) return { state: null, detail: `keepwarm ${fmtDuration(s.deadline - now)}`, sep: ' · ' }
    return s.stopped ? { state: null, detail: 'keepwarm stopped', sep: ' · ' } : undefined
  }
  if (isCold(s, now)) return { state: 'cold', detail: `for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}`, sep: ' ' }
  const left = s.deadline ? s.deadline - now : s.lastRequestAt + TTL_MS - now
  return { state: 'warm', detail: `${fmtDuration(left)} left`, sep: ' · ' }
}

export const isBandSurface = (surface: unknown) => surface === 'terminal' || surface === 'desktop'

/** Whether a surface that draws the band is attached now. session.start's own `surface` is null when a host such as the desktop app runs the session. */
async function hasBandSurface($: EngineInterface): Promise<boolean> {
  try {
    return (await $.session.surfaces()).some(isBandSurface)
  } catch {
    return false
  }
}

/** How soon the row next changes: each minute while a countdown shows, every 5 minutes while the cache sits cold with keepwarm off. */
export function tickDelay(s: State, now: number): number {
  return s.deadline || (s.lastRequestAt && !isCold(s, now)) ? 60 * 1000 : 5 * 60 * 1000
}

/** The row's tick: it redraws, or the status entry is rewritten where no band draws, then schedules the next. */
async function tick($: EngineInterface, s: State) {
  const now = await $.clock.now()
  updateStatus($, s, now)
  $.clock.after(tickDelay(s, now), () => { void tick($, s) })
}

function disarm(s: State) {
  if (s.pending) s.pending.cancel()
  s.pending = null
}

// The window and its ping period belong to the session that armed them, so a
// second session, or one resumed from another transcript, never inherits them
// and cannot turn them off. The always switch and the guard mode stay global.
function deadlineKey(s: State): string {
  return `${KEY_DEADLINE}:${s.sid}`
}

function everyKey(s: State): string {
  return `${KEY_EVERY}:${s.sid}`
}

/** Clears this session's own dead window and the bare keys a store written before 2.1.1 still holds. Other sessions' keys are never touched: a read followed by a delete cannot be made atomic against their renewal. */
async function prune($: EngineInterface, s: State, now: number) {
  for (const key of [KEY_DEADLINE, deadlineKey(s)]) {
    const deadline = await $.store.get(key)
    if (deadline === undefined) continue
    if (typeof deadline === 'number' && deadline > now) continue
    await $.store.delete(key)
    await $.store.delete(KEY_EVERY + key.slice(KEY_DEADLINE.length))
  }
}

async function stop($: EngineInterface, s: State, why: string | null, forgetAlways = false) {
  s.deadline = 0
  s.every = PING_AFTER_MS
  s.stopped = why
  disarm(s)
  await $.store.delete(deadlineKey(s))
  await $.store.delete(everyKey(s))
  if (forgetAlways) {
    s.always = false
    await $.store.delete(KEY_ALWAYS)
  }
  updateStatus($, s, await $.clock.now())
}

async function arm($: EngineInterface, s: State) {
  disarm(s)
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return stop($, s, null)
  // A cold window still needs expiry cleanup, but must not send a model request.
  if (s.lastRequestAt && !s.compacted && !isCold(s, now)) {
    const untilCold = s.lastRequestAt + TTL_MS - now
    const delay = Math.min(s.deadline - now, untilCold, Math.max(1000, s.lastRequestAt + s.every - now))
    s.pending = $.clock.after(delay, () => { void ping($, s) })
  } else {
    s.pending = $.clock.after(s.deadline - now, () => { void arm($, s) })
  }
  updateStatus($, s, now)
}

async function ping($: EngineInterface, s: State) {
  s.pending = null
  if (!s.deadline) return
  const now = await $.clock.now()
  if (now >= s.deadline) return arm($, s)
  // A turn in the meantime re-armed the timer; this callback is stale.
  if (isCold(s, now)) return arm($, s)
  if (now - s.lastRequestAt < s.every - 1000) return
  let reply
  try {
    reply = await $.model.fork({ prompt: PING_PROMPT })
  } catch (err) {
    return stop($, s, `the ping failed, ${err instanceof Error ? err.message : String(err)}`)
  }
  if (reply === null) return stop($, s, 'the engine did not send the ping, either the snapshot was cold or the API call failed')
  if (reply.isAnswered === false) {
    const reason = reply.reason === 'nothing-to-fork' ? 'no conversation to warm yet'
      : reply.reason === 'api-error' ? `the API call failed${reply.status === null ? '' : ` (${reply.status})`}`
      : reply.reason === 'aborted' ? 'the ping was interrupted'
      : 'the ping returned no text'
    return stop($, s, reason)
  }
  const u = reply.usage
  const price = priceOf(s.lastModel)
  // A warm ping reads the prefix and writes only its own message; a write of a tenth of the read or more means the prefix broke.
  const warm = u.cache_read_input_tokens > 0 && u.cache_creation_input_tokens < 0.1 * u.cache_read_input_tokens
  const usd = price ? pingUsd(u, price) : null
  s.last = { at: now, read: u.cache_read_input_tokens, write: u.cache_creation_input_tokens, usd, warm }
  if (!warm) return stop($, s, `the ping read ${fmtTok(u.cache_read_input_tokens)} and wrote ${fmtTok(u.cache_creation_input_tokens)} tokens (${fmtUsd(usd)}), the cache was already gone`)
  s.lastRequestAt = now
  await arm($, s)
}

/** The reply to an arming command; on a cold cache it says when the first ping can come. */
function armedText(s: State, now: number, windowMs: number): string {
  if (isCold(s, now)) return `keepwarm on for ${fmtDuration(windowMs)}. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn`
  return `keepwarm on for ${fmtDuration(windowMs)}, a ping ${fmtDuration(s.every)} after each idle stretch keeps the cache read, not re-written`
}

async function startWindow($: EngineInterface, s: State, windowMs: number, every: number) {
  const now = await $.clock.now()
  s.every = every
  if (every === PING_AFTER_MS) await $.store.delete(everyKey(s))
  else await $.store.set(everyKey(s), every)
  s.deadline = now + windowMs
  s.stopped = null
  await $.store.set(deadlineKey(s), s.deadline)
  await arm($, s)
}

function card(s: State, now: number): string {
  const lines: string[] = []
  lines.push(`${s.lastModel ?? 'model not seen yet'}`)
  if (s.compacted) lines.push('state       reset by compaction, waiting for the first turn')
  else if (!s.lastRequestAt) lines.push('state       no request yet this session')
  else if (isCold(s, now)) lines.push(`state       COLD, last request ${fmtDuration(now - s.lastRequestAt)} ago`)
  else lines.push(`state       warm, ${fmtDuration(s.lastRequestAt + TTL_MS - now)} left`)
  lines.push(`context     ${s.ctx.toLocaleString('en-US')} tokens`)
  lines.push(`cold cost   ${fmtUsd(coldUsd(s))} to re-write it (warm turn ${fmtUsd(warmUsd(s))})`)
  const always = s.always ? ' (always)' : ''
  const idle = s.always ? 'off until the next session start, which arms 6h00m (always)' : 'off (/keepwarm to arm it for 6h00m)'
  lines.push(`keepwarm    ${s.deadline ? (statusText(s, now) ?? '').replace(/^keepwarm /, 'on, ') + always : s.stopped ? `stopped, ${s.stopped}${always}` : idle}`)
  const pings = breakEvenPings(s)
  if (pings != null) lines.push(`break-even  up to ${pings} pings at the read rate cost one cold write, about ${fmtDuration(pings * s.every)} of idle at one ping per ${fmtDuration(s.every)}`)
  lines.push(`guard       ${s.guard === 'refuse' ? 'refuse once (/cache-watch guard warn to only show the price)' : 'warn only (/cache-watch guard refuse to be stopped once)'}`)
  const paid = s.misses.reduce((a, m) => a + (m.usd ?? 0), 0)
  lines.push(`session     ${s.misses.length} cold write${s.misses.length === 1 ? '' : 's'} paid, ${fmtUsd(paid)}`)
  return lines.join('\n')
}

// ---- The hold card ----

const held = atom({ plugin: 'cache-watch', key: 'held' } as const, null)
const showStatus = atom({ plugin: 'cache-watch', key: 'showStatus' } as const, false)
const receipt = atom({ plugin: 'cache-watch', key: 'receipt' } as const, null)
const resumed = atom({ plugin: 'cache-watch', key: 'resumed' } as const, null)
/** How long a cold resume waits for a band before it logs its plain line instead: the desktop app attaches after the session starts. */
export const RESUME_LOG_AFTER_MS = 3000
export const RECEIPT_MS = 15 * 60 * 1000
export const HELD_DROP = 'Held by Cache Watch. Choose an option above the prompt box, or send it again to pay.'
const QUOTE_MAX = 160

export function heldFrom(s: State, text: string): Held {
  const price = priceOf(s.lastModel)
  return { text, tokens: s.ctx, rate: price ? `$${price[1]}/MTok` : 'the cache-write rate', coldUsd: coldUsd(s), warmUsd: warmUsd(s) }
}

/** A plugin's resend expands no @file mention and carries no pasted item, so those prompts keep the refuse-once path. */
export function canHold(text: string, attachments: readonly unknown[] | undefined): boolean {
  return !(attachments && attachments.length > 0) && !/(^|\s)@\S/.test(text)
}

/** The held message on one line, cut with an ellipsis past QUOTE_MAX characters. */
export function quoted(text: string): string {
  // The renderer refuses control and format characters, and a refused tree loses the whole card.
  const one = text.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim()
  return one.length > QUOTE_MAX ? one.slice(0, QUOTE_MAX - 1).trimEnd() + '…' : one
}

/** The warm bar's length against the cold one: their price ratio, kept long enough to see. */
export function warmShare(h: Held): number {
  if (h.coldUsd == null || h.warmUsd == null || h.coldUsd <= 0) return 0.04
  return Math.min(1, Math.max(0.025, h.warmUsd / h.coldUsd))
}

function esc(t: string): string {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// The SVG is drawn as an image, so it cannot read the theme: the module picks the palette.
// Panel and track are translucent so they sit on whatever the band's background is.
const PALETTE = {
  dark: { panel: '#000000', panelOpacity: 0.22, track: '#ffffff', trackOpacity: 0.09, label: '#d6d3c9', caption: '#a3a097', cold: '#e58a62', warm: '#7ccf9c', icon: '#a3a097' },
  light: { panel: '#141413', panelOpacity: 0.045, track: '#141413', trackOpacity: 0.09, label: '#3b3934', caption: '#6a675f', cold: '#c15f3c', warm: '#2e7a4c', icon: '#6a675f' },
}
const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"

export function statsAlt(h: Held): string {
  return `Send it now: ${fmtUsd(h.coldUsd)}, re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}. ` +
    `A warm turn: ${fmtUsd(h.warmUsd)}, what it would have cost.`
}

/** The two price columns as one SVG, so the figures can be large; mod text has no size. */
export function statsSvg(h: Held, light: boolean): string {
  const p = PALETTE[light ? 'light' : 'dark']
  const W = 680
  const H = 132
  const PAD = 24
  const COL = (W - 3 * PAD) / 2
  const column = (x: number, label: string, figure: string, color: string, share: number, caption: string) => {
    const size = Math.max(10.5, Math.min(13, COL / (caption.length * 0.52)))
    return `<text x="${x}" y="34" font-size="14" font-weight="600" fill="${p.label}">${esc(label)}</text>` +
      `<text x="${x}" y="74" font-size="32" font-weight="700" fill="${color}" style="font-variant-numeric:tabular-nums">${esc(figure)}</text>` +
      `<rect x="${x}" y="88" width="${COL}" height="6" rx="3" fill="${p.track}" fill-opacity="${p.trackOpacity}"/>` +
      `<rect x="${x}" y="88" width="${(COL * share).toFixed(1)}" height="6" rx="3" fill="${color}"/>` +
      `<text x="${x}" y="116" font-size="${size.toFixed(1)}" fill="${p.caption}">${esc(caption)}</text>`
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
    `<rect width="${W}" height="${H}" rx="12" fill="${p.panel}" fill-opacity="${p.panelOpacity}"/>` +
    column(PAD, 'Send it now', fmtUsd(h.coldUsd), p.cold, 1, `re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`) +
    column(PAD * 2 + COL, 'A warm turn', fmtUsd(h.warmUsd), p.warm, warmShare(h), 'what it would have cost') +
    '</svg>'
}

/**
 * The compact card's two price rows as one short Svg: desktop Text is proportional, so block-glyph
 * bars break into dotted fragments there. Captions are the first thing to go when the band is narrow.
 */
export function compactStatsSvg(h: Held, light: boolean, width: number): string {
  const p = PALETTE[light ? 'light' : 'dark']
  const W = Math.round(width)
  const H = 44
  const withCaptions = W >= 560
  const barX = 150
  const barEnd = withCaptions ? W - 270 : W - 4
  const barW = Math.max(40, barEnd - barX)
  const row = (y: number, label: string, figure: string, color: string, share: number, caption: string) =>
    `<text x="0" y="${y}" font-size="12.5" fill="${p.label}">${esc(label)}</text>` +
    `<text x="92" y="${y}" font-size="13" font-weight="700" fill="${color}" style="font-variant-numeric:tabular-nums">${esc(figure)}</text>` +
    `<rect x="${barX}" y="${y - 7}" width="${barW}" height="6" rx="3" fill="${p.track}" fill-opacity="${p.trackOpacity}"/>` +
    `<rect x="${barX}" y="${y - 7}" width="${Math.max(6, barW * share).toFixed(1)}" height="6" rx="3" fill="${color}"/>` +
    (withCaptions ? `<text x="${barX + barW + 12}" y="${y}" font-size="12" fill="${p.caption}">${esc(caption)}</text>` : '')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">` +
    row(16, 'Send it now', fmtUsd(h.coldUsd), p.cold, 1, `re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`) +
    row(38, 'A warm turn', fmtUsd(h.warmUsd), p.warm, warmShare(h), 'what it would have cost') +
    '</svg>'
}

export function pauseSvg(light: boolean): string {
  const c = PALETTE[light ? 'light' : 'dark'].icon
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round">` +
    '<circle cx="8" cy="8" r="6.75"/><path d="M6.5 5.5v5M9.5 5.5v5"/></svg>'
}

export function shieldSvg(light: boolean): string {
  const c = PALETTE[light ? 'light' : 'dark'].warm
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="${c}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">` +
    '<path d="M8 1.75 13.25 3.75v3.9c0 3.05-2.2 5.35-5.25 6.6-3.05-1.25-5.25-3.55-5.25-6.6v-3.9Z"/><path d="m5.6 8.1 1.65 1.65 3.15-3.3"/></svg>'
}

async function release($: EngineInterface) {
  await update($, held, () => null)
  await update($, showStatus, () => false)
}

async function payAndSend($: EngineInterface, s: State) {
  const h = await read($, held)
  if (!h) return
  await release($)
  if (h.isPreview) return
  // The resend is the paid cold write: turn.complete scores it and arms keepwarm.
  s.ackedAt = 0
  s.coldWritePending = true
  await $.prompt.submit({ text: h.text, asUser: true })
}

async function startFresh($: EngineInterface) {
  const h = await read($, held)
  if (!h) return
  await release($)
  if (h.isPreview) return
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    $.ui.toast('cache-watch: the conversation was not cleared. Type /clear, then send your message.')
  }
  // The message waits in the box for the new conversation, to send or edit.
  await $.prompt.fill({ text: h.text })
}

/** Start fresh from the resume card: nothing is held, so it only clears. */
async function freshFromResume($: EngineInterface) {
  await update($, resumed, () => null)
  try {
    await $.command.run({ command: 'clear' })
  } catch {
    $.ui.toast('cache-watch: the conversation was not cleared. Type /clear to start fresh.')
  }
}

/** A surface that never drew the band gets the resume note as the plain line upstream logged. */
async function resumeFallback($: EngineInterface, s: State, line: string) {
  if (s.hasBand || !(await read($, resumed))) return
  await update($, resumed, () => null)
  $.ui.log(line)
}

export function receiptText(r: Receipt): string {
  const keep = r.warmForMs > 0 ? ` Keepwarm holds the cache for ${fmtDuration(r.warmForMs)}.` : ''
  return `Cold write paid: ${fmtUsd(r.usd)} for ${fmtTok(r.tokens)} tokens.${keep}`
}

/** A terminal bar: the filled cells and the track left after them. */
export function bar(share: number, cells: number): [string, string] {
  const filled = Math.max(1, Math.min(cells, Math.round(cells * share)))
  return ['█'.repeat(filled), '░'.repeat(cells - filled)]
}

export function freshState(): State {
  return {
    hasBand: false, sid: '', deadline: 0, every: PING_AFTER_MS, always: false, lastRequestAt: 0, lastModel: null, ctx: 0, compacted: false,
    guard: 'refuse', ackedAt: 0, coldWritePending: false, misses: [], pending: null, last: null, stopped: null, note: null,
  }
}

export const register: Register = on => {
  const s = freshState()
  let light = false
  let noColor = false
  let footer: FooterMode = 'on'
  // Where the footer has drawn: the band drops its row only on a surface whose footer has shown up.
  const footerSeen = { count: 0, surface: '', modes: [] as readonly string[] }

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    if (result.deny === undefined) {
      light = typeof result.value === 'string' && result.value.startsWith('light')
      if (s.hasBand) $.ui.invalidate('ui.render')
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // next(e) rejects when nothing sits beneath (colorwheel); an empty Box keeps this band drawing.
    const rest = await next(e).catch(() => $.ui.resolve(e).Box({ children: [] }))
    if (!s.hasBand && isBandSurface(e.surface)) {
      // The desktop app attaches after session.start, which saw no surface; its first band draw says it is here.
      s.hasBand = true
      $.clock.after(0, () => { $.ui.status(undefined) })
    }
    if (!s.hasBand || e.props.hasSurvey) return rest
    const now = await $.clock.now()
    const h = await read($, held)
    if (h) {
      const { Box, Text, Button, Markdown } = $.ui.resolve(e)
      const isOpen = await read($, showStatus)
      const theme = light ? 'light' : 'dark'
      const cold = noColor ? undefined : 'claude'
      const warm = noColor ? undefined : 'success'
      // Short alts: one builder reports an Svg with an empty alt does not draw on the desktop.
      const icon = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: statusIcons[theme].cold.svg, width: 40, height: 40, alt: 'Cache Watch' })
        : e.surface === 'terminal' && !noColor ? $.ui.resolve(e).Image({ source: { png: statusIcons[theme].cold.png }, columns: 3, rows: 1, alt: '[>]' })
        : Text({ color: cold, bold: true, children: ['[>]'] })
      const pause = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: pauseSvg(light), width: 16, height: 16, alt: 'On hold' })
        : Text({ dimColor: true, children: ['‖'] })
      const shield = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: shieldSvg(light), width: 16, height: 16, alt: 'Keepwarm' })
        : Text({ color: warm, children: ['✓'] })
      // A band taller than maxRows scrolls in its own window, which could hide the buttons. The full card
      // is about 23 rows on the desktop (its price panel draws taller than text rows) and 17 in a terminal.
      const compact = e.props.maxRows < (e.surface === 'desktop' ? 24 : 18)
      let stats
      if (e.surface === 'desktop' && !compact) {
        // An Svg without width and height keeps a 300 by 150 frame (nakadadev). About 8 px per column, less the card's padding.
        const width = Math.max(320, Math.min(680, e.props.bodyColumns * 8 - 48))
        stats = $.ui.resolve(e).Svg({ source: statsSvg(h, light), alt: statsAlt(h), width, height: Math.round(width * 132 / 680) })
      } else if (e.surface === 'desktop') {
        // Compact on the desktop: two thin bars in one short Svg, never block glyphs in proportional Text.
        const width = Math.max(280, Math.min(680, e.props.bodyColumns * 8 - 32))
        stats = $.ui.resolve(e).Svg({ source: compactStatsSvg(h, light, width), alt: statsAlt(h), width, height: 44 })
      } else {
        const cells = Math.max(6, Math.min(24, Math.floor((e.props.bodyColumns - 40) / 2)))
        const [coldFill, coldTrack] = bar(1, cells)
        const [warmFill, warmTrack] = bar(warmShare(h), cells)
        stats = Box({ flexDirection: 'column', children: [
          Text({ children: [
            Text({ dimColor: true, children: ['Send it now  '] }),
            Text({ color: cold, bold: true, children: [fmtUsd(h.coldUsd).padEnd(8)] }),
            Text({ color: cold, children: [coldFill] }),
            Text({ dimColor: true, children: [coldTrack, `  re-writes up to ${h.tokens.toLocaleString('en-US')} tokens at ${h.rate}`] }),
          ] }),
          Text({ children: [
            Text({ dimColor: true, children: ['A warm turn  '] }),
            Text({ color: warm, bold: true, children: [fmtUsd(h.warmUsd).padEnd(8)] }),
            Text({ color: warm, children: [warmFill] }),
            Text({ dimColor: true, children: [warmTrack, '  what it would have cost'] }),
          ] }),
        ] })
      }
      const statusCard = isOpen ? [Markdown({ key: 'status-card', dimColor: true, text: '```\n' + card(s, now) + '\n```' })] : []
      const coldFor = h.isPreview ? 'preview, nothing is held' : `cold for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}`
      const holdCard = compact ? Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
        Text({ wrap: 'truncate-end', children: [
          Text({ color: cold, bold: true, children: ['CACHE WATCH'] }),
          Text({ dimColor: true, children: [' · '] }),
          Text({ bold: true, children: ['Your message is on hold'] }),
          Text({ dimColor: true, children: [` · ${coldFor}`] }),
        ] }),
        stats,
        Text({ wrap: 'truncate-end', children: [`On hold: “${quoted(h.text)}”`] }),
        ...statusCard,
      ] }) : Box({ flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 2, paddingY: 1, gap: 1, children: [
        Box({ flexDirection: 'row', gap: 2, alignItems: 'center', children: [
          Box({ flexShrink: 0, children: [icon] }),
          Box({ flexDirection: 'column', children: [
            Text({ color: cold, bold: true, children: ['CACHE WATCH'] }),
            Text({ bold: true, children: ['Your message is on hold'] }),
            Text({ dimColor: true, children: [h.isPreview
              ? 'Preview: nothing is held. Any button closes it.'
              : `The prompt cache went cold ${fmtDuration(now - s.lastRequestAt - TTL_MS)} ago.`] }),
          ] }),
        ] }),
        stats,
        Box({ flexDirection: 'column', children: [
          Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
            Box({ flexShrink: 0, children: [pause] }),
            Text({ wrap: 'wrap', children: [`On hold: “${quoted(h.text)}”`] }),
          ] }),
          Box({ flexDirection: 'row', gap: 1, alignItems: 'center', children: [
            Box({ flexShrink: 0, children: [shield] }),
            Text({ wrap: 'wrap', children: [`Pay once and keepwarm then holds the cache for ${fmtDuration(AUTO_WARM_MS)}.`] }),
          ] }),
        ] }),
        ...statusCard,
      ] })
      const buttons = Box({ flexDirection: 'row', gap: 2, alignItems: 'center', children: [
        Button({ key: 'pay', label: 'Pay and send', variant: 'primary', onPress: () => { void payAndSend($, s) } }),
        Button({ key: 'fresh', label: 'Start fresh', onPress: () => { void startFresh($) } }),
        Button({ key: 'status', label: isOpen ? 'Hide cache status' : 'Show cache status', plain: true, onPress: () => { void update($, showStatus, open => !open) } }),
      ] })
      return Box({ flexDirection: 'column', gap: compact ? 0 : 1, children: [rest, holdCard, buttons] })
    }
    // A cold resume's note, styled like the compact hold card, in place of a transcript line no hook can restyle.
    const note = await read($, resumed)
    const notice: RenderElement[] = []
    if (note) {
      const { Box, Text, Button } = $.ui.resolve(e)
      const figures: Held = { ...note, text: '' }
      let stats
      if (e.surface === 'desktop') {
        const width = Math.max(280, Math.min(680, e.props.bodyColumns * 8 - 32))
        stats = $.ui.resolve(e).Svg({ source: compactStatsSvg(figures, light, width), alt: statsAlt(figures), width, height: 44 })
      } else {
        const cells = Math.max(6, Math.min(24, Math.floor((e.props.bodyColumns - 40) / 2)))
        const [coldFill, coldTrack] = bar(1, cells)
        const [warmFill, warmTrack] = bar(warmShare(figures), cells)
        stats = Box({ flexDirection: 'column', children: [
          Text({ children: [
            Text({ dimColor: true, children: ['Send it now  '] }),
            Text({ color: noColor ? undefined : 'claude', bold: true, children: [fmtUsd(figures.coldUsd).padEnd(8)] }),
            Text({ color: noColor ? undefined : 'claude', children: [coldFill] }),
            Text({ dimColor: true, children: [coldTrack, `  re-writes up to ${figures.tokens.toLocaleString('en-US')} tokens at ${figures.rate}`] }),
          ] }),
          Text({ children: [
            Text({ dimColor: true, children: ['A warm turn  '] }),
            Text({ color: noColor ? undefined : 'success', bold: true, children: [fmtUsd(figures.warmUsd).padEnd(8)] }),
            Text({ color: noColor ? undefined : 'success', children: [warmFill] }),
            Text({ dimColor: true, children: [warmTrack, '  what it would have cost'] }),
          ] }),
        ] })
      }
      const coldFor = s.lastRequestAt && isCold(s, now) ? ` · cold for ${fmtDuration(now - s.lastRequestAt - TTL_MS)}` : ''
      notice.push(
        Box({ key: 'resume', flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
          Text({ wrap: 'truncate-end', children: [
            Text({ color: noColor ? undefined : 'claude', bold: true, children: ['CACHE WATCH'] }),
            Text({ dimColor: true, children: [' · '] }),
            Text({ bold: true, children: ['Resuming a cold chat'] }),
            Text({ dimColor: true, children: [coldFor] }),
          ] }),
          stats,
          Text({ wrap: 'wrap', children: [RESUME_TIP] }),
        ] }),
        Box({ key: 'resume-buttons', flexDirection: 'row', gap: 2, alignItems: 'center', children: [
          Button({ key: 'resume-fresh', label: 'Start fresh', onPress: () => { void freshFromResume($) } }),
          Button({ key: 'resume-dismiss', label: 'Dismiss', plain: true, onPress: () => { void update($, resumed, () => null) } }),
        ] }),
      )
    }
    const text = rowText(s, now)
    if (!text || (s.deadline && now >= s.deadline)) return notice.length ? $.ui.resolve(e).Box({ flexDirection: 'column', children: [rest, ...notice] }) : rest
    const state = s.stopped ? 'stopped' : !s.lastRequestAt || s.compacted ? 'unknown' : isCold(s, now) ? 'cold' : 'warm'
    const color = noColor ? undefined : state === 'warm' ? 'success' : state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const { Box, Text } = $.ui.resolve(e)
    const asset = statusIcons[light ? 'light' : 'dark'][state === 'warm' || state === 'cold' ? state : 'neutral']
    const icon = noColor ? Text({ bold: true, children: ['[>]'] })
      : e.surface === 'terminal' ? $.ui.resolve(e).Image({ source: { png: asset.png }, columns: 3, rows: 1, alt: '[>]' })
      : e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: asset.svg, width: 18, height: 18, alt: 'Cache Watch' })
      : Text({ color, bold: true, children: ['[>]'] })
    // Separators are dim so the state and the figures carry the row.
    const dot = () => Text({ dimColor: true, children: [' · '] })
    const row = Box({ flexDirection: 'row', alignItems: 'center', gap: 1, children: [
      Box({ flexShrink: 0, children: [icon] }),
      Text({ wrap: 'truncate-end', children: [
        'cache-watch',
        dot(),
        Text({ color, bold: true, children: [state] }),
        ...text.split(' · ').flatMap(part => [dot(), part]),
      ] }),
    ] })
    const rows = footer === 'on' && footerSeen.surface === e.surface ? [] : [row]
    const paid = await read($, receipt)
    if (!paid || now - paid.at >= RECEIPT_MS) return rows.length || notice.length ? Box({ flexDirection: 'column', children: [rest, ...notice, ...rows] }) : rest
    // The paid write as a pill under the row: what the log line said, drawn where it can be styled.
    const shield = e.surface === 'desktop' ? $.ui.resolve(e).Svg({ source: shieldSvg(light), width: 16, height: 16, alt: 'Paid' })
      : Text({ color: noColor ? undefined : 'success', children: ['✓'] })
    const pill = Box({ key: 'receipt', flexDirection: 'row', alignItems: 'center', gap: 1, alignSelf: 'flex-start', borderStyle: 'round', borderColor: 'subtle', paddingX: 1, children: [
      Box({ flexShrink: 0, children: [shield] }),
      Text({ wrap: 'wrap', children: [
        receiptText(paid),
        ...(paid.note ? [Text({ dimColor: true, children: [` ${paid.note}`] })] : []),
        ...(paid.warmForMs > 0 ? [Text({ dimColor: true, children: [' /keepwarm off to stop'] })] : []),
      ] }),
    ] })
    return Box({ flexDirection: 'column', gap: 1, children: [rest, ...notice, pill, ...rows] })
  })

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    // The band drew before the footer's first draw here, so redraw it once without its row.
    if (footerSeen.surface !== String(e.surface)) $.clock.after(0, () => { $.ui.invalidate('ui.render') })
    footerSeen.count++
    footerSeen.surface = String(e.surface)
    footerSeen.modes = e.props.modes
    if (footer === 'off' || !isBandSurface(e.surface)) return next(e)
    const label = footerLabel(s, await $.clock.now())
    if (!label) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const color = noColor ? undefined : label.state === 'warm' ? 'success' : label.state === 'cold' ? (light ? '#c15f3c' : '#d97757') : undefined
    const sep = label.sep === ' · ' ? Text({ dimColor: true, children: [' · '] }) : ' '
    const words = Text({ wrap: 'truncate-end', children: label.state
      ? ['cache ', Text({ color, bold: true, children: [label.state] }), sep, label.detail]
      : ['cache', sep, label.detail] })
    const rest = await next(e).catch(() => Box({ children: [] }))
    // No gap beside an empty set of labels: the footer's width is tight.
    return Box({ flexDirection: 'row', alignItems: 'center', gap: e.props.modes.length ? 1 : 0, children: [rest, words] })
  })

  on('session.attach', async ($, e, next) => {
    const r = await next(e)
    if (!s.hasBand && isBandSurface(e.surface)) {
      s.hasBand = true
      $.ui.status(undefined)
      $.ui.invalidate('ui.render')
    }
    return r
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    s.hasBand = isBandSurface(e.surface) || await hasBandSurface($)
    // The row counts down to the cache going cold, so it redraws (or the status entry is rewritten) on a tick.
    $.clock.after(60 * 1000, () => { void tick($, s) })
    // Read even without a band yet: the desktop app attaches after session.start and draws one then.
    const theme = (await $.config.list()).find(row => row.key === 'theme')?.value
    light = typeof theme === 'string' && theme.startsWith('light')
    noColor = Boolean(await $.env.get('NO_COLOR'))
    if (s.hasBand) $.ui.status(undefined)
    s.sid = await $.session.id()
    const now = await $.clock.now()
    await prune($, s, now)
    const saved = await $.store.get(deadlineKey(s))
    const savedEvery = await $.store.get(everyKey(s))
    const savedGuard = await $.store.get(KEY_GUARD)
    s.deadline = typeof saved === 'number' && saved > now ? saved : 0
    s.every = typeof savedEvery === 'number' && savedEvery >= MIN_PING_MS ? savedEvery : PING_AFTER_MS
    s.guard = savedGuard === 'warn' ? 'warn' : 'refuse'
    s.always = (await $.store.get(KEY_ALWAYS)) === true
    const savedFooter = await $.store.get(KEY_FOOTER)
    footer = savedFooter === 'off' ? 'off' : 'on'
    // Always means a fresh default window every session, whatever the last one left behind.
    if (s.always) await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
    const usage = await $.session.usage()
    if (usage.context.tokens) s.ctx = usage.context.tokens
    await $.command.register({
      name: 'keepwarm',
      description: 'Keep the prompt cache warm: bare for 6h, a window such as 90m, always, off, or status (cache-watch)',
      argumentHint: '[6h | always | off | status]',
      immediate: true,
    })
    await $.command.register({
      name: 'cache-watch',
      description: 'Prompt cache state, cold price and this session\'s cold writes; guard warn|refuse (cache-watch, the Mod)',
      argumentHint: '[status | preview | pay | fresh | dismiss | guard warn | guard refuse | footer on|off]',
      immediate: true,
    })
    // The hook form of cache-tax ships a /cache-tax:status skill; both installed means two guards.
    const commands = await $.command.list()
    if (commands.some(c => c.name === 'cache-tax:status')) {
      $.ui.log('the hook form (cache-tax@claude-code-hooks) is also installed, so a cold send is warned about or refused twice. Uninstall it, or /cache-watch guard warn here.')
    }
    updateStatus($, s, now)
    return r
  })

  // Resume fields seed the guard before any turn of the resumed session has run.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'clear') {
      await stop($, s, null)
      s.stopped = null
      resetForClear(s)
      await release($)
      await update($, resumed, () => null)
      s.sid = await $.session.id()
      updateStatus($, s, await $.clock.now())
      return r
    }
    const line = seedFromResume(s, e, await $.clock.now())
    // The resume payload may omit the model; without it the guard cannot price the cold write.
    if (!s.lastModel) s.lastModel = await $.session.model()
    if (line) {
      // A card above the prompt where a band draws; the desktop app's band arrives after this event, so wait before falling back.
      await update($, resumed, () => resumeNoteFrom(s, e.estimated_cache_write_usd))
      $.clock.after(RESUME_LOG_AFTER_MS, () => { void resumeFallback($, s, line) })
      // The resume note already showed this cold spell's price, so the first send goes straight through, never held.
      s.ackedAt = s.lastRequestAt
    }
    // The seeded clock decides whether a restored or always window pings before the first turn: never when it is cold.
    await arm($, s)
    return r
  })

  on('command.run', { command: 'keepwarm' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    if (words[0] === 'off') {
      const wasAlways = s.always
      await stop($, s, null, true)
      return { text: wasAlways ? 'keepwarm is off, and no longer arms itself at session start' : 'keepwarm is off' }
    }
    if (words[0] === 'always') {
      s.always = true
      await $.store.set(KEY_ALWAYS, true)
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      const cold = isCold(s, now) ? `. The cache is cold now, so the first ping comes ${fmtDuration(s.every)} after the next turn` : ''
      return { text: `keepwarm always on: every session starts with a ${fmtDuration(DEFAULT_WINDOW_MS)} window; /keepwarm off turns it off for good${cold}` }
    }
    if (!words.length) {
      await startWindow($, s, DEFAULT_WINDOW_MS, PING_AFTER_MS)
      return { text: armedText(s, now, DEFAULT_WINDOW_MS) }
    }
    if (words[0] !== 'status') {
      const window = parseDuration(words[0])
      if (window == null) return { text: 'keepwarm takes a window such as 6h or 90m, or always, off, or status' }
      // "every 2m" is a testing knob and lasts only for the window it was given with.
      let every = PING_AFTER_MS
      if (words[1] === 'every') {
        const period = parseDuration(words[2] ?? '')
        if (period == null || period < MIN_PING_MS) return { text: 'every takes a period of at least 1m' }
        every = period
      }
      await startWindow($, s, window, every)
      return { text: armedText(s, now, window) }
    }
    return { text: statusText(s, now) ?? 'keepwarm is off' }
  })

  on('command.run', { command: 'cache-watch' }, async ($, e) => {
    const words = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    const now = await $.clock.now()
    // Keyboard twins of the card's buttons: the Code tab can drop a click while any mod's state write redraws the band.
    if (words[0] === 'fresh' && !(await read($, held)) && (await read($, resumed))) {
      // The resume card's Start fresh: nothing held, so it only clears, once this dispatch returns.
      $.clock.after(0, () => { void freshFromResume($) })
      return { text: 'cache-watch: starting fresh' }
    }
    if (words[0] === 'dismiss') {
      if (!(await read($, resumed))) return { text: 'cache-watch: nothing to dismiss' }
      await update($, resumed, () => null)
      return { text: 'cache-watch: the resume note is closed' }
    }
    if (words[0] === 'pay' || words[0] === 'fresh') {
      if (!(await read($, held))) return { text: 'cache-watch: no message is on hold' }
      // A command hook may not submit a prompt or run a command (each would wait on this dispatch): do it once it returns.
      const act = words[0] === 'pay' ? () => payAndSend($, s) : () => startFresh($)
      $.clock.after(0, () => { void act() })
      return { text: words[0] === 'pay' ? 'cache-watch: the held message is sent; keepwarm arms once the write lands' : 'cache-watch: started fresh; your message is back in the box' }
    }
    if (words[0] === 'preview') {
      if (!s.hasBand) return { text: 'cache-watch: this surface draws no band, so there is no card to preview' }
      // Right after a reload no turn has named the model yet; the session knows it.
      if (!s.lastModel) s.lastModel = await $.session.model()
      await update($, held, () => ({ ...heldFrom(s, 'Where were we? Give me a 2 line recap.'), isPreview: true }))
      await update($, showStatus, () => false)
      return { text: 'cache-watch: the hold card is above the prompt box, with this session\'s numbers. Any button closes it.' }
    }
    if (words[0] === 'footer') {
      const seen = footerSeen.count
        ? `The footer has drawn ${footerSeen.count} times, last on ${footerSeen.surface}.`
        : 'The footer has not drawn in this session yet, so the status stays in the band.'
      if (!words[1]) return { text: `cache-watch: footer ${footer}. ${seen} /cache-watch footer on or off moves the status.` }
      if (words[1] !== 'on' && words[1] !== 'off') return { text: '/cache-watch footer takes on or off' }
      footer = words[1]
      await $.store.set(KEY_FOOTER, footer)
      $.ui.invalidate('ui.render')
      return { text: footer === 'on' ? `cache-watch: the status shows in the prompt footer. ${seen}` : 'cache-watch: the status is back in the band above the prompt.' }
    }
    if (words[0] === 'guard') {
      if (words[1] !== 'warn' && words[1] !== 'refuse') return { text: '/cache-watch guard takes warn or refuse' }
      s.guard = words[1]
      await $.store.set(KEY_GUARD, s.guard)
      return { text: s.guard === 'refuse' ? 'guard set to refuse once: a cold send is dropped with its price, the resend goes through' : 'guard set to warn: a cold send goes through with its price shown' }
    }
    return { text: card(s, now) }
  })

  // The message that pays. Only its first character is read.
  on('prompt.submit', async ($, e, next) => {
    if (e.origin.kind === 'plugin') return next(e)
    // The person moved on: the last receipt has been seen.
    if (await read($, receipt)) await update($, receipt, () => null)
    // The resume note has done its job once the person writes.
    if (await read($, resumed)) {
      // Where no band drew, a send inside the fallback's wait means the person never saw the price, so it can still be held.
      if (!s.hasBand) s.ackedAt = 0
      await update($, resumed, () => null)
    }
    if (typeof e.text !== 'string' || e.text.trimStart().startsWith('/')) return next(e)
    const now = await $.clock.now()
    if (!isCold(s, now) || s.ctx < BIG_TOKENS) return next(e)
    if (s.ackedAt === s.lastRequestAt) {
      s.ackedAt = 0
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    if (s.guard === 'warn') {
      if (s.hasBand) s.note = 'Your message went straight through, because the guard is set to warn.'
      else $.ui.log(`${guardText(s, now)} Sending anyway; keepwarm will hold the cache for ${fmtDuration(AUTO_WARM_MS)} once it lands.`)
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    if (s.hasBand && !canHold(e.text, e.attachments)) {
      // No card can resend this one, and a block without a choice is what the card replaced: send it; the receipt shows the price.
      s.note = 'Your message went straight through, because a message with an image or an @file mention can\'t be held.'
      s.coldWritePending = true
      await release($)
      return next(e)
    }
    s.ackedAt = s.lastRequestAt
    if (s.hasBand) {
      await update($, held, () => heldFrom(s, e.text))
      await update($, showStatus, () => false)
      return { drop: HELD_DROP }
    }
    return { drop: `cache-watch: ${guardText(s, now)} Send it again to pay it, and keepwarm will then hold the cache for ${fmtDuration(AUTO_WARM_MS)}. Or /clear and start from a note.` }
  })

  on('turn.step', async function* ($, e, next) {
    if (!e.agentId) s.lastRequestAt = await $.clock.now()
    yield* next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    // A main-thread turn warmed the cache, so nothing is held any more.
    await release($)
    const now = await $.clock.now()
    // A sleeping host may deliver this turn before the expired window's timer.
    if (s.deadline && now >= s.deadline) await stop($, s, null)
    // turn.step stamps the exact request time; when no step of this turn did, the turn's end is the floor.
    if (now - s.lastRequestAt > e.durationMs) s.lastRequestAt = now
    s.compacted = false
    s.ackedAt = 0
    const u = e.usage
    if (u) {
      if (u.model) s.lastModel = u.model
      const prev = s.ctx
      // A turn's usage is its responses summed, so a ten-step turn reports ten
      // reads of the context. The live window is the engine's figure; the sum
      // is only the fallback for a host that reports no tokens.
      const write = u.cache_creation_input_tokens
      const live = (await $.session.usage()).context.tokens
      s.ctx = live && live > 0 ? live : u.input_tokens + u.cache_read_input_tokens + write
      const full = prev > 20000 && write >= 0.5 * prev
      if (full || s.coldWritePending) {
        const price = priceOf(s.lastModel)
        const usd = price ? write * price[1] / 1e6 : null
        s.misses.push({ at: now, tokens: write, usd })
        const arming = s.deadline < now + AUTO_WARM_MS
        if (arming) await startWindow($, s, AUTO_WARM_MS, s.every)
        if (s.hasBand) {
          const paid: Receipt = { tokens: write, usd, at: now, warmForMs: arming ? AUTO_WARM_MS : 0, note: s.note }
          await update($, receipt, () => paid)
        } else if (arming) {
          $.ui.log(`cold write of ${fmtTok(write)} tokens paid (${fmtUsd(usd)}). Keeping the cache warm for ${fmtDuration(AUTO_WARM_MS)} so it is not paid again today; /keepwarm off to stop.`)
        }
      }
    }
    s.coldWritePending = false
    s.note = null
    await arm($, s)
    // arm() redraws only while keepwarm is on; the cache clock restarts on every turn either way.
    if (!s.deadline) updateStatus($, s, now)
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await release($)
      s.compacted = true
      s.ctx = 0
      s.ackedAt = 0
      disarm(s)
      await arm($, s)
    }
    return r
  })
}
