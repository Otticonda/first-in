# First In agent

A worker that runs First In on its own, 24/7, on GitHub Actions (free for public repos).

| Job | When | What it does |
|---|---|---|
| watch | every 15 min | Checks watched wallets for new buys, pings Telegram, flags when 2+ watched wallets buy the same coin. Reads your Telegram commands. |
| scan | every 2 hours | Finds fresh Solana runners on DexScreener, scans each coin's first 30 buyers and their PnL, then hunts for wallet groups that keep showing up early together. Claude judges each group (cabal / smart money / bot farm / noise). Strong groups get auto-watched. |
| recap | daily, 08:43 Lagos | Claude writes a recap of the last 24h and sends it. |

Its memory is one JSON file on the `agent-data` branch. The site's **Agent** tab reads it.

## Setup (about 10 minutes)

1. **Helius key for the agent.** Make a second free key at dashboard.helius.dev so site visitors can't use up the agent's credits.
2. **Telegram bot.** Message @BotFather, send `/newbot`, copy the token. Then message your new bot once, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (for a group, add the bot to the group and use the group's id, which starts with `-`).
3. **Claude API key** from platform.claude.com (optional: without it the agent uses plain rules).
4. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `HELIUS_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `ANTHROPIC_API_KEY`
5. **Actions tab → First In agent → Run workflow** (task `all`) for a first run. After that it runs by itself.

## Telegram commands

`/watch <wallet> [label]` · `/unwatch <wallet or label>` · `/list` · `/scan <CA>` · `/status` · `/recap` · `/pause` · `/resume`

Commands are picked up on the next wallet check, so replies take up to ~15 min (GitHub's scheduler can run late at busy times).

## Tuning (`agent/config.json`)

- `seedWatch`: wallets to start with, e.g. `[{"a": "WALLET", "label": "whale"}]`
- `watch.alertMinSol`: smallest buy that pings you
- `scan.coinsPerRun`, `scan.minMcapUsd`, `scan.maxAgeHours`: which runners get scanned
- `scan.creditBudgetPerRun`, `budget.monthlyCredits`: Helius credit guard rails (free plan is 1M credits/month)
- `autoWatch`: whether the agent adds strong wallets to the watchlist by itself, and how many
- `brain.judgeModel` / `brain.recapModel`: Claude models used

## Test locally

```
node agent/test/run-tests.mjs
```

Runs the whole agent against a fake chain, DexScreener, Claude and Telegram. No keys needed.
