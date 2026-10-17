#!/usr/bin/env node
// First In agent. Wakes up on a schedule (GitHub Actions), does its job, saves state, goes back to sleep.
//   node agent/run.mjs watch   – check watched wallets for new buys, handle Telegram commands
//   node agent/run.mjs scan    – find fresh runners, scan their first buyers, hunt cabals
//   node agent/run.mjs recap   – write and send the daily recap
//   node agent/run.mjs all     – everything (handy for a manual test run)

import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {dirname, resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createSolana, isAddr, short, BudgetError} from './lib/solana.mjs';
import {pairInfo, candidates} from './lib/dex.mjs';
import {checkSocial} from './lib/social.mjs';
import {vetChain} from './lib/vet.mjs';
import {DEFAULT_THRESHOLDS, freeKill, priority, socialKill, chiefVerdict} from './lib/desk.mjs';
import {analyze, matchPrevious, round} from './lib/cabal.mjs';
import {judgeClusters, writeRecap} from './lib/brain.mjs';
import {createTelegram, esc} from './lib/telegram.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DAY = 86400e3;

const freshState = () => ({
  version: 1, updatedAt: 0, paused: false, tgOffset: 0,
  runs: {}, watch: [], buys: [], overlaps: {}, coins: [], queue: [],
  analysis: {coinsAnalyzed: 0, bots: [], repeaters: [], clusters: []},
  judged: [], alerts: [], recaps: [], log: [],
  desk: {events: [], verdicts: [], pipeline: null, handles: {}, agents: {}, thresholds: null},
  credits: {month: '', used: 0, day: '', today: 0, lastRun: 0},
});

function merge(base, over){
  if(!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = {...base};
  for(const [k, v] of Object.entries(over)) out[k] = base && typeof base[k] === 'object' && !Array.isArray(base[k]) ? merge(base[k], v) : v;
  return out;
}

const usd = v => { const a = Math.abs(v || 0); if(a >= 1e9) return '$' + (a/1e9).toFixed(1) + 'B'; if(a >= 1e6) return '$' + (a/1e6).toFixed(1) + 'M'; if(a >= 1e3) return '$' + (a/1e3).toFixed(0) + 'K'; return '$' + a.toFixed(0); };
const solTxt = v => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3)) + ' SOL';
const chart = (mint, label = 'chart') => `<a href="https://dexscreener.com/solana/${mint}">${label}</a>`;
const gmgn = a => `<a href="https://gmgn.ai/sol/address/${a}">${esc(short(a))}</a>`;

/* What the site and the cabal hunter need from a scan, rounded so the state file stays small. */
function compactCoin(c){
  if(c.skipped) return {mint: c.mint, symbol: c.symbol, name: c.name, skipped: c.skipped, at: c.at, diag: c.diag};
  const r = v => round(v, 6);
  return {
    mint: c.mint, symbol: c.symbol, name: c.name, viaPump: c.viaPump, migrated: c.migrated, dev: c.dev,
    createSlot: c.createSlot, createTime: c.createTime, supply: c.supply, decimals: c.decimals, priceSol: c.priceSol, at: c.at, diag: c.diag, desk: c.desk,
    buyers: c.buyers.map(b => ({
      owner: b.owner, rank: b.rank, slotDelta: b.slotDelta, secs: b.secs, t: b.t, firstPrice: b.firstPrice,
      pos: b.pos ? {cost: r(b.pos.cost), bought: r(b.pos.bought), proceeds: r(b.pos.proceeds), sold: r(b.pos.sold), moved: r(b.pos.moved),
        received: r(b.pos.received), held: r(b.pos.held), value: r(b.pos.value), pnl: r(b.pos.pnl), entryPrice: b.pos.entryPrice,
        sellPrice: b.pos.sellPrice, buys: b.pos.buys, sells: b.pos.sells, status: b.pos.status, partial: b.pos.partial,
        priced: b.pos.priced, lastSell: b.pos.lastSell} : null,
    })),
  };
}

