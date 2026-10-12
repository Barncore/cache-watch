# cache-watch command reference

Every command, label and setting in cache-watch 1.1.3. For the reasons behind them, see [How it works](how-it-works.md).

## /keepwarm

| Command | Effect |
|---|---|
| `/keepwarm` | Arms a 6-hour window for this session. |
| `/keepwarm <window>` | Arms a window of your own. A window is hours, minutes or both: `90m`, `2h`, `2h30m`. |
| `/keepwarm <window> every <gap>` | Arms a window with its own ping gap, at least `1m`. The gap lasts for that window only; the next window goes back to 55 minutes. Short gaps are for testing: `/keepwarm 1h every 1m` shows a ping's cost within a minute. |
| `/keepwarm always` | Arms a 6-hour window now and at the start of every session, until `/keepwarm off`. |
| `/keepwarm status` | Says the time left, the next ping, and what the last ping read and cost. |
| `/keepwarm off` | Ends the window and turns `always` off. |

Pings go out 55 minutes after the last request, the last request being yours or a ping. If the cache is already cold when you arm a window, the first ping waits until after your next turn.

A window ends at its deadline, at `/keepwarm off`, or when a ping fails. A ping counts as failed when it:

- reads nothing from the cache,
- writes a tenth or more of what it read (the cache was already gone),
- hits an API error or is interrupted,
- comes back empty, or finds no conversation to warm.

The reason shows in `/keepwarm status` and on the `/cache-watch` card.

## /cache-watch

| Command | Effect |
|---|---|
| `/cache-watch` | Prints the status card (below). `/cache-watch status` does the same. |
| `/cache-watch pay` | Sends the held message and pays the cold write, as the **Pay and send** button does. |
| `/cache-watch fresh` | Runs `/clear` and puts the held message back in the prompt box, as **Start fresh** does. With no message held and the resume card showing, it only runs `/clear`. |
| `/cache-watch dismiss` | Closes the resume card, as its **Dismiss** button does. |
| `/cache-watch preview` | Shows the hold card with this session's numbers, holding nothing. Any button closes it. |
| `/cache-watch guard refuse` | Holds a cold send once on the card. This is the default. |
| `/cache-watch guard warn` | Lets cold sends through and shows the price on the receipt pill afterwards. |
| `/cache-watch footer on` | Shows the status in the prompt footer. This is the default. |
| `/cache-watch footer off` | Shows the status as a row above the prompt box instead. |
| `/cache-watch footer` | Says which is set, and whether the footer has drawn yet in this session. |

