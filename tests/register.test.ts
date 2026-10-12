import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { CommandRunInput, ConfigSetInput, ModelForkResult, On, PromptSubmitInput, RenderPropsOf, SessionStartInput, TurnCompleteInput, TurnUsage } from 'claude-code'

import { statusIcons } from '../hooks/status-icons'
import { HELD_DROP, RESUME_LOG_AFTER_MS, bar, canHold, compactStatsSvg, fmtDuration, footerLabel, freshState, parseDuration, quoted, resetForClear, resumeNoteFrom, seedFromResume, statsSvg, warmShare } from '../hooks/register'

tier('user')

const MIN = 60 * 1000
const HOUR = 60 * MIN
const START = 1_000_000

const session: SessionStartInput = { surface: null, isInteractive: false, cwd: '/work' }

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  input_tokens: 2, output_tokens: 10, cache_read_input_tokens: 200000, cache_creation_input_tokens: 500, model: 'claude-fable-5-1', ...over,
})

// TurnCompleteInput is a union on `reason`; the tests only drive the answered arm.
type AnsweredTurn = Exclude<TurnCompleteInput, { reason: 'refusal' }>
let turns = 0
const turn = (over: Partial<AnsweredTurn> = {}): TurnCompleteInput => ({
  answer: 'ok', durationMs: 1000, isAborted: false, turnId: 't' + ++turns, reason: 'answer', usage: usage(), ...over,
})

const run = (command: 'keepwarm' | 'cache-watch', args: string): CommandRunInput => ({
  command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 80 },
})

const prompt = (text: string): PromptSubmitInput => ({ text, wait: false, origin: { kind: 'composer' } })
const themeChange = (value: string): ConfigSetInput => ({ key: 'theme', value, previous: 'dark', provider: { plugin: 'engine', tier: 'core' }, origin: { kind: 'composer' } })

type ForkAnswer = null | ModelForkResult | { read: number; write: number; out?: number; input?: number }

