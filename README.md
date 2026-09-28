# pi-token-usage

Global token and cost accounting for [pi](https://github.com/earendil-works/pi).

## What it does

- Per-model usage breakdown: input, output, cache read, cache write, cost
- Formatted totals -- compact `1.2k` / `3.45M` numbers, `$0.0234`-style costs
- Cumulative accounting across sessions, not just the current one

Inspired by Claude Code's cost tracker (`cost-tracker.ts` + `/cost`); the implementation
is original.

## Install

```bash
pi install git:github.com/hakergeniusz/pi-token-usage
```

MIT licensed.