The `pay` and `fresh` commands do what the buttons do because a click in the desktop app can get lost while any mod redraws ([anthropics/claude-code#99211](https://github.com/anthropics/claude-code/issues/99211)). The first click on the band can also only move focus there. The commands always land.

### The status card

| Line | Shows |
|---|---|
| (first line) | The model the last turn used. |
| `state` | `warm, 54m left`, `COLD, last request 6h12m ago`, `no request yet this session`, or `reset by compaction`. |
| `context` | The conversation's size in tokens: what a cold send would re-write. |
| `cold cost` | The re-write at the cache-write rate, and a warm turn at the read rate. |
| `keepwarm` | The window's time left and next ping, `stopped` with the reason, or `off`. |
| `break-even` | How many pings cost the same as one cold write at the read rate, and how much idle time that covers at the current gap. |
| `guard` | `refuse once` or `warn only`. |
| `session` | Cold writes paid in this session, and their total. |

## The footer label

| Label | When |
|---|---|
| `cache warm · 2h07m left` | The cache is warm and keepwarm is running. The time is what's left in the window. |
| `cache warm · 54m left` | The cache is warm and keepwarm is off. The time is what's left of the hour. |
| `cache cold for 6m` | The cache has gone cold. Longer spells read `5d 20h`. |
| `cache · keepwarm 6h00m` | Keepwarm is armed but nothing has been sent yet in this session, or the conversation was just compacted. |
| `cache · keepwarm stopped` | Keepwarm stopped before the first turn. |
| (nothing) | No request yet, or just compacted, and keepwarm off. The app's own footer labels show as usual. |

`warm` is green and `cold` is orange, and both words are always there. Every label is 24 characters or fewer, because the desktop footer cuts text at about 26. The label redraws every minute while the cache is warm or keepwarm is running, and every 5 minutes while the cache sits cold with keepwarm off.

The status row above the prompt box, used when the footer is off or hasn't drawn yet, shows the same state with more detail: the cube icon, the next ping and the last ping's cost.

## The hold card

| Part | Shows |
|---|---|
| Header | `CACHE WATCH`, "Your message is on hold", and how long the cache has been cold. |
| Send it now | The re-write price, its token count and the cache-write rate. |
| A warm turn | What the same turn would have cost with the cache warm. |
| On hold | Your message, cut at 160 characters. |
| Buttons | **Pay and send**, **Start fresh**, **Show cache status**. |

When the band above the prompt has fewer rows than the full card needs (24 in the desktop app, 18 in a terminal), the card turns compact: a one-line header and thin bars, with the buttons still in view.

## The resume card

Opening an old chat whose cache Claude Code reports as likely expired, with 50,000 tokens or more of context, shows this card above the prompt box.

| Part | Shows |
|---|---|
| Header | `CACHE WATCH`, "Resuming a cold chat", and how long the cache has been cold. |
| Send it now | What your first message will cost to re-write the cache. This is Claude Code's own estimate when the resume carries one, and the rate shown is worked out from it. |
| A warm turn | What the same turn would cost with the cache warm. |
| Tip | "If the cost isn't worth the squeeze, consider starting a fresh chat." |
| Buttons | **Start fresh** runs `/clear`. **Dismiss** closes the card. |

The card goes when you send a message (a cold send then gets the hold card), run `/clear`, or press either button. Where no band draws, such as the VS Code panel, cache-watch logs a one-line version in the chat instead, 3 seconds after the session resumes.

## The receipt pill

After a paid cold write, a receipt pill above the prompt box says what the write cost and how long keepwarm now holds the cache. It goes at your next message, or after 15 minutes.

## Settings and environment

- **Theme.** The colours follow Claude Code's light or dark theme, and change when you switch.
- **`NO_COLOR`.** Set to anything non-empty before the session starts, it drops the colours and the cube image. The words carry the state on their own.

## What it stores

cache-watch keeps these in Claude Code's plugin store, on your machine:

| Key | Holds | Kept until |
|---|---|---|
| `deadline:<session id>` | When this session's keepwarm window ends | The window ends or stops |
| `every:<session id>` | A custom ping gap, only when you set one | The window ends or stops |
| `always` | Whether `/keepwarm always` is on | `/keepwarm off` |
| `guard` | `refuse` or `warn` | You change it |
| `footer` | `on` or `off` | You change it |

A session you never come back to leaves its two keepwarm keys behind, because cache-watch only cleans up the current session's keys. They're a few bytes each.

The held message and the session's cold-write tally live in memory for the session only. Nothing else is written anywhere.

## What it can reach

From `claude plugin validate` on Claude Code 2.1.295:

```
hooks: config.set{key=theme}, ui.render{component=AbovePrompt}, ui.render{component=SessionMode}, session.attach, session.start, classic.SessionStart, command.run{command=keepwarm}, command.run{command=cache-watch}, prompt.submit, turn.step, turn.complete, session.compact
calls: $.clock.after, $.clock.now, $.command.list, $.command.register, $.command.run (via startFresh), $.config.list, $.env.get, $.model.fork (via ping), $.prompt.fill (via startFresh), $.prompt.submit (via payAndSend), $.session.id, $.session.model, $.session.surfaces (via hasBandSurface), $.session.usage, $.state.get, $.state.set, $.store.delete (via prune, startWindow, stop), $.store.get, $.store.set, $.ui.invalidate, $.ui.log, $.ui.resolve, $.ui.status, $.ui.toast (via startFresh)
env reads: NO_COLOR
```

In plain words:

- **It reads every prompt you send.** It checks whether a message starts with `/`, whether it carries attachments or an `@file` mention, and, only when holding it, keeps the text so Pay and send can resend it.
- **It reads timing and usage.** That's when each request goes out, plus the token counts and model Claude Code already has for each turn and each ping.
- **It sends one kind of request of its own:** the keepwarm ping, with a fixed one-line prompt, only inside a keepwarm window. That's a window you armed, or the 3 hours it arms itself after you pay a cold write.
- **It sends your held message** when you press Pay and send, and runs `/clear` when you press Start fresh.
- **It has no file, network or process access.** `$.fs`, `$.http` and `$.process` aren't in its calls.