// The world beneath the mod: its store, the engine's answers, and a fork that
// replies from a script so each test decides what the cache looked like.
function world(on: On, forkAnswers: ForkAnswer[], opts: { store?: Map<string, unknown>; commands?: string[]; live?: { tokens?: number }; sid?: string; model?: string; bandText?: string; theme?: { value: string }; noColor?: boolean; denyTheme?: boolean; writtenTheme?: string } = {}) {
  if (opts.store) {
    const store = opts.store
    on('store.get', ($, e) => ({ value: store.get(e.key) }))
    on('store.set', ($, e) => { store.set(e.key, e.value); return { value: undefined } })
    on('store.delete', ($, e) => { store.delete(e.key); return { value: undefined } })
    on('store.keys', () => ({ value: [...store.keys()] }))
  } else mock.store(on, {})
  const reads = { theme: 0, env: 0 }
  on('env.get', ($, e) => { reads.env++; return { value: e.name === 'NO_COLOR' && opts.noColor ? '1' : undefined } })
  on('config.list', () => {
    reads.theme++
    return { value: [{ key: 'theme', label: 'Theme', kind: 'choice', value: opts.theme?.value ?? 'dark', provider: { plugin: 'engine', tier: 'core' }, isLocked: false }] }
  })
  on('config.set', ($, e) => opts.denyTheme ? { deny: 'theme locked' } : { value: opts.writtenTheme ?? e.value })
  const forks: number[] = []
  const status: Array<string | undefined> = []
  const logs: string[] = []
  const entered: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: opts.sid ?? 'S1' }))
  on('session.model', () => ({ value: opts.model ?? 'claude-fable-5-1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 1000000, tokens: opts.live?.tokens }, rateLimits: [] } }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: (opts.commands ?? []).map(name => ({ name, description: '', source: 'plugin' as const })) }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('prompt.submit', ($, e) => { entered.push(e.text); return { text: e.text } })
  on('session.compact', ($, e) => ({ messages: e.messages }))
  on('classic.SessionStart', () => ({}))
  on('ui.log', ($, e) => { logs.push(e.text); return { value: undefined } })
  on('ui.status', ($, e) => { status.push(e.text); return { value: undefined } })
  // The footer stub draws its labels, so a test can see what a hook passed down.
  on('ui.render', ($, e) => $.ui.resolve(e).Text({ children: [e.component === 'SessionMode' ? ['modes', ...e.props.modes].join(' & ') : opts.bandText ?? ''] }))
  on('model.fork', () => {
    forks.push(forks.length)
    const a = forkAnswers.shift()
    // Older Claude Code releases returned null instead of a failure object.
    if (a === null || a === undefined) return { value: null as unknown as ModelForkResult }
    if ('isAnswered' in a) return { value: a }
    const value: ModelForkResult = { isAnswered: true, text: 'warm', usage: { input_tokens: a.input ?? 2, output_tokens: a.out ?? 1, cache_read_input_tokens: a.read, cache_creation_input_tokens: a.write } }
    return { value }
  })
  return { forks, status, logs, entered, reads }
}

const warm: ForkAnswer = { read: 200000, write: 0 }

const bandProps: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 75,
  scroll: { offset: 0, bodyRows: 10 }, view: {},
}

describe('cache indicator', () => {
  test('redraws reuse session preferences and theme changes repaint immediately', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '2h'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    await $.config.set(themeChange('light'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.warm.png })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
    expect(w.reads).toEqual({ theme: 1, env: 1 })
    expect(w.forks.length).toBe(0)
  })

  test('a denied theme change preserves the existing icon', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { denyTheme: true })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await $.config.set(themeChange('light'))).deny).toBe('theme locked')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.dark.warm.png })
  })

  test('the written theme wins over the requested value', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [], { writtenTheme: 'light' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.command.run(run('keepwarm', '90m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.config.set(themeChange('dark'))
    expect((await ui.find({ type: 'Image' }))?.props.source).toEqual({ png: statusIcons.light.neutral.png })
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: official cube follows state and theme with a text alternative`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const theme = { value: 'dark' }
      const w = world(on, [], { theme })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.command.run(run('keepwarm', '3h every 90m'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      const type = surface === 'terminal' ? 'Image' : 'Svg'
      const source = (variant: typeof statusIcons.dark) => surface === 'terminal' ? { png: variant.neutral.png } : variant.neutral.svg
      expect((await ui.find({ type }))?.props.source).toEqual(source(statusIcons.dark))
      expect((await ui.find({ type }))?.props.alt).toBe(surface === 'terminal' ? '[>]' : 'Cache Watch')
      if (surface === 'terminal') {
        expect((await ui.find({ type }))?.props.columns).toBe(3)
        expect((await ui.find({ type }))?.props.rows).toBe(1)
      }
      await $.turn.complete(turn())
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.dark.warm.png } : statusIcons.dark.warm.svg)
      await $.config.set(themeChange('light'))
      await clock.advance(HOUR)
      expect((await ui.find({ type }))?.props.source).toEqual(surface === 'terminal' ? { png: statusIcons.light.cold.png } : statusIcons.light.cold.svg)
      expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#c15f3c')
      expect(w.forks.length).toBe(0)
      await $.command.run(run('keepwarm', 'off'))
      // cache-watch: with keepwarm off the row stays, showing the cache clock.
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/cold.*cold for 0m/)
    })

    test(`${surface}: NO_COLOR uses a bold text icon and uncolored state`, async ($, on) => {
      mock.clock(on, { now: START })
      world(on, [], { noColor: true })
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ type: 'Image' })).toBe(undefined)
      expect(await ui.find({ type: 'Svg' })).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: /^\[>\]$/ }))?.props.bold).toBe(true)
      expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe(undefined)
    })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: unknown, warm, cold and warm again agree with the card`, async ($, on) => {
      const clock = mock.clock(on, { now: 10 * HOUR })
      const w = world(on, [], { bandText: 'other mod' })
      await $.session.start({ ...session, surface, isInteractive: true })
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: bandProps })
      expect(await ui.find({ text: 'cache-watch' })).toBe(undefined)
      await $.command.run(run('keepwarm', '3h every 90m'))
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/unknown.*waiting for the first turn/)
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*ping in 1h30m/)
      await clock.advance(HOUR)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/cold.*cold now/)
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       COLD/)
      expect(w.forks.length).toBe(0)
      expect((await ui.find({ text: /^other mod$/ }))?.text).toBe('other mod')
      await $.turn.complete(turn())
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
      expect((await $.command.run(run('cache-watch', ''))).text).toMatch(/state       warm/)
      expect(w.status.filter(Boolean)).toEqual([])
      await $.command.run(run('keepwarm', 'off'))
      // cache-watch: with keepwarm off the row stays, showing the cache clock.
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('cold resume, compaction and clear reset the row without a ping', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map([['deadline:S1', 13 * HOUR]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 7200, context_tokens: 200000, prompt_cache_likely_expired: true })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/unknown.*after compaction/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.classic.SessionStart({ source: 'clear' })
    expect(await ui.find({ text: 'cache-watch' })).toBe(undefined)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(0)
  })

  test('window expiry hands the row to the cache clock and surveys retain their band', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [], { bandText: 'survey' })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '10m'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    const survey = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: { ...bandProps, hasSurvey: true } })
    expect(await survey.find({ text: 'cache-watch' })).toBe(undefined)
    expect((await survey.find({ text: 'survey' }))?.text).toBe('survey')
    await clock.advance(10 * MIN)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 50m/)
    expect(w.forks.length).toBe(0)
  })

  test('a warm resume restores green and ignores subagent cache activity', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const w = world(on, [], { store: new Map<string, unknown>([['deadline:S1', 13 * HOUR], ['every:S1', 90 * MIN]]) })
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.classic.SessionStart({ source: 'resume', seconds_since_last_response: 30 * 60, context_tokens: 200000 })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    await $.turn.complete(turn({ agentId: 'worker' }))
    await $.session.compact({ trigger: 'manual', agentId: 'worker', messages: [{ role: 'user', text: 'summary', toolUses: [] }] })
    await clock.advance(30 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('#d97757')
    expect(w.forks.length).toBe(0)
  })

  for (const surface of ['vscode', 'mobile', null] as const) {
    test(`${surface ?? 'headless'} keeps the plain status fallback`, async ($, on) => {
      mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '90m'))
      expect(w.status.at(-1)).toBe('keepwarm 1h30m left · ping in 55m')
      expect(w.status.at(-1)).not.toMatch(/\x1b/)
      expect(w.forks.length).toBe(0)
    })
  }

  test('a warm ping keeps the green row and a cold read stops it neutrally', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, { read: 0, write: 200000 }])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', '3h'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
    await clock.advance(55 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/last ping read 200k/)
    await clock.advance(55 * MIN)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/stopped.*cache was already gone/)
    await clock.advance(HOUR)
    expect(w.forks.length).toBe(2)
  })

  for (const failure of [
    { isAnswered: false, reason: 'nothing-to-fork' },
    { isAnswered: false, reason: 'api-error', status: 429, error: 'rate_limit', usage: usage() },
    { isAnswered: false, reason: 'empty-reply', usage: usage() },
    { isAnswered: false, reason: 'aborted', usage: usage() },
  ] satisfies ModelForkResult[]) {
    test(`structured fork failure ${failure.reason} stops without retrying`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [failure])
      await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
      await $.turn.complete(turn())
      await $.command.run(run('keepwarm', '3h every 1m'))
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: bandProps })
      await clock.advance(MIN)
      expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.props.color).toBe(undefined)
      expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/stopped/)
      await clock.advance(2 * HOUR)
      expect(w.forks.length).toBe(1)
    })
  }
})

