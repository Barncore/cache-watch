# How cache-watch works

This page explains the ideas behind cache-watch: what the prompt cache is, why a cold one costs so much, what keepwarm actually does, and the trade-offs behind its defaults. For the exact commands and labels, see the [command reference](commands.md).

## The prompt cache

Every time you send a message, Claude Code sends the whole conversation to the API, not only your new message. Re-reading a long conversation from scratch every turn would be slow and expensive, so Anthropic keeps a cached copy of it on their side. When your next request starts with the same conversation, the API reads it from the cache instead of processing it again.

A cache read is cheap. Writing the cache, the first time or after it has expired, costs a lot more. With Opus 5's list prices, writing to the one-hour cache costs $10 per million tokens and reading it costs $0.50, so a write costs 20 times as much as a read. For Fable 5.1 it's 80 times ($20 against $0.25).

The cache expires an hour after it was last used, and every read resets that hour. So as long as you keep talking, it stays warm. Step away for more than an hour and it goes cold, and your next message pays to write the whole conversation again.

That's the screenshot in the README: a 442,614-token conversation, cold for almost six days. Sending "where were we?" into it would cost $4.43 just to rebuild the cache. If the cache had been warm, the same turn would have cost $0.22.

## What cache-watch watches

cache-watch doesn't ask Anthropic whether the cache is alive. It keeps its own clock: it notes the moment each of your requests goes out, and counts an hour from the last one. That's why the footer can say `cache warm · 54m left` and count down.

It's an estimate, and a good one, but some things can break a cache before the hour is up. Changing the model is one. Anything that changes the start of the conversation is another, because the cache only matches an identical beginning. After a compaction the clock resets and the footer drops the warm or cold state until your next turn, because the old cache no longer matches.

## The resume card

When you open an old chat, Claude Code tells mods how long it's been since the last reply and estimates what the first message will cost. If the cache has likely gone cold and the conversation is big, cache-watch shows a card above the prompt box with that price next to a warm turn's. It's a heads-up before you type anything. Scrolling back through the old chat costs nothing; only sending into it does. So if you only need what it worked out, copy that out, start fresh and paste it in: the new conversation is a few hundred tokens instead of the whole old one.

It used to be a plain line in the chat. A mod can't style lines in the chat, so the card took its place.

## The hold card

When the clock says cold and the conversation is at least 50,000 tokens, cache-watch holds your next message instead of sending it. The card shows two prices side by side: what sending now costs (the re-write at the cache-write rate) and what a warm turn would have cost (the same context at the read rate).

The cold price is an upper bound. The context size Claude Code reports for a resumed session includes the last reply's output, and there's no separate figure to subtract. On one 15-day-old session, cache-tax's author saw an estimate of $6.61 against an actual write of $6.28.

Claude Code also shows its own short notice that a hook held the prompt, with cache-watch's one-line reason. That's expected.

From the card:

- **Pay and send** sends the message as your own words. The cold write gets scored, and keepwarm then holds the cache for 3 hours, because once you've paid for a write it would be a shame to pay for another one an hour later. A pill above the prompt box says what the write cost. It goes at your next message, or after 15 minutes.
- **Start fresh** runs `/clear` and puts your message back in the prompt box. Starting a new conversation, perhaps with a short note about where you were, often costs less than rebuilding a huge old one. `/resume` still gets the old conversation back.
- **Show cache status** opens the status card inside the hold card, without adding anything to the conversation.

Sending again also pays, whether it's the same message or a different one. The hold happens once per cold spell, never twice.

Some messages are never held:

- **Slash commands.** Anything starting with `/` passes straight through.
- **Small conversations** under 50,000 tokens, where the re-write costs little.
- **Messages with a pasted image or file, or an `@file` mention.** A mod can't resend those, so holding them would leave you with no button that works. They go through, and the price shows on the receipt pill.
- **Everything, when the guard is set to warn** (`/cache-watch guard warn`). Then cold sends go through and the price shows on the receipt pill.

## Keepwarm and pings

Keepwarm keeps the cache from expiring while you're away, by using it before the hour runs out.

A **ping** is a tiny side request. Claude Code sends your whole conversation plus one extra line, "Reply with the single word: warm". The conversation matches the cache, so the API reads it from cache, which is cheap and resets the hour. The reply is thrown away. It never shows in your chat and never becomes part of the conversation.

