# First In agent

A worker that runs First In on its own, 24/7, on GitHub Actions (free for public repos).

| Job | When | What it does |
|---|---|---|
| watch | every 15 min | Octo reads pump.fun's live coins and pings strong curve coins. Checks watched wallets for new buys, pings Telegram, flags when 2+ watched wallets buy the same coin. Reads your Telegram commands. |
| scan | every 3 hours | Takes Octo's grabs and DexScreener runners through the desk: free kill → social kill (X account) → chain (first 30 buyers, dev bag, top 10, snipers, bundles, cabals) → Chief's verdict on Telegram. Then hunts for wallet groups that keep showing up early together. Strong groups get auto-watched. |
| recap | daily, 08:43 Lagos | Claude writes a recap of the last 24h and sends it. |

Its memory is one JSON file on the `agent-data` branch. The site's **Agent** tab reads it.

## Setup (about 10 minutes)

1. **Helius key for the agent.** Make a second free key at dashboard.helius.dev so site visitors can't use up the agent's credits.
2. **Telegram bot.** Message @BotFather, send `/newbot`, copy the token. Then message your new bot once, open `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy `chat.id` (for a group, add the bot to the group and use the group's id, which starts with `-`).
3. **Claude API key** from platform.claude.com (optional: without it the agent uses plain rules).
4. In the repo: **Settings → Secrets and variables → Actions → New repository secret**, add (`X_BEARER_TOKEN` is optional; without it Social uses a free public lookup):
   - `HELIUS_API_KEY`
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `ANTHROPIC_API_KEY`
5. **Actions tab → First In agent → Run workflow** (task `all`) for a first run. After that it runs by itself.

## The desk

| Agent | Job |
|---|---|
| Octo 🐙 | Reads pump.fun's live tape every wake-up and grabs curve coins worth a look: past 20% of the curve, holding near their high, replies, a real X account, not from a serial launcher. Free (no Helius credits). |
| Scan | Finds what moves on DexScreener and reads each coin's first 30 buyers. |
| Social | Reads the coin's X account: age, followers, and whether the handle was used on another coin. |
| Vet | Reads the chain: dev bag, top 10 wallets, snipers, bundled launch, cabal wallets among early buyers. |
| Hunt | Finds wallets that keep buying early together and has Claude judge them. |
| Watch | Tracks your wallets and pings their buys. |
| Chief | Gives every scanned coin a verdict: CLEAN, RUG RISK, BUNDLED, BOTTED, CABAL RUN, SKETCHY SOCIALS, HEAVY BAGS or NO DATA. Never takes a position. |

Every threshold is in `agent/config.json` under `desk` and shows on the site's Agent tab.

## Telegram commands

`/watch <wallet> [label]` · `/unwatch <wallet or label>` · `/list` · `/scan <CA>` · `/octo` · `/status` · `/recap` · `/pause` · `/resume`

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