describe('parse and format', () => {
  test('durations', async () => {
    expect(parseDuration('6h')).toBe(6 * HOUR)
    expect(parseDuration('90m')).toBe(90 * MIN)
    expect(parseDuration('2h30m')).toBe(150 * MIN)
    expect(parseDuration('soon')).toBe(null)
    expect(fmtDuration(150 * MIN)).toBe('2h30m')
    expect(fmtDuration(7 * MIN)).toBe('7m')
    expect(fmtDuration((15 * 24 + 9) * 60 * MIN)).toBe('15d 9h')
  })
})

describe('guard', () => {
  test('refuses a cold send once with the price, then lets the resend through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt('hi'))
    expect(first.drop).toMatch(/cache-watch: the prompt cache went cold 2h00m ago\. Sending this re-writes up to 200,502 tokens at \$20\/MTok = \$4\.01/)
    expect(w.entered).toEqual([])
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
  })

  test('lets slash commands, warm sends and small contexts through', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(30 * MIN)
    await $.prompt.submit(prompt('warm one'))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('/clear'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 20000 }) }))
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('small one'))
    expect(w.entered).toEqual(['warm one', '/clear', 'small one'])
  })

  test('warn mode shows the price and sends', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    const r = await $.command.run(run('cache-watch', 'guard warn'))
    expect(r.text).toMatch(/guard set to warn/)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    expect(w.entered).toEqual(['hi'])
    expect(w.logs.at(-1)).toMatch(/Sending anyway/)
  })

  test('a paid cold write is scored and arms keepwarm for three hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    await $.prompt.submit(prompt('hi'))
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    expect(w.logs.at(-1)).toMatch(/cold write of 201k tokens paid \(\$4\.01\)\. Keeping the cache warm for 3h00m/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left · ping in 55m/)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/session     1 cold write paid, \$4\.01/)
    expect(card.text).toMatch(/keepwarm    on, 2h05m left/)
  })

  test('context comes from the live window, not the turn\'s summed usage', async ($, on) => {
    mock.clock(on, { now: START })
    const live: { tokens?: number } = {}
    const w = world(on, [], { live })
    await $.session.start(session)
    await $.turn.complete(turn())
    live.tokens = 100000
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 500000, cache_creation_input_tokens: 2000 }) }))
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/context     100,000 tokens/)
    expect(card.text).toMatch(/0 cold writes paid/)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
  })

  test('/clear forgets the context, the clock and the tally', async () => {
    const s = freshState()
    s.ctx = 200000
    s.lastRequestAt = START - 2 * HOUR
    s.ackedAt = s.lastRequestAt
    s.misses = [{ at: START, tokens: 200000, usd: 4 }]
    let cancelled = false
    s.pending = { cancel: () => { cancelled = true } }
    resetForClear(s)
    expect(s.ctx).toBe(0)
    expect(s.lastRequestAt).toBe(0)
    expect(s.ackedAt).toBe(0)
    expect(s.misses).toEqual([])
    expect(s.pending).toBe(null)
    expect(cancelled).toBe(true)
  })

  test('an unguarded full miss is scored too', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200502 }) }))
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/1 cold write paid/)
    expect(w.status.at(-1)).toMatch(/^keepwarm 3h00m left/)
  })

  test('stays quiet after a compaction until the first new turn', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'old', toolUses: [] }] })
    await $.prompt.submit(prompt('after compact'))
    expect(w.entered).toEqual(['after compact'])
    const card = await $.command.run(run('cache-watch', 'status'))
    expect(card.text).toMatch(/reset by compaction/)
  })

  test('a cold resume seeds the guard before any turn and returns the estimate line', async () => {
    const s = freshState()
    const now = START
    const line = seedFromResume(s, { source: 'resume', model: 'claude-fable-5-1', context_tokens: 396113, seconds_since_last_response: 3 * 3600, prompt_cache_likely_expired: true, estimated_cache_write_usd: 7.92 }, now)
    expect(line).toMatch(/resuming cold\. The first message re-writes 396,113 tokens, about \$7\.92/)
    expect(s.ctx).toBe(396113)
    expect(s.lastRequestAt).toBe(now - 3 * HOUR)
    expect(seedFromResume(freshState(), { source: 'startup' }, now)).toBe(null)
    expect(seedFromResume(freshState(), { source: 'resume', context_tokens: 20000, prompt_cache_likely_expired: true }, now)).toBe(null)
  })

  test('warns once when the hook form is installed beside it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [], { commands: ['cache-tax:status'] })
    await $.session.start(session)
    expect(w.logs.at(-1)).toMatch(/hook form .* is also installed/)
  })
})