/* One status card per desk agent, built from what's in memory. */
function deskAgents(state, creditsThisRun){
  const ev = a => state.desk.events.find(e => e.agent === a);
  const v0 = state.desk.verdicts[0];
  const coin0 = v0 && state.coins.find(c => c.mint === v0.mint);
  const vet = coin0?.desk?.vet, soc = coin0?.desk?.social;
  const pipe = state.desk.pipeline;
  const recent = state.desk.verdicts.filter(v => v.t > Date.now() - 86400e3);
  const clean = recent.filter(v => v.verdict === 'CLEAN').length;
  const groups = (state.analysis.clusters || []).filter(c => ['cabal', 'smart_money'].includes(c.verdict));
  const buys24 = state.buys.filter(b => b.t * 1000 > Date.now() - 86400e3).length;
  const card = (agent, role, o) => ({agent, role, last: ev(agent)?.text || '', t: ev(agent)?.t || 0, ...o});
  return {
    chief: card('chief', 'never takes a position', {big: v0 ? `$${v0.symbol} · ${v0.verdict}` : 'no verdict yet', metric: 'clean today', value: recent.length ? clean / recent.length : null, small: `${clean} clean · ${recent.length - clean} flagged (24h)`}),
    scan: card('scan', 'finding what moves', {big: pipe ? `${pipe.rows.filter(r => r.free === 'PASS').length}/${pipe.seen} pass` : '—', metric: 'free_kill survivors', value: pipe && pipe.seen ? pipe.rows.filter(r => r.free === 'PASS').length / Math.min(pipe.seen, 14) : null}),
    vet: card('vet', 'chain risk, is it real', {big: vet ? vet.worst : '—', metric: vet ? `${vet.worst} · $${v0.symbol}` : 'no coin vetted', value: vet ? vet.score : null}),
    social: card('social', "the project's X account", {big: soc ? (soc.handle ? '@' + soc.handle : soc.kind) : '—', metric: soc ? `${soc.worst} · $${v0.symbol}` : 'no account read', value: soc ? soc.score : null}),
    hunt: card('hunt', 'who moves together', {big: `${groups.length} group${groups.length === 1 ? '' : 's'}`, metric: `${state.analysis.coinsAnalyzed || 0} coins in memory`, value: groups[0]?.confidence != null ? groups[0].confidence / 100 : null}),
    watch: card('watch', 'whale radar', {big: `${state.watch.length} wallets`, metric: `${buys24} buys in 24h`, value: state.watch.length ? Math.min(1, buys24 / Math.max(1, state.watch.length * 2)) : null}),
    credits: creditsThisRun,
  };
}

