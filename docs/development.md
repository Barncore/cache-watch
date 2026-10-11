# Developing cache-watch

How to run, check and release a change. You'll need Claude Code 2.1.287 or later, with `claude` on your PATH.

## Find your way around

| Path | What's in it |
|---|---|
| `hooks/register.ts` | The whole mod: the price table, the cache clock, keepwarm, the guard and hold card, the footer label, and both commands. |
| `hooks/status-icons.ts` | The cube icons, embedded as SVG and PNG. Generated, so don't edit it by hand. |
| `types/index.d.ts` | The types of the values the mod keeps in session state (`held`, `showStatus`, `receipt`). |
| `tests/register.test.ts` | Tests against a mock clock and a mock engine. |
| `assets/cube-*.svg`, `tools/generate-status-icons.py` | The icon sources and the script that turns them into `status-icons.ts`. |
| `.claude-plugin/` | `plugin.json` (the mod) and `marketplace.json` (what makes this repo installable). |

## Run it from a checkout

In a terminal, from the repository root:

```bash
claude --plugin-dir .
```

That loads the checkout for that one session, on top of whatever you have installed. Turn off an installed cache-watch first, or both copies will guard every cold send.

The desktop app takes no command-line flags. To see a change there, install it from a marketplace and restart the app. A fresh session runs the copy made at install time, not your checkout, and Claude Code only replaces that copy when `version` changes. So bump the version for every change you want to see, or the restart brings back the old code.

## Check a change

Validate the manifests and the hooks module. Its `calls:` line lists everything the mod can reach, so check nothing new turned up there:

```bash
claude plugin validate .
```

Run the tests:

```bash
claude plugin test .
```

Validate doesn't type-check, so type-check too. Loading the checkout once with `claude --plugin-dir .` writes Claude Code's type declarations into `.claude-plugin/types/`, which `tsconfig.json` already includes. Then:

```bash
npx -p typescript tsc -p .
```

No output means it passed. Keep `.claude-plugin/types/` out of git; `.gitignore` already does. (This is the route cache-tax documents. cache-watch's own type-checks ran with TypeScript 5.9 against the same declarations, through a tsconfig kept outside the repo.)

Passing tests don't prove the desktop app draws it right. The tests check the tree of elements the mod returns, while the app decides how to draw it, and it presses buttons differently from the test kit. After a change to anything visible, install it and look.

## Update the prices

Prices live in the `PRICES` table near the top of `hooks/register.ts`, one row per model family: cache read, one-hour cache write and output, in dollars per million tokens. A model id matches the first row whose name it contains, so longer names go first. Check against [Anthropic's pricing page](https://platform.claude.com/docs/en/about-claude/pricing).

## Regenerate the icons

Edit `assets/cube-dark.svg` or `assets/cube-light.svg`, then run the following with [librsvg](https://wiki.gnome.org/Projects/LibRsvg)'s `rsvg-convert` on your PATH:

```bash
python3 tools/generate-status-icons.py
```

It rewrites `hooks/status-icons.ts` with an SVG for the desktop app and a PNG for terminals, in warm, cold and neutral colours for each theme.

## Release

1. Bump `version` in `.claude-plugin/plugin.json`.
2. Run validate, the tests and the type-check.
3. Commit and push to `main`.

People pick it up with:

```bash
claude plugin marketplace update cache-watch
```

```bash
claude plugin update cache-watch@cache-watch --scope user
```

Then they restart the app.