describe('keepwarm', () => {
  test('pings 55 minutes after the last request, then again, and reports the read', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', '6h'))
    expect(r.text).toMatch(/keepwarm on for 6h00m/)
    await $.turn.complete(turn())
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm 5h05m left · ping in 55m · last ping read 200k \$0\.05/)
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a new turn resets the countdown', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(15 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('stops when a ping reads cold', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 180000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/keepwarm stopped: the ping read 0 and wrote 180k tokens \(\$3\.60\)/)
    await clock.advance(120 * MIN)
    expect(w.forks.length).toBe(1)
    const s = await $.command.run(run('keepwarm', 'status'))
    expect(s.text).toMatch(/stopped/)
  })

  test('stops when the engine returns null, a cold snapshot or an API error', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [null])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/either the snapshot was cold or the API call failed/)
  })

  test('the window ends on its own, forgetting the every knob, and off cancels', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm, warm, warm], { store })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '3m every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
    expect(store.has('every:S1')).toBe(false)
    expect(store.has('deadline:S1')).toBe(false)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('the every knob lasts one window only', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm, warm, warm, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(2 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', 'off'))
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(2)
    await $.command.run(run('keepwarm', '1h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(3)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(10 * MIN)
    expect(w.forks.length).toBe(3)
  })

  test('a bare /keepwarm arms six hours', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toMatch(/^keepwarm on for 6h00m, a ping 55m after each idle stretch/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · ping in 55m')
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('always is remembered, arms every session start, and off ends it for good', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true], ['deadline:S1', START - MIN], ['every:S1', MIN]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(store.has('every:S1')).toBe(false)
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(1)
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/keepwarm    on, 5h05m left · ping in 55m · last ping read 200k \$0\.05 \(always\)/)
    const off = await $.command.run(run('keepwarm', 'off'))
    expect(off.text).toBe('keepwarm is off, and no longer arms itself at session start')
    expect(store.has('always')).toBe(false)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
  })

  test('/keepwarm always sets the switch and arms now', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toMatch(/^keepwarm always on: every session starts with a 6h00m window/)
    expect(store.get('always')).toBe(true)
    expect(store.get('deadline:S1')).toBe(START + 6 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · waiting for the first turn')
  })

  test('the ping figure counts output tokens at the model\'s rate, Sonnet 5 priced as itself', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h05m left · ping in 55m · last ping read 200k $0.05')
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/cold cost   \$0\.80 to re-write it \(warm turn \$0\.04\)/)
    expect(card.text).toMatch(/break-even  up to 20 pings at the read rate cost one cold write, about 18h20m of idle at one ping per 55m/)
  })

  test('a partial write, a zero read, or a full write stops the loop; a ping\'s own few tokens do not', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 500 }, { read: 75000, write: 70000 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h every 1m'))
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
    expect(w.status.at(-1)).toMatch(/^keepwarm 5h59m left · ping in 1m · last ping read 200k/)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(2)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 75k and wrote 70k tokens/)
    await clock.advance(5 * MIN)
    expect(w.forks.length).toBe(2)
  })

  test('a ping that reads nothing stops the loop too', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 0, write: 0 }, warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toMatch(/^keepwarm stopped: the ping read 0 and wrote 0 tokens/)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the ping figure counts uncached input at the base rate', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [{ read: 200000, write: 0, input: 50000, out: 1000 }])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn({ usage: usage({ model: 'claude-sonnet-5' }) }))
    await clock.advance(55 * MIN)
    expect(w.status.at(-1)).toBe('keepwarm 5h05m left · ping in 55m · last ping read 200k $0.15')
  })

  test('the card states the break-even for Fable 5.1', async ($, on) => {
    mock.clock(on, { now: START })
    world(on, [])
    await $.session.start(session)
    await $.turn.complete(turn())
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/break-even  up to 80 pings at the read rate cost one cold write, about 3d 1h of idle at one ping per 55m/)
  })

  test('/keepwarm on a cold session schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(15 * 24 * HOUR)
    const r = await $.command.run(run('keepwarm', ''))
    expect(r.text).toBe('keepwarm on for 6h00m. The cache is cold now, so the first ping comes 55m after the next turn')
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 55m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    const card = await $.command.run(run('cache-watch', ''))
    expect(card.text).toMatch(/keepwarm    on, 4h59m left · cold now, first ping 55m after the next turn/)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toBe('keepwarm 4h59m left · ping in 55m')
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('the always switch on a cold resume schedules no fork before a turn, and does after one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['always', true]])
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await $.command.run(run('keepwarm', 'off'))
    await clock.advance(15 * 24 * HOUR)
    // The test kit cannot raise classic.SessionStart, so the cold state comes from the turn above and a second start arms the switch over it.
    store.set('always', true)
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 6h00m left · cold now, first ping 55m after the next turn')
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(0)
    const r = await $.command.run(run('keepwarm', 'always'))
    expect(r.text).toBe('keepwarm always on: every session starts with a 6h00m window; /keepwarm off turns it off for good. The cache is cold now, so the first ping comes 55m after the next turn')
    await clock.advance(60 * MIN)
    expect(w.forks.length).toBe(0)
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a cold window expires and its testing period does not reach the next auto-window', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>()
    const w = world(on, [warm], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    await clock.advance(2 * HOUR)
    await $.command.run(run('keepwarm', '90m every 1m'))
    await clock.advance(90 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.has('deadline:S1')).toBe(false)
    expect(store.has('every:S1')).toBe(false)
    // cache-watch: with keepwarm off, the status entry shows the cache clock.
    expect(w.status.at(-1)).toMatch(/^(goes cold in|cold for) /)
    expect((await $.command.run(run('keepwarm', 'status'))).text).toBe('keepwarm is off')
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    await clock.advance(54 * MIN)
    expect(w.forks.length).toBe(0)
    await clock.advance(MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a turn after sleep clears the expired period before the overdue timer runs', async ($, on) => {
    let now = START
    on('clock.now', () => ({ value: now }))
    on('clock.after', () => new Promise<{ value: void }>(() => {}))
    const store = new Map<string, unknown>()
    const w = world(on, [], { store })
    await $.session.start(session)
    await $.turn.complete(turn())
    now += 2 * HOUR
    await $.command.run(run('keepwarm', '90m every 1m'))
    now += 91 * MIN
    expect(store.get('every:S1')).toBe(MIN)
    await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
    expect(store.has('every:S1')).toBe(false)
    expect(store.get('deadline:S1')).toBe(now + 3 * HOUR)
    expect(w.status.at(-1)).toBe('keepwarm 3h00m left · ping in 55m')
    expect(w.forks.length).toBe(0)
  })

  test('subagent turns do not touch the timer', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [warm])
    await $.session.start(session)
    await $.command.run(run('keepwarm', '6h'))
    await $.turn.complete(turn())
    await clock.advance(40 * MIN)
    await $.turn.complete(turn({ agentId: 'a1' }))
    await clock.advance(15 * MIN)
    expect(w.forks.length).toBe(1)
  })
})

