# First In agent

A worker that runs First In on its own, 24/7, on GitHub Actions (free for public repos).

The agent works in shifts: one starts every hour on GitHub Actions and stays on for about 55 minutes, working in a loop every 2 minutes. What runs on each pass is decided from its memory:

| Job | How often | What it does |
|---|---|---|
| Telegram + Octo | every 2 min | Reads your commands. Octo reads pump.fun's live coins and pings strong curve coins. |
| Wallets | every 5 min | Checks watched wallets for new buys, flags when 2+ watched wallets buy the same coin. |
| Sweep | every 2 min | Every live runner (Octo's grabs + DexScreener) gets a quick pass: free kill → X account → top-10 holders → verdict → score, ranked on the radar. Momentum refreshes every pass for free; the holder check (Helius credits) is reused for 15 minutes, so credits only go to coins that just appeared. The best clean ones become **Chief's picks** with a written thesis on Telegram. |
| Deep scan | every 3 hours | First 30 buyers of the radar's best coins: dev bag, snipers, bundles, cabal wallets. Sharpens each pick's thesis, or withdraws the pick if it finds a problem. Then the cabal hunt. |
| Recap | daily, 08:43 Lagos | A recap of the last 24 hours. |

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
5. **Actions tab → First In agent → Run workflow** (task `all`) for a first run. After that it runs by itself. A manual run waits until the current shift ends.

## The desk

| Agent | Job |
|---|---|
| Octo 🐙 | Reads pump.fun's live tape every wake-up and grabs curve coins worth a look: past 20% of the curve, holding near their high, replies, a real X account, not from a serial launcher. Free (no Helius credits). |
| Scan | Finds what moves on DexScreener and reads each coin's first 30 buyers. |
| Social | Reads the coin's X account: age, followers, and whether the handle was used on another coin. |
| Vet | Reads the chain: dev bag, top 10 wallets, snipers, bundled launch, cabal wallets among early buyers. |
| Hunt | Finds wallets that keep buying early together and has Claude judge them. |
| Watch | Tracks your wallets and pings their buys. |
| Chief | Picks the best clean runners and writes a thesis for each (why it's on the desk, what could kill it, what would prove it wrong). Withdraws a pick out loud when it turns. Gives every scanned coin a verdict: CLEAN, RUG RISK, BUNDLED, BOTTED, CABAL RUN, SKETCHY SOCIALS, HEAVY BAGS or NO DATA. Never takes a position. |

Every threshold is in `agent/config.json` under `desk` and shows on the site's Agent tab.

## Telegram commands

`/watch <wallet> [label]` · `/unwatch <wallet or label>` · `/list` · `/scan <CA>` · `/octo` · `/status` · `/recap` · `/pause` · `/resume`

Commands are picked up within about 2 minutes while a shift is on. GitHub can start a shift a little late at busy times.

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