cache-watch sends a ping 55 minutes after your last request, and again 55 minutes after each ping, until the window ends. Each ping's usage gets checked. If a ping reads nothing from the cache, or writes a tenth or more of what it read, the cache was already gone, so keepwarm stops and says why. It also stops on an API error or an interrupted ping. It doesn't retry, because a retry against a dead cache would be the expensive write you were trying to avoid.

A window belongs to one session. Resume that session and the window is still there. If the cache is already cold when you arm keepwarm, the first ping waits until after your next turn, because pinging a cold cache is a full write.

cache-tax's author checked once, in September 2026, that a ping really keeps a one-hour cache alive. That was Fable 5.1 on a subscription: the ping at minute 50 read 157k tokens from cache, and a message sent at minute 62 still read the conversation from cache. One run in one setup, but it's real evidence the mechanism works.

## Why 55 minutes

The cache lasts an hour, so why not ping at 59 minutes and save some money?

Because the two ways of getting the timing wrong cost very different amounts. A ping that lands a minute early wastes a sliver of one ping. A ping that lands a minute late finds the cache gone, and the next message pays a full re-write: on Opus that's the price of 20 pings. Several things can make a ping late:

- **The timer.** Pings come from a timer inside Claude Code, and a busy app can fire it late.
- **The request.** A ping sends your whole conversation. On a 400k-token conversation, getting it to the API and read back takes a while, longer when the API is slow.
- **Failures.** If a ping fails, keepwarm stops rather than retrying, so there's no second chance inside the hour.

cache-tax pinged at 50 minutes. Moving to 55 saves one ping in a 6-hour window (6 instead of 7) and keeps 5 minutes of slack, which is plenty for a slow request. Going to 58 would save no more pings in a 6-hour window and leave almost no slack. If you want a different gap for one window, `/keepwarm 6h every 50m` sets it.

## Why not keep it warm all the time

Because each ping costs a cache read of the whole conversation, and those add up.

Take the conversation from the screenshot: 442k tokens on Opus, $0.22 a ping, $4.43 a cold write. At one ping every 55 minutes:

- **Back within a few hours:** a few pings at $0.22 each beat one $4.43 re-write. Keepwarm wins clearly.
- **Overnight, about 8 hours:** 8 pings, about $1.76. Still cheaper than the re-write, if you come back to this conversation in the morning. If you don't, it's $1.76 spent on nothing.
- **All day, every day:** about 26 pings, nearly $5.75 a day. That's more than the cold write it's protecting against, every single day, for every conversation you leave on. Most conversations you never come back to.

So size the window to when you expect to be back. The status card shows the break-even for your model: how many pings cost the same as one cold write, and how much idle time that covers at the current gap. On Opus that's 20 pings, about 18 hours.

That's why plain `/keepwarm` gives you 6 hours, why a paid cold write arms only 3, and why `/keepwarm always` is opt-in.

## Subscriptions and dollars

The dollar figures are API list prices from September 2026, kept in one table at the top of `hooks/register.ts`. On an API key they're your bill.

On a Claude subscription they're a yardstick, not a bill. What you spend there is your usage allowance, the 5-hour and weekly limits. How heavily a cache read counts against those limits isn't documented anywhere we could find, so the trade-off on a subscription could be better or worse than the dollar maths says. Keep an eye on your usage during the first few windows.

## Where it draws

The status lives in the prompt footer, beside the model picker. The footer only fits about 26 characters, and the font's digits differ in width, so cache-watch keeps every label to 24 characters or fewer. That's why the footer says `cache warm · 2h07m left` and leaves details like the next ping time to `/keepwarm status`. The footer also can't draw images, so the cube icon doesn't appear there.

The band above the prompt box is for things that need you: the hold card, and the receipt pill after a paid write. Until the footer has drawn once in a session, the status row stays in the band too, so a Claude Code build that doesn't draw the footer still shows your status. `/cache-watch footer off` puts it back in the band for good.

### Why cache-tax didn't draw in the desktop app

A mod finds out where it's being drawn when the session starts. In the desktop app, though, the session starts before the Code tab connects, so at that moment the mod is told there's nowhere to draw. cache-tax took that answer and fell back to a plain status line for the whole session. cache-watch asks again each time something draws, and switches the band on as soon as the Code tab connects.