describe('store per session', () => {
  test('another session\'s window does not arm this one', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe(undefined)
    const r = await $.command.run(run('keepwarm', 'status'))
    expect(r.text).toBe('keepwarm is off')
    await $.turn.complete(turn())
    await clock.advance(55 * MIN)
    expect(w.forks.length).toBe(0)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
  })

  test('this session\'s own window is restored on start', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START + 2 * HOUR], ['every:mine', MIN]])
    const w = world(on, [warm], { store, sid: 'mine' })
    await $.session.start(session)
    expect(w.status.at(-1)).toBe('keepwarm 2h00m left · waiting for the first turn')
    await $.turn.complete(turn())
    await clock.advance(1 * MIN)
    expect(w.forks.length).toBe(1)
  })

  test('a window that lapsed less than a week ago is left for its own session', async ($, on) => {
    const now = START + 30 * 24 * HOUR
    mock.clock(on, { now })
    const store = new Map<string, unknown>([['deadline:recent', now - HOUR], ['every:recent', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:recent', 'every:recent'])
  })

  test('/keepwarm off deletes only this session\'s keys', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:other', START + HOUR], ['every:other', MIN], ['always', true], ['guard', 'warn']])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    await $.command.run(run('keepwarm', '1h every 1m'))
    expect(store.get('deadline:mine')).toBe(START + HOUR)
    expect(store.get('every:mine')).toBe(MIN)
    await $.command.run(run('keepwarm', 'off'))
    expect(store.has('deadline:mine')).toBe(false)
    expect(store.has('every:mine')).toBe(false)
    expect(store.has('always')).toBe(false)
    expect(store.get('deadline:other')).toBe(START + HOUR)
    expect(store.get('every:other')).toBe(MIN)
    expect(store.get('guard')).toBe('warn')
  })

  test('legacy bare keys are cleared on start; other sessions\' keys, live or dead, and the global switches stay', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([
      ['deadline:old1', START - 8 * 24 * HOUR], ['every:old1', MIN],
      ['deadline:old2', 0],
      ['deadline', 0], ['every', MIN],
      ['deadline:live', START + HOUR], ['every:live', 2 * MIN],
      ['guard', 'warn'],
    ])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:old1', 'every:old1', 'deadline:old2', 'deadline:live', 'every:live', 'guard'])
  })

  test('this session\'s own dead window is cleared on start', async ($, on) => {
    mock.clock(on, { now: START })
    const store = new Map<string, unknown>([['deadline:mine', START - MIN], ['every:mine', MIN], ['deadline:other', START - MIN], ['every:other', MIN]])
    world(on, [], { store, sid: 'mine' })
    await $.session.start(session)
    expect([...store.keys()]).toEqual(['deadline:other', 'every:other'])
  })
})