export async function runAgent({task = 'watch', env = process.env, fetchImpl = fetch, statePath, configPath, gapMs} = {}){
  const cfg = merge({desk: {...DEFAULT_THRESHOLDS, socialChecksPerRun: 6}}, JSON.parse(await readFile(configPath || resolve(HERE, 'config.json'), 'utf8')));
  statePath = statePath || resolve(env.STATE_FILE || 'state/agent.json');
  let state = freshState();
  try { state = merge(freshState(), JSON.parse(await readFile(statePath, 'utf8'))); } catch {}

  const now = Date.now();
  const rpcUrl = env.HELIUS_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${encodeURIComponent(env.HELIUS_API_KEY)}` : '');
  const sol = createSolana({rpcUrl, fetchImpl, gapMs, log: m => note(m)});
  const tg = createTelegram({token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, fetchImpl, dryRun: env.DRY_RUN === '1'});
  const brain = {apiKey: env.ANTHROPIC_API_KEY, fetchImpl};
  const outbox = [];   // Telegram lines for this run
  const replies = [];  // answers to commands, sent first

  function note(msg){ console.log(`[${task}] ${msg}`); state.log.unshift({t: Date.now(), task, msg}); state.log = state.log.slice(0, 60); }
  function alert(kind, title, body, html, extra = {}){
    state.alerts.unshift({t: Date.now(), kind, title, body, ...extra});
    state.alerts = state.alerts.slice(0, 200);
    if(html) outbox.push(html);
  }
  function deskEvent(agent, text){ state.desk.events.unshift({t: Date.now(), agent, text}); state.desk.events = state.desk.events.slice(0, 80); }
  const labelOf = a => state.watch.find(w => w.a === a)?.label || short(a);
  const isWatched = a => state.watch.some(w => w.a === a);

  // monthly credit guard
  const month = new Date(now).toISOString().slice(0, 7), day = new Date(now).toISOString().slice(0, 10);
  if(state.credits.month !== month){ state.credits.month = month; state.credits.used = 0; }
  if(state.credits.day !== day){ state.credits.day = day; state.credits.today = 0; }
  const creditsLeft = () => cfg.budget.monthlyCredits - state.credits.used - sol.credits;

  /* ---------- Telegram commands ---------- */
  async function handleCommands(){
    const {commands, offset} = await tg.poll(state.tgOffset);
    state.tgOffset = offset;
    for(const {cmd, args} of commands){
      try {
        if(cmd === 'start' || cmd === 'help'){
          replies.push(['<b>First In agent</b>',
            '/watch &lt;wallet&gt; [label] – watch a wallet', '/unwatch &lt;wallet or label&gt;', '/list – watched wallets',
            '/scan &lt;CA&gt; – scan a coin\'s first buyers', '/status – credits, last runs', '/recap – recap now',
            '/pause · /resume – stop or restart scans and wallet checks', '', 'I read commands every ~15 min.'].join('\n'));
        } else if(cmd === 'watch'){
          const [a, ...lbl] = args;
          if(!isAddr(a || '')) { replies.push('That isn\'t a Solana wallet address.'); continue; }
          if(isWatched(a)) { replies.push(`Already watching ${esc(labelOf(a))}.`); continue; }
          state.watch.push({a, label: lbl.join(' ').slice(0, 30), by: 'you', addedAt: now});
          replies.push(`Watching ${gmgn(a)}${lbl.length ? ` as <b>${esc(lbl.join(' '))}</b>` : ''}. I'll ping you on its buys.`);
        } else if(cmd === 'unwatch'){
          const q = args.join(' ').toLowerCase();
          const before = state.watch.length;
          state.watch = state.watch.filter(w => w.a.toLowerCase() !== q && (w.label || '').toLowerCase() !== q);
          replies.push(before > state.watch.length ? `Removed ${before - state.watch.length} wallet.` : 'No watched wallet matches that.');
        } else if(cmd === 'list'){
          replies.push(state.watch.length ? `<b>Watching ${state.watch.length}</b>\n` + state.watch.map(w => `${w.label ? `<b>${esc(w.label)}</b> ` : ''}${gmgn(w.a)}${w.by === 'agent' ? ' · auto' : ''}`).join('\n') : 'Not watching any wallets yet. /watch &lt;wallet&gt; [label]');
        } else if(cmd === 'scan'){
          const m = args[0] || '';
          if(!isAddr(m)) { replies.push('Send /scan followed by a coin CA.'); continue; }
          state.coins = state.coins.filter(c => c.mint !== m);
          if(!state.queue.includes(m)) state.queue.push(m);
          replies.push(`Queued <code>${esc(short(m))}</code>. Scanning it this run.`);
        } else if(cmd === 'status'){
          const last = k => state.runs[k] ? Math.round((now - state.runs[k]) / 60000) + 'm ago' : 'never';
          const top = state.analysis.clusters.find(c => c.verdict === 'cabal');
          replies.push([`<b>Status</b>${state.paused ? ' · PAUSED' : ''}`,
            `Wallet check: ${last('watch')} · Scan: ${last('scan')} · Recap: ${last('recap')}`,
            `Watching ${state.watch.length} wallets · ${state.coins.filter(c => !c.skipped).length} coins in memory`,
            `Credits: ${state.credits.used.toLocaleString()} / ${cfg.budget.monthlyCredits.toLocaleString()} this month`,
            top ? `Top cabal: ${top.size} wallets on ${top.coins.map(c => '$' + esc(c.symbol)).join(' ')} (${top.confidence}%)` : ''].filter(Boolean).join('\n'));
        } else if(cmd === 'recap'){
          state.forceRecap = true;
          replies.push('Writing a recap now.');
        } else if(cmd === 'pause'){ state.paused = true; replies.push('Paused. Commands still work. /resume to restart.'); }
        else if(cmd === 'resume'){ state.paused = false; replies.push('Back on.'); }
        else replies.push('Unknown command. /help');
      } catch(e){ replies.push('That failed: ' + esc(e.message)); }
    }
  }

  /* ---------- watch: new buys by watched wallets ---------- */
  async function watchWallets(){
    const wc = cfg.watch;
    const fresh = [];
    for(const w of state.watch.slice(0, wc.maxWallets)){
      try {
        if(w.lastSig === undefined){
          const r = await sol.rpc('getSignaturesForAddress', [w.a, {limit: 1}]);
          w.lastSig = r[0]?.signature || ''; continue;   // start from now, don't flood old history
        }
        const opts = {limit: wc.sigsPerWallet}; if(w.lastSig) opts.until = w.lastSig;
        const sigs = await sol.rpc('getSignaturesForAddress', [w.a, opts]);
        if(!sigs.length) continue;
        w.lastSig = sigs[0].signature;
        const ok = sigs.filter(s => !s.err);
        const txs = await sol.pool(ok, 6, s => sol.getTx(s.signature));
        txs.forEach((tx, i) => { for(const b of sol.walletBuys(tx, w.a)) fresh.push({w: w.a, mint: b.mint, sol: round(b.sol, 4), sig: ok[i].signature, t: ok[i].blockTime || Math.floor(now / 1000)}); });
      } catch(e){ if(e instanceof BudgetError) throw e; note(`${labelOf(w.a)}: ${e.message}`); }
    }
    if(!fresh.length){ note('No new buys.'); return; }

    const mints = [...new Set(fresh.map(b => b.mint))];
    const info = await pairInfo(mints, fetchImpl);
    const missing = mints.filter(m => !info[m]?.symbol);
    const meta = missing.length ? await sol.names(missing) : {};
    for(const b of fresh){ b.sym = info[b.mint]?.symbol || meta[b.mint]?.symbol || short(b.mint); b.mcap = info[b.mint]?.mcap || 0; }
    state.buys = [...fresh, ...state.buys].filter(b => (now / 1000 - b.t) < 7 * 86400).slice(0, 1000);
    note(`${fresh.length} new buy${fresh.length > 1 ? 's' : ''}.`);
    for(const b of fresh.slice(0, 4)) deskEvent('watch', `${labelOf(b.w)} bought $${b.sym} · ${solTxt(b.sol)}`);

    // per-buy pings, capped per wallet so a bot wallet can't flood the chat
    const perWallet = new Map();
    for(const b of fresh.sort((a, c) => c.sol - a.sol)){
      if(b.sol < wc.alertMinSol) continue;
      const n = (perWallet.get(b.w) || 0) + 1; perWallet.set(b.w, n);
      if(n > wc.maxAlertsPerWallet) continue;
      alert('buy', `${labelOf(b.w)} bought $${b.sym}`, `${solTxt(b.sol)}${b.mcap ? ' · mcap ' + usd(b.mcap) : ''}`,
        `👀 <b>${esc(labelOf(b.w))}</b> bought <b>$${esc(b.sym)}</b> · ${solTxt(b.sol)}${b.mcap ? ' · ' + usd(b.mcap) + ' mcap' : ''}\n${chart(b.mint)} · <a href="https://solscan.io/tx/${b.sig}">tx</a> · <code>${b.mint}</code>`,
        {mint: b.mint, wallets: [b.w]});
    }

    // overlaps: several watched wallets in the same coin inside the window
    const since = now / 1000 - wc.overlapWindowHours * 3600;
    const byMint = new Map();
    for(const b of state.buys){ if(b.t < since) continue; const s = byMint.get(b.mint) || {mint: b.mint, sym: b.sym, mcap: b.mcap, wallets: new Set()}; s.wallets.add(b.w); byMint.set(b.mint, s); }
    for(const [m, o] of Object.entries(state.overlaps)) if(o.t < now - wc.overlapWindowHours * 3600e3) delete state.overlaps[m];
    for(const s of byMint.values()){
      const n = s.wallets.size;
      if(n < wc.overlapMin || n <= (state.overlaps[s.mint]?.count || 0)) continue;
      state.overlaps[s.mint] = {count: n, t: now, sym: s.sym};
      deskEvent('watch', `${n} watched wallets are in $${s.sym}`);
      const mcap = info[s.mint]?.mcap || s.mcap;
      alert('overlap', `${n} watched wallets in $${s.sym}`, [...s.wallets].map(labelOf).join(', '),
        `🔥 <b>Overlap: ${n} watched wallets in $${esc(s.sym)}</b>${mcap ? ' · ' + usd(mcap) + ' mcap' : ''}\n${[...s.wallets].map(a => esc(labelOf(a))).join(', ')}\n${chart(s.mint)} · <code>${s.mint}</code>`,
        {mint: s.mint, wallets: [...s.wallets]});
    }
  }

  /* ---------- scan: fresh runners -> first buyers -> cabal hunt ---------- */
  /* SOCIAL: the project's X account. Remembers every handle so a reused one gets caught. */
  async function social(item){
    const seen = new Map(Object.entries(state.desk.handles).map(([h, ms]) => [h, new Set(ms)]));
    const s = await checkSocial(item, {token: env.X_BEARER_TOKEN, fetchImpl, seenHandles: seen, now});
    if(s.handle){ const h = s.handle.toLowerCase(); state.desk.handles[h] = [...new Set([...(state.desk.handles[h] || []), item.mint])].slice(-10); }
    delete s.account?.bio;
    deskEvent('social', `$${item.symbol}: ${s.line}${s.score >= 0.5 ? ` · ${s.worst} ${s.score}` : ''}`);
    return s;
  }

  /* SCAN the first buyers -> VET the chain -> CHIEF's verdict */
  async function scanCoins(list){
    const sc = cfg.scan, soft = cfg.desk.soft;
    sol.budget(Math.min(sc.creditBudgetPerRun, Math.max(0, creditsLeft())));
    const done = [];
    const cabalWallets = new Set(state.judged.filter(j => j.verdict === 'cabal' && j.confidence >= cfg.cabal.alertMinConfidence).flatMap(j => j.wallets));
    for(const item of list){
      try {
        deskEvent('scan', `reading the first ${sc.buyersPerCoin} buyers of $${item.symbol || short(item.mint)}`);
        const res = await sol.scanCoin(item.mint, sc.buyersPerCoin, {meta: {symbol: item.symbol, name: item.name}, maxPagesPump: sc.maxPagesPump, maxPagesOther: sc.maxPagesOther});
        state.queue = state.queue.filter(m => m !== item.mint);
        if(res.skipped){
          note(`$${res.symbol} skipped: ${res.skipped}`);
          state.coins = [compactCoin(res), ...state.coins.filter(c => c.mint !== item.mint)];
          continue;
        }
        const read = res.buyers.filter(b => b.pos && b.pos.status !== 'unknown');
        const wins = read.filter(b => b.pos.pnl > 0.0005).length;
        note(`Scanned $${res.symbol}: ${wins}/${read.length} early wallets in profit.`);

        const s = item.social || (item.socials ? await social(item) : null);
        const v = await vetChain(res, sol.rpc, {cabalWallets});
        deskEvent('vet', `$${res.symbol}: ${v.line || 'nothing to flag'}`);
        res.desk = {social: s, vet: v, mcap: item.mcap || 0, vol24: item.vol24 || 0, wins, read: read.length, t: now};
        state.coins = [compactCoin(res), ...state.coins.filter(c => c.mint !== item.mint)];
        done.push(res);
      } catch(e){
        if(e instanceof BudgetError){ note('Scan budget used up for this run; the rest waits for next run.'); break; }
        note(`$${item.symbol || short(item.mint)} failed: ${e.message}`);
      }
    }
    sol.budget(null);
    const ok = state.coins.filter(c => !c.skipped), skipped = state.coins.filter(c => c.skipped);
    state.coins = [...ok.slice(0, sc.keepCoins), ...skipped.slice(0, 100)];
    return done;
  }

  /* CHIEF: runs after the hunt, so a cabal found this run counts against the coins it was early on */
  function judgeCoins(done){
    const soft = cfg.desk.soft;
    const cabalWallets = new Set(state.judged.filter(j => j.verdict === 'cabal' && j.confidence >= cfg.cabal.alertMinConfidence).flatMap(j => j.wallets));
    for(const res of done){
      const d = res.desk, v = d.vet, s = d.social;
      const n = res.buyers.filter(b => cabalWallets.has(b.owner)).length;
      if(n){ v.facts.cabalWallets = n; v.flags.cabal_in_early = Math.round(Math.min(1, n / 4) * 100) / 100; if(!/cabal wallets/.test(v.line)) v.line += ` · ${n} cabal wallets early`; }
      const chief = chiefVerdict({social: s, vet: v}, soft);
      Object.assign(d, {verdict: chief.verdict, reasons: chief.reasons});
      const stored = state.coins.find(c => c.mint === res.mint); if(stored) stored.desk = d;
      const row = state.desk.pipeline?.rows?.find(r => r.mint === res.mint); if(row) row.chain = chief.verdict;
      deskEvent('chief', `$${res.symbol} is ${chief.verdict}${chief.reasons[0] ? ` (${chief.reasons[0]})` : ''}`);
      state.desk.verdicts = [{t: now, mint: res.mint, symbol: res.symbol, verdict: chief.verdict, reasons: chief.reasons, social: s?.line || '', vet: v.line, mcap: d.mcap, wins: d.wins, read: d.read},
        ...state.desk.verdicts.filter(x => x.mint !== res.mint)].slice(0, 40);
      const icon = chief.verdict === 'CLEAN' ? '✅' : '⚠️';
      alert('verdict', `$${res.symbol} · ${chief.verdict}`, [v.line, s?.line, `${d.wins}/${d.read} early wallets in profit`].filter(Boolean).join('\n'),
        `🧑‍⚖️ <b>$${esc(res.symbol)}</b> · ${icon} <b>${chief.verdict}</b>${d.mcap ? ' · ' + usd(d.mcap) + ' mcap' : ''}\n` +
        `VET: ${esc(v.line || 'nothing flagged')}\n` + (s ? `SOCIAL: ${esc(s.line)}\n` : '') +
        (chief.reasons.length ? `Why: ${esc(chief.reasons.join(', '))}\n` : '') +
        `${d.wins}/${d.read} early wallets in profit\n${chart(res.mint)} · <code>${res.mint}</code>`, {mint: res.mint});
    }
  }

  async function hunt(){
    const cc = cfg.cabal;
    const res = analyze(state.coins, cc);
    const previous = state.judged;
    const toJudge = [];
    const clusters = res.clusters.slice(0, 20).map(c => {
      const prev = matchPrevious(c, previous);
      if(prev && prev.coinsCount >= c.coins.length) return {...c, verdict: prev.verdict, confidence: prev.confidence, why: prev.why, by: prev.by};
      if(c.score >= cc.judgeMinScore && toJudge.length < cfg.brain.maxClustersPerRun) toJudge.push(c);
      return c;
    });
    const verdicts = await judgeClusters(toJudge, {...brain, model: cfg.brain.judgeModel});
    for(const v of verdicts){
      const c = clusters.find(x => x.id === v.id);
      Object.assign(c, {verdict: v.verdict, confidence: v.confidence, why: v.why, by: v.by});
      state.judged = [{id: c.id, wallets: c.wallets, coinsCount: c.coins.length, verdict: v.verdict, confidence: v.confidence, why: v.why, by: v.by, t: now},
        ...state.judged.filter(j => j.id !== c.id)].slice(0, 200);
      if(['cabal', 'smart_money'].includes(v.verdict) && v.confidence >= cc.alertMinConfidence){
        const icon = v.verdict === 'cabal' ? '🕵️' : '🧠';
        const tag = v.verdict === 'cabal' ? 'CABAL' : 'SMART MONEY';
        alert('cluster', `${tag} · ${c.size} wallets · ${c.coins.length} coins`, `${v.alert}\n${v.why}`,
          `${icon} <b>${tag}</b> · ${v.confidence}% · ${c.size} wallets on ${c.coins.map(x => '$' + esc(x.symbol)).join(' ')}\n${esc(v.alert)}\n<i>${esc(v.why)}</i>\n${c.wallets.slice(0, 6).map(gmgn).join(' · ')}`,
          {wallets: c.wallets, clusterId: c.id});
      }
    }
    state.analysis = {at: now, coinsAnalyzed: res.coinsAnalyzed, bots: res.bots.slice(0, 50), repeaters: res.repeaters.slice(0, 40), clusters};
    const topC = clusters.find(c => c.verdict === 'cabal' || c.verdict === 'smart_money');
    deskEvent('hunt', topC ? `${topC.size} wallets moving together on ${topC.coins.length} coins · ${topC.verdict} ${topC.confidence ?? ''}%` : `${res.repeaters.length} repeat wallets across ${res.coinsAnalyzed} coins, no group yet`);
    note(`Cabal hunt: ${res.coinsAnalyzed} coins, ${res.repeaters.length} repeat wallets, ${res.clusters.length} groups, ${verdicts.length} judged.`);

    // auto-watch: the strongest wallets go on the watchlist so their next buys get pinged
    const aw = cfg.autoWatch;
    if(!aw.enabled) return;
    const added = [];
    const room = () => aw.maxAgentWallets - state.watch.filter(w => w.by === 'agent').length;
    for(const c of clusters){
      if(!['cabal', 'smart_money'].includes(c.verdict) || (c.confidence || 0) < aw.minConfidence) continue;
      for(const a of c.wallets){ if(room() <= 0) break; if(!isWatched(a)){ state.watch.push({a, label: `${c.verdict === 'cabal' ? 'cabal' : 'smart'}-${c.id.slice(1, 5)}`, by: 'agent', addedAt: now, reason: c.why}); added.push(a); } }
    }
    for(const r of res.repeaters){
      if(room() <= 0) break;
      if(r.hits >= aw.repeaterMinCoins && r.wins / r.hits >= 0.66 && !r.dev && !isWatched(r.owner)){
        state.watch.push({a: r.owner, label: `rep-${r.hits}x`, by: 'agent', addedAt: now, reason: `Early on ${r.hits} runners, won ${r.wins}`}); added.push(r.owner);
      }
    }
    if(added.length) alert('watch', `Auto-watching ${added.length} wallet${added.length > 1 ? 's' : ''}`, added.map(short).join(', '),
      `➕ Auto-watching ${added.length} new wallet${added.length > 1 ? 's' : ''} from today's hunt: ${added.slice(0, 8).map(gmgn).join(' · ')}`, {wallets: added});
  }

  /* the filter: free_kill -> social_kill -> chain (scan + vet) -> verdict. The order is the whole point. */
  async function scanJob(){
    if(creditsLeft() < cfg.scan.creditBudgetPerRun){ note('Monthly credit budget nearly used; skipping discovery.'); return []; }
    const queued = await queuedItems(state.queue);
    const exclude = new Set([...state.coins.map(c => c.mint), ...state.queue, ...Object.keys(state.desk.killed || {})]);
    const seen = await candidates({exclude}, fetchImpl);
    const pipe = seen.map(c => ({c, free: freeKill(c, cfg.desk.hard, now)}));
    const alive = pipe.filter(p => p.free.pass).sort((a, b) => priority(b.c) - priority(a.c));
    deskEvent('scan', `${seen.length} coins on the tape, ${alive.length} survive free_kill`);
    const picks = [];
    for(const p of alive.slice(0, cfg.desk.socialChecksPerRun)){
      p.social = await social(p.c);
      p.socialKill = socialKill(p.social, cfg.desk.soft);
      if(!p.socialKill.pass){ state.desk.killed = {...(state.desk.killed || {}), [p.c.mint]: now}; }
      if(p.socialKill.pass && picks.length < cfg.scan.coinsPerRun){ p.chain = true; picks.push({...p.c, social: p.social}); }
    }
    note(`Discovery: ${seen.length} seen, ${alive.length} passed free_kill, scanning ${picks.map(f => '$' + f.symbol).join(', ') || 'none'}.`);
    const done = await scanCoins([...queued, ...picks]);
    const scannedNow = new Set(done.map(r => r.mint));
    state.desk.pipeline = {t: now, seen: seen.length, rows: pipe.sort((a, b) => (b.chain ? 3 : b.social ? 2 : b.free.pass ? 1 : 0) - (a.chain ? 3 : a.social ? 2 : a.free.pass ? 1 : 0) || priority(b.c) - priority(a.c)).slice(0, 14).map(p => ({
      mint: p.c.mint, symbol: p.c.symbol, mcap: p.c.mcap, vol24: p.c.vol24,
      free: p.free.pass ? 'PASS' : p.free.reason, social: p.social ? (p.socialKill.pass ? 'PASS' : p.socialKill.reason) : null,
      chain: p.chain ? (scannedNow.has(p.c.mint) ? 'SCANNED' : 'BUDGET') : null,
    }))};
    // forget social kills after 3 days so the list stays small
    for(const [m, t] of Object.entries(state.desk.killed || {})) if(now - t > 3 * DAY) delete state.desk.killed[m];
    return done;
  }
  async function queuedItems(mints){
    if(!mints.length) return [];
    const info = await pairInfo(mints, fetchImpl);
    return mints.map(m => ({mint: m, symbol: info[m]?.symbol || short(m), name: info[m]?.name, ...(info[m] || {})}));
  }

  /* ---------- daily recap ---------- */
  async function recapJob(){
    const since = now - DAY;
    const buys = state.buys.filter(b => b.t * 1000 >= since);
    const ctx = {
      watchedWallets: state.watch.length,
      buys: buys.sort((a, b) => b.sol - a.sol).slice(0, 25).map(b => ({wallet: labelOf(b.w), symbol: b.sym, sol: b.sol, mcapUsd: Math.round(b.mcap || 0)})),
      overlaps: Object.entries(state.overlaps).filter(([, o]) => o.t >= since).map(([mint, o]) => ({symbol: o.sym, wallets: o.count})),
      coins: state.coins.filter(c => !c.skipped && c.at >= since).map(c => {
        const read = c.buyers.filter(b => b.pos && b.pos.status !== 'unknown');
        const best = read.slice().sort((a, b) => b.pos.pnl - a.pos.pnl)[0];
        return {symbol: c.symbol, migrated: c.migrated, read: read.length, inProfit: read.filter(b => b.pos.pnl > 0.0005).length,
          bestEarlyWalletPnlSol: best ? round(best.pos.pnl, 2) : 0, stillHolding: read.filter(b => b.pos.held > 0).length};
      }),
      clusters: state.analysis.clusters.filter(c => c.verdict && c.verdict !== 'noise').slice(0, 5).map(c => ({verdict: c.verdict, confidence: c.confidence, size: c.size, coins: c.coins.length, symbols: c.coins.map(x => x.symbol), why: c.why})),
      verdicts: state.desk.verdicts.filter(v => v.t >= since).slice(0, 10).map(v => ({symbol: v.symbol, verdict: v.verdict, why: v.reasons, vet: v.vet, social: v.social})),
      topRepeaters: state.analysis.repeaters.slice(0, 5).map(r => ({wallet: short(r.owner), coins: r.hits, pnlSol: r.pnl, wins: r.wins})),
      creditsToday: state.credits.today + sol.credits,
    };
    const r = await writeRecap(ctx, {...brain, model: cfg.brain.recapModel});
    state.recaps = [{t: now, ...r}, ...state.recaps].slice(0, 14);
    alert('recap', r.headline, r.body, `📋 <b>${esc(r.headline)}</b>\n\n${esc(r.body)}`);
    note('Recap written.');
  }

  /* ---------- run ---------- */
  const jobs = [];
  const run = async (name, fn) => {
    try { await fn(); state.runs[name] = now; }
    catch(e){
      note(`${name} failed: ${e.message}`);
      const key = 'err_' + name;
      if(!state.runs[key] || now - state.runs[key] > 6 * 3600e3){ state.runs[key] = now; outbox.push(`⚠️ Agent ${name} job failed: ${esc(e.message)}`); }
    }
  };
  await run('commands', handleCommands);
  const wants = t => task === t || task === 'all';
  if(!state.paused){
    if(wants('watch')) jobs.push(['watch', watchWallets]);
    if(wants('scan')) jobs.push(['scan', async () => { const done = await scanJob(); await hunt(); judgeCoins(done); }]);
    else if(state.queue.length) jobs.push(['scan-queue', async () => { const done = await scanCoins(await queuedItems(state.queue.slice(0, 2))); if(done.length){ await hunt(); judgeCoins(done); } }]);
  }
  if(wants('recap') || state.forceRecap){ delete state.forceRecap; jobs.push(['recap', recapJob]); }
  for(const [name, fn] of jobs) await run(name, fn);

  if(replies.length) await tg.send(replies.join('\n\n'));
  if(outbox.length) await tg.send(outbox.join('\n\n'));

  state.rpc = {at: now, task, ...sol.stats};
  state.desk.thresholds = {hard: cfg.desk.hard, soft: cfg.desk.soft};
  state.desk.agents = deskAgents(state, sol.credits);
  state.credits.used += sol.credits; state.credits.today += sol.credits; state.credits.lastRun = sol.credits;
  state.updatedAt = Date.now();
  note(`Done · ${sol.credits.toLocaleString()} credits this run.`);
  await mkdir(dirname(statePath), {recursive: true});
  await writeFile(statePath, JSON.stringify(state));
  return state;
}

/* seed wallets from config the first time the agent runs */
export async function seed(statePath, cfgPath){
  const cfg = JSON.parse(await readFile(cfgPath || resolve(HERE, 'config.json'), 'utf8'));
  let state = freshState();
  try { state = merge(state, JSON.parse(await readFile(statePath, 'utf8'))); } catch {}
  for(const s of cfg.seedWatch || []) if(isAddr(s.a) && !state.watch.some(w => w.a === s.a)) state.watch.push({a: s.a, label: s.label || '', by: 'seed', addedAt: Date.now()});
  await mkdir(dirname(statePath), {recursive: true});
  await writeFile(statePath, JSON.stringify(state));
}

if(import.meta.url === pathToFileURL(process.argv[1] || '').href){
  const task = process.argv[2] || 'watch';
  if(!['watch', 'scan', 'recap', 'all'].includes(task)){ console.error('Usage: node agent/run.mjs watch|scan|recap|all'); process.exit(2); }
  const statePath = resolve(process.env.STATE_FILE || 'state/agent.json');
  await seed(statePath);
  await runAgent({task, statePath});
}