describe('hold card', () => {
  const ask = 'Where were we? Give me a 2 line recap.'
  const isHeld = async (ui: { find: (q: { text: RegExp }) => Promise<unknown> }) => (await ui.find({ text: /Your message is on hold/ })) !== undefined
  // A band with room for the full card; bandProps (10 rows) gets the compact one.
  const tallBand = { ...bandProps, maxRows: 40 }

  test('a short band gets the compact card, with text bars and the buttons in view', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ text: /CACHE WATCH · Your message is on hold · cold for 2h00m/ })).toBeTruthy()
    // Desktop Text is proportional: the bars are one short Svg, never block glyphs in Text.
    const svgs = await ui.findAll({ type: 'Svg' })
    expect(svgs.map(el => String(el.props.alt))).toEqual(['Send it now: $4.01, re-writes up to 200,502 tokens at $20/MTok. A warm turn: $0.05, what it would have cost.'])
    expect(svgs[0]?.props.height).toBe(44)
    expect(await ui.find({ text: /█|░/ })).toBe(undefined)
    expect(await ui.find({ key: 'pay' })).toBeTruthy()
  })

  test('/cache-watch pay and /cache-watch fresh do what the buttons do', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    const filled: string[] = []
    on('command.run', { command: 'clear' }, () => ({ text: '' }))
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect((await $.command.run(run('cache-watch', 'pay'))).text).toBe('cache-watch: no message is on hold')
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    expect((await $.command.run(run('cache-watch', 'pay'))).text).toMatch(/held message is sent/)
    await clock.advance(1)
    expect(w.entered).toEqual([ask])
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('second'))
    expect((await $.command.run(run('cache-watch', 'fresh'))).text).toMatch(/started fresh/)
    await clock.advance(1)
    expect(filled).toEqual(['second'])
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`${surface}: a cold send waits on the card, and Pay and send resends it as the person's words and scores the write`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface, isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit(prompt(ask))
      expect(first.drop).toBe(HELD_DROP)
      expect(w.entered).toEqual([])
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface, component: 'AbovePrompt', props: tallBand })
      expect(await isHeld(ui)).toBe(true)
      expect(await ui.find({ text: /CACHE WATCH/ })).toBeTruthy()
      expect(await ui.find({ text: /The prompt cache went cold 2h00m ago\./ })).toBeTruthy()
      expect(await ui.find({ text: /On hold: “Where were we\? Give me a 2 line recap\.”/ })).toBeTruthy()
      expect(await ui.find({ text: /keepwarm then holds the cache for 3h00m/ })).toBeTruthy()
      if (surface === 'desktop') {
        const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
        expect(alts).toContain('Send it now: $4.01, re-writes up to 200,502 tokens at $20/MTok. A warm turn: $0.05, what it would have cost.')
      } else {
        expect(await ui.find({ text: /re-writes up to 200,502 tokens at \$20\/MTok/ })).toBeTruthy()
        expect(await ui.find({ text: /\$4\.01/ })).toBeTruthy()
      }
      expect((await ui.find({ key: 'pay' }))?.props.variant).toBe('primary')
      await ui.press({ key: 'pay' })
      expect(w.entered).toEqual([ask])
      expect(await isHeld(ui)).toBe(false)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      // The paid write shows as a pill in the band, not a log line.
      expect(await ui.find({ text: /Cold write paid: \$4\.00 for 200k tokens\. Keepwarm holds the cache for 3h00m\./ })).toBeTruthy()
      expect(w.logs.some(line => /cold write of/.test(line))).toBe(false)
      await $.prompt.submit(prompt('next'))
      expect(await ui.find({ key: 'receipt' })).toBe(undefined)
    })
  }

  test('Start fresh clears the conversation and puts the message back in the box', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    const commands: string[] = []
    const filled: string[] = []
    on('command.run', { command: 'clear' }, ($, e) => { commands.push(e.command); return { text: '' } })
    on('prompt.fill', ($, e) => { filled.push(e.text); return { isFilled: true } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    await ui.press({ key: 'fresh' })
    expect(commands).toEqual(['clear'])
    expect(filled).toEqual([ask])
    expect(w.entered).toEqual([])
    expect(await isHeld(ui)).toBe(false)
  })

  test('Show cache status opens the details inside the card and closes them again', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt(ask))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tallBand })
    expect(await ui.find({ key: 'status-card' })).toBe(undefined)
    await ui.press({ key: 'status' })
    expect(String((await ui.find({ key: 'status-card' }))?.props.text)).toMatch(/state\s+COLD/)
    expect((await ui.find({ key: 'status' }))?.props.label).toBe('Hide cache status')
    await ui.press({ key: 'status' })
    expect(await ui.find({ key: 'status-card' })).toBe(undefined)
    expect(await isHeld(ui)).toBe(true)
  })

  test('sending again still pays, and clears the card', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    await clock.advance(3 * HOUR)
    await $.prompt.submit(prompt('hi'))
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
    const second = await $.prompt.submit(prompt('hi'))
    expect(second.drop).toBe(undefined)
    expect(w.entered).toEqual(['hi'])
    expect(await isHeld(ui)).toBe(false)
  })

  for (const [label, sent] of [['an @file mention', prompt('look at @README.md')], ['a pasted image', { ...prompt('what is this?'), attachments: [{ type: 'image' as const }] }]] as const) {
    test(`a message with ${label} goes through with the price, since no card can resend it`, async ($, on) => {
      const clock = mock.clock(on, { now: START })
      const w = world(on, [])
      await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
      await $.turn.complete(turn())
      await clock.advance(3 * HOUR)
      const first = await $.prompt.submit(sent)
      expect(first.drop).toBe(undefined)
      expect(w.entered).toEqual([sent.text])
      expect(w.logs).toEqual([])
      const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
      expect(await isHeld(ui)).toBe(false)
      await $.turn.complete(turn({ usage: usage({ cache_read_input_tokens: 0, cache_creation_input_tokens: 200000 }) }))
      expect(await ui.find({ text: /Cold write paid: \$4\.00 for 200k tokens/ })).toBeTruthy()
      expect(await ui.find({ text: /Your message went straight through, because a message with an image or an @file mention can't be held\./ })).toBeTruthy()
    })
  }

  test('a desktop host that attaches after session.start gets the band, not the status entry', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.surfaces', () => ({ value: [] }))
    on('session.attach', ($, e) => ({ clientId: e.clientId }))
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
    await $.session.attach({ surface: 'desktop', clientId: 'desktop:default' })
    expect(w.status.at(-1)).toBe(undefined)
    await clock.advance(3 * HOUR)
    const first = await $.prompt.submit(prompt(ask))
    expect(first.drop).toBe(HELD_DROP)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
  })

  test('the first band drawn on a surface that never said it attached switches the band on', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    on('session.surfaces', () => ({ value: [] }))
    await $.session.start(session)
    await $.turn.complete(turn())
    expect(w.status.at(-1)).toMatch(/^goes cold in/)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect((await ui.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
  })

  test('/cache-watch preview shows the card with this session\'s numbers, and any button only closes it', async ($, on) => {
    mock.clock(on, { now: START })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const r = await $.command.run(run('cache-watch', 'preview'))
    expect(r.text).toMatch(/hold card is above the prompt box/)
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tallBand })
    expect(await isHeld(ui)).toBe(true)
    expect(await ui.find({ text: /Preview: nothing is held/ })).toBeTruthy()
    const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
    expect(alts.some(alt => alt.startsWith('Send it now: $4.01'))).toBe(true)
    await ui.press({ key: 'pay' })
    expect(w.entered).toEqual([])
    expect(await isHeld(ui)).toBe(false)
  })

  test('the row shows the cache clock even with keepwarm off', async ($, on) => {
    const clock = mock.clock(on, { now: START })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tallBand })
    expect(await ui.find({ text: /goes cold in|cold for/ })).toBe(undefined)
    await $.turn.complete(turn())
    expect(await ui.find({ text: /cache-watch · warm · goes cold in 1h00m/ })).toBeTruthy()
    await clock.advance(90 * MIN)
    expect(await ui.find({ text: /cache-watch · cold · cold for 30m/ })).toBeTruthy()
  })

  test('helpers: hold rules, quoting, bar shares and the panel markup', async () => {
    expect(canHold('plain words', undefined)).toBe(true)
    expect(canHold('see @src/a.ts', undefined)).toBe(false)
    expect(canHold('email me at a@b.com', undefined)).toBe(true)
    expect(canHold('a picture', [{ type: 'image' }])).toBe(false)
    expect(quoted('two\nlines  here')).toBe('two lines here')
    expect(quoted('bell\u0007 zero​width \u001b[31mred\r\n')).toBe('bell zero width [31mred')
    expect(quoted('x'.repeat(400)).length).toBe(160)
    const h = { text: 'hi', tokens: 51929, rate: '$10/MTok', coldUsd: 0.52, warmUsd: 0.03 }
    expect(Math.abs(warmShare(h) - 0.0577) < 0.001).toBe(true)
    expect(warmShare({ ...h, warmUsd: null })).toBe(0.04)
    expect(bar(1, 10)).toEqual(['██████████', ''])
    expect(bar(0.01, 10)).toEqual(['█', '░░░░░░░░░'])
    const svg = statsSvg(h, false)
    expect(svg).toMatch(/^<svg /)
    expect(svg).toContain('$0.52')
    expect(svg).toContain('re-writes up to 51,929 tokens at $10/MTok')
    expect(svg.length).toBeLessThan(131072)
    expect(statsSvg({ ...h, rate: '<b>&' }, true)).toContain('at &lt;b&gt;&amp;</text>')
    // The compact Svg drops its captions first when the band is narrow.
    expect(compactStatsSvg(h, false, 680)).toContain('what it would have cost')
    expect(compactStatsSvg(h, false, 400)).not.toContain('what it would have cost')
    expect(compactStatsSvg(h, false, 400)).toContain('$0.52')
  })
})

const footerProps: RenderPropsOf['SessionMode'] = { modes: ['focus'] }

describe('footer label', () => {
  test("desktop: coloured state beside the app's labels, short enough for the footer", async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    // No request yet: nothing to say, so the app's labels draw alone.
    expect(await ui.find({ type: 'Text', text: /^cache/ })).toBe(undefined)
    expect((await ui.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 1h00m left')
    expect((await ui.find({ type: 'Text', text: /^warm$/ }))?.props.color).toBe('success')
    expect((await ui.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')
    // The Code tab drops an Svg in the footer, so none is sent.
    expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    await clock.advance(HOUR + 6 * MIN)
    // A cold cache redraws every 5 minutes, so the figure can trail the clock.
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toMatch(/^cache cold for [56]m$/)
    expect((await ui.find({ type: 'Text', text: /^cold$/ }))?.props.color).toBe('#d97757')
  })

  test('keepwarm shows its time left, with no state until the first turn', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    await $.command.run(run('keepwarm', '3h every 90m'))
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache · keepwarm 3h00m')
    await $.turn.complete(turn())
    expect((await ui.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 3h00m left')
  })

  test('every label fits in 24 characters, the longest windows and cold spells included', () => {
    const now = 100 * HOUR
    const texts: string[] = []
    // An age of null is a session with no request yet.
    for (const age of [null, 0, 59 * MIN, HOUR + 59 * MIN, 23 * HOUR + 59 * MIN]) {
      for (const left of [0, 59 * MIN, 9 * HOUR + 59 * MIN]) {
        for (const stopped of [null, 'the ping failed']) {
          const s = { ...freshState(), lastRequestAt: age === null ? 0 : now - age, deadline: left ? now + left : 0, stopped }
          const label = footerLabel(s, now)
          if (label) texts.push(label.state ? `cache ${label.state}${label.sep}${label.detail}` : `cache${label.sep}${label.detail}`)
        }
      }
    }
    expect(texts).toContain('cache warm · 9h59m left')
    expect(texts).toContain('cache warm · 1h00m left')
    expect(texts).toContain('cache cold for 22h59m')
    expect(texts).toContain('cache · keepwarm 9h59m')
    expect(texts).toContain('cache · keepwarm stopped')
    // A warm cache always says how long it has left; nothing says "cold in" any more.
    expect(texts.filter(text => text.startsWith('cache warm') && !text.endsWith(' left'))).toEqual([])
    expect(texts.filter(text => text.length > 24)).toEqual([])
  })

  test('the band drops its row once the footer draws, and footer off brings it back', async ($, on) => {
    const clock = mock.clock(on, { now: 10 * HOUR })
    const store = new Map<string, unknown>()
    world(on, [], { store, bandText: 'other mod' })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    await $.turn.complete(turn())
    const band = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
    // Until the footer has drawn here, the row stays, so a build without the footer keeps its status.
    expect((await band.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
    const footer = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'SessionMode', props: footerProps })
    expect((await footer.find({ type: 'Text', text: /^cache/ }))?.text).toBe('cache warm · 1h00m left')
    // The footer's first draw redraws the band on the next tick.
    await clock.advance(1)
    expect(await band.find({ type: 'Text', text: 'cache-watch' })).toBe(undefined)
    expect((await band.find({ text: /^other mod$/ }))?.text).toBe('other mod')

    expect((await $.command.run(run('cache-watch', 'footer off'))).text).toBe('cache-watch: the status is back in the band above the prompt.')
    expect(store.get('footer')).toBe('off')
    expect((await band.find({ type: 'Text', text: 'cache-watch' }))?.text).toMatch(/warm.*goes cold in 1h00m/)
    expect(await footer.find({ type: 'Text', text: /^cache/ })).toBe(undefined)
    expect((await footer.find({ text: /^modes & focus$/ }))?.text).toBe('modes & focus')

    expect((await $.command.run(run('cache-watch', 'footer on'))).text).toMatch(/^cache-watch: the status shows in the prompt footer\. The footer has drawn \d+ times, last on desktop\.$/)
    expect(await band.find({ type: 'Text', text: 'cache-watch' })).toBe(undefined)
    expect((await $.command.run(run('cache-watch', 'footer loud'))).text).toBe('/cache-watch footer takes on or off')
  })

  test('footer off survives a new session', async ($, on) => {
    mock.clock(on, { now: 10 * HOUR })
    world(on, [], { store: new Map<string, unknown>([['footer', 'off']]) })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    expect((await $.command.run(run('cache-watch', 'footer'))).text).toBe('cache-watch: footer off. The footer has not drawn in this session yet, so the status stays in the band. /cache-watch footer on or off moves the status.')
  })
})

describe('resume card', () => {
  const tall = { ...bandProps, maxRows: 40 }
  const coldResume = { source: 'resume' as const, model: 'claude-opus-5-5', seconds_since_last_response: 13 * 24 * 3600, context_tokens: 230418, prompt_cache_likely_expired: true, estimated_cache_write_usd: 1.84 }

  test('desktop: a cold resume shows a card with the engine estimate instead of a log line, and Dismiss closes it', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    expect((await ui.find({ type: 'Text', text: /Resuming a cold chat/ }))?.text).toBe('CACHE WATCH · Resuming a cold chat · cold for 12d 23h')
    const alts = (await ui.findAll({ type: 'Svg' })).map(el => String(el.props.alt))
    expect(alts.some(alt => /^Send it now: \$1\.84, re-writes up to 230,418 tokens at \$8\/MTok\. A warm turn: \$0\.12/.test(alt))).toBe(true)
    expect((await ui.find({ key: 'resume-fresh' }))?.props.label).toBe('Start fresh')
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual([])
    await ui.press({ key: 'resume-dismiss' })
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
  })

  test('terminal: the card draws text bars, and the status row stays under it', async ($, on) => {
    mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'terminal', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    expect(await ui.find({ type: 'Svg' })).toBe(undefined)
    expect((await ui.find({ type: 'Text', text: /^Send it now/ }))?.text).toMatch(/^Send it now {2}\$1\.84 +█+ +re-writes up to 230,418 tokens at \$8\/MTok$/)
    expect((await ui.find({ type: 'Text', text: /^(warm|cold|unknown|stopped)$/ }))?.text).toBe('cold')
  })

  test('sending closes the note, and the hold card takes over for the cold send', async ($, on) => {
    mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    await $.prompt.submit(prompt('Where were we?'))
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
    expect(await ui.find({ text: /Your message is on hold/ })).not.toBe(undefined)
  })

  test('Start fresh clears the conversation; /cache-watch fresh and dismiss are its twins', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    world(on, [])
    const commands: string[] = []
    on('command.run', { command: 'clear' }, ($, e) => { commands.push(e.command); return { text: '' } })
    await $.session.start({ ...session, surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ plugin: 'cache-watch', surface: 'desktop', component: 'AbovePrompt', props: tall })
    await $.classic.SessionStart(coldResume)
    await ui.press({ key: 'resume-fresh' })
    expect(commands).toEqual(['clear'])
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)

    await $.classic.SessionStart(coldResume)
    expect((await $.command.run(run('cache-watch', 'fresh'))).text).toBe('cache-watch: starting fresh')
    await clock.advance(1)
    expect(commands).toEqual(['clear', 'clear'])

    await $.classic.SessionStart(coldResume)
    expect((await $.command.run(run('cache-watch', 'dismiss'))).text).toBe('cache-watch: the resume note is closed')
    expect(await ui.find({ text: /Resuming a cold chat/ })).toBe(undefined)
    expect((await $.command.run(run('cache-watch', 'dismiss'))).text).toBe('cache-watch: nothing to dismiss')
  })

  test('a surface that never draws the band gets the plain line after a short wait', async ($, on) => {
    const clock = mock.clock(on, { now: 400 * HOUR })
    const w = world(on, [])
    await $.session.start(session)
    await $.classic.SessionStart(coldResume)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual([])
    await clock.advance(RESUME_LOG_AFTER_MS + 1)
    expect(w.logs.filter(line => line.startsWith('resuming cold'))).toEqual(["resuming cold. The first message re-writes 230,418 tokens, about $1.84. If the cost isn't worth the squeeze, consider starting a fresh chat."])
  })

  test('the rate comes from the engine estimate when there is one, else the price table', () => {
    const s = { ...freshState(), ctx: 200000, lastModel: 'claude-opus-5-5' }
    expect(resumeNoteFrom(s, 1.6)).toEqual({ tokens: 200000, rate: '$8/MTok', coldUsd: 1.6, warmUsd: 0.1 })
    expect(resumeNoteFrom(s, undefined)).toEqual({ tokens: 200000, rate: '$10/MTok', coldUsd: 2, warmUsd: 0.1 })
  })
})
