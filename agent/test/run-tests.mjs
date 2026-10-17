// Offline end-to-end test: a fake Solana chain, DexScreener, Claude and Telegram.
// Run: node agent/test/run-tests.mjs
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {b58encode, bondingCurveOf} from '../lib/solana.mjs';
import {runAgent, seed} from '../run.mjs';
import {vetChain} from '../lib/vet.mjs';
import {chiefVerdict, DEFAULT_THRESHOLDS} from '../lib/desk.mjs';

// a bundled launch: 6 of 10 first buyers bought inside two transactions
{
  const buyers = Array.from({length: 10}, (_, i) => ({owner: 'w' + i, slotDelta: i < 6 ? 0 : 4, sig: i < 3 ? 'A' : i < 6 ? 'B' : 's' + i, pos: {held: 0, pnl: 1, status: 'sold'}}));
  const v = await vetChain({mint: 'm', supply: 0, buyers}, async () => ({value: []}));
  assert.equal(v.facts.bundledShare, 0.6);
  assert.equal(chiefVerdict({vet: v, read: 10}, DEFAULT_THRESHOLDS.soft).verdict, 'BUNDLED');
}

const HERE = dirname(fileURLToPath(import.meta.url));
const rand = () => b58encode(globalThis.crypto.getRandomValues(new Uint8Array(32)).map((x, i) => i === 0 ? (x || 1) : x));
let sigN = 0; const newSig = () => 'sig' + (++sigN).toString().padStart(6, '0') + 'x'.repeat(40);

/* ---------- fake chain ---------- */
let pumpBlocked = false, geckoBlocked = false, geckoFeed = [];
const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const curveData = new Map(); // bonding curve -> {vTok, vSol, realSol}
const sigsByAddr = new Map(), txs = new Map(), accounts = new Map(), tokAcct = new Map();
const acctOwner = new Map();
const acctOf = (o, m) => { const k = o + m; if(!tokAcct.has(k)){ const a = rand(); tokAcct.set(k, a); acctOwner.set(a, {owner: o, mint: m}); } return tokAcct.get(k); };
const holdings = new Map(); // owner|mint -> amount
function addSig(addr, s){ const l = sigsByAddr.get(addr) || []; l.push(s); sigsByAddr.set(addr, l); }
function trade({owner, mint, bc, slot, t, solAmt, tokAmt, curveIndexed = true}){ // tokAmt > 0 buy, < 0 sell
  const acct = acctOf(owner, mint), k = owner + '|' + mint;
  const pre = holdings.get(k) || 0, post = pre + tokAmt; holdings.set(k, post);
  const lam = Math.round(solAmt * 1e9);
  const tx = {slot, blockTime: t, meta: {err: null,
      preBalances: [10e9, 0, 50e9], postBalances: [10e9 - (tokAmt > 0 ? lam : -lam), 0, 50e9 + (tokAmt > 0 ? lam : -lam)],
      preTokenBalances: [{accountIndex: 1, mint, owner, uiTokenAmount: {uiAmount: pre}}],
      postTokenBalances: [{accountIndex: 1, mint, owner, uiTokenAmount: {uiAmount: post}}]},
    transaction: {message: {accountKeys: [{pubkey: owner, signer: true}, {pubkey: acct, signer: false}, {pubkey: bc || rand(), signer: false}]}}};
  const s = {signature: newSig(), slot, blockTime: t, err: null};
  txs.set(s.signature, tx);
  // the mint is always in a trade's accounts; newer pump coins may not leave a trace on the curve account
  for(const a of [owner, acct, mint, curveIndexed ? bc : null].filter(Boolean)) addSig(a, s);
  return s;
}
const nowS = () => Math.floor(Date.now() / 1000);

async function makeCoin(sym, cabal, extraBuyers, launchAgo, {curveLight = false} = {}){
  const mint = rand().slice(0, 40) + 'pump';
  // make sure it's still a valid 32-byte address
  const m = (await import('../lib/solana.mjs')).isAddr(mint) ? mint : rand();
  const bc = await bondingCurveOf(m);
  const slot0 = 300000000 + Math.floor(Math.random() * 1e6), t0 = nowS() - launchAgo;
  const dev = rand();
  trade({owner: dev, mint: m, bc, slot: slot0, t: t0, solAmt: 1, tokAmt: 1e7});
  // cabal: all buy in the same slot 2 after launch, all sell within a minute
  const ci = !curveLight;
  cabal.forEach(w => trade({owner: w, mint: m, bc, slot: slot0 + 2, t: t0 + 1, solAmt: 2, tokAmt: 5e7, curveIndexed: ci}));
  extraBuyers.forEach((w, i) => trade({owner: w, mint: m, bc, slot: slot0 + 5 + i * 3, t: t0 + 3 + i * 2, solAmt: 0.5, tokAmt: 1e7, curveIndexed: ci}));
  cabal.forEach((w, i) => trade({owner: w, mint: m, bc, slot: slot0 + 900, t: t0 + 600 + i * 20, solAmt: 9, tokAmt: -5e7, curveIndexed: ci}));
  const data = Buffer.alloc(49); data.writeBigUInt64LE(800000000000000n, 8); data.writeBigUInt64LE(40000000000n, 16); data[48] = 0;
  accounts.set(bc, data.toString('base64'));
  return {mint: m, sym, bc, dev, createdAt: (t0) * 1000};
}

const W1 = rand(), W2 = rand();
const cabal = [rand(), rand(), rand()];
const coins = [];
// GAMMA is a newer-style pump coin: its trades never touch the curve account, so the scanner must fall back to the mint
for(const [i, s] of ['ALPHA', 'BETA', 'GAMMA'].entries()) coins.push(await makeCoin(s, cabal, Array.from({length: 6}, rand), 3600 * (i + 2), {curveLight: s === 'GAMMA'}));
coins.forEach((c, i) => { c.symbol = c.sym; c.handle = c.sym.toLowerCase() + 'coin'; c.vol = 900000 - i * 1000; c.liqUsd = 60000; });
// DELTA reuses ALPHA's X handle (recycled account), TINY has no liquidity: both must die before any credits are spent
const delta = await makeCoin('DELTA', [], Array.from({length: 3}, rand), 3600 * 3); Object.assign(delta, {symbol: 'DELTA', handle: 'alphacoin', vol: 500000, liqUsd: 60000});
const tiny = await makeCoin('TINY', [], Array.from({length: 3}, rand), 3600 * 3); Object.assign(tiny, {symbol: 'TINY', handle: 'tinycoin', vol: 800000, liqUsd: 900});
const listed = [...coins, delta, tiny];
// OCTA lives only on pump.fun's curve (not on DexScreener): Octo has to find it
const octa = await makeCoin('OCTA', [], Array.from({length: 8}, rand), 3600); Object.assign(octa, {symbol: 'OCTA', handle: 'octacoin'});
// OCTB is only reachable through the backup routes
const octb = await makeCoin('OCTB', [], Array.from({length: 8}, rand), 1800); Object.assign(octb, {symbol: 'OCTB', handle: 'octbcoin'});
curveData.set(octb.bc, {vTok: 600e12, vSol: 66e9, realSol: 40e9});
Object.assign(octb, {vol: 90000, liqUsd: 0});
const curveOnly = [octb];  // DexScreener knows it (socials, age) but isn't promoting it
const pumpFeed = [
  {mint: octa.mint, symbol: 'OCTA', name: 'Octa', usd_market_cap: 30000, ath_market_cap: 35000, created_timestamp: Date.now() - 3600e3, real_sol_reserves: 51e9, reply_count: 40, twitter: 'https://x.com/octacoin', website: 'https://octa.fun', creator: rand(), complete: false},
  {mint: rand(), symbol: 'SPAM', name: 'Spam', usd_market_cap: 4000, ath_market_cap: 9000, created_timestamp: Date.now() - 600e3, real_sol_reserves: 2e9, reply_count: 0, creator: rand(), complete: false},
];

/* ---------- fake services ---------- */
const PAGE_CAP = 4;

const sent = [], claudeCalls = [];
let tgUpdates = [];
const json = (o, status = 200) => ({ok: status < 400, status, json: async () => o});
async function fakeFetch(url, opts = {}){
  url = String(url);
  if(url.startsWith('https://mainnet.helius-rpc.com')){
    const {method, params} = JSON.parse(opts.body);
    if(method === 'getSignaturesForAddress' && params[0] === PUMP_PROGRAM){
      return json({result: (sigsByAddr.get(octb.mint) || []).slice().reverse()});
    }
    if(method === 'getSignaturesForAddress'){
      const [addr, o = {}] = params;
      let list = (sigsByAddr.get(addr) || []).slice().sort((a, b) => b.slot - a.slot || (a.signature < b.signature ? 1 : -1));
      if(o.before){ const i = list.findIndex(s => s.signature === o.before); list = list.slice(i + 1); }
      if(o.until){ const i = list.findIndex(s => s.signature === o.until); if(i >= 0) list = list.slice(0, i); }
      // real Helius can return short pages; simulate it so the scanner must keep paging
      return json({result: list.slice(0, Math.min(o.limit || 1000, PAGE_CAP))});
    }
    if(method === 'getTransaction') return json({result: txs.get(params[0]) || null});
    if(method === 'getTokenSupply') return json({result: {value: {uiAmount: 1e9, decimals: 6}}});
    if(method === 'getAccountInfo'){ const d = accounts.get(params[0]); return json({result: d ? {value: {data: [d, 'base64']}} : {value: null}}); }
    if(method === 'getTokenAccountBalance') return json({result: {value: {uiAmount: 0}}});
    if(method === 'getTokenAccountsByOwner'){
      const [owner, {mint}] = params; const amount = holdings.get(owner + '|' + mint) || 0;
      return json({result: {value: amount ? [{account: {data: {parsed: {info: {tokenAmount: {uiAmount: amount}}}}}}] : []}});
    }
    if(method === 'getTokenLargestAccounts'){
      const mint = params[0];
      const list = [...holdings].filter(([k, v]) => k.endsWith('|' + mint) && v > 0).map(([k, v]) => ({address: acctOf(k.split('|')[0], mint), uiAmount: v}));
      return json({result: {value: list.sort((a, b) => b.uiAmount - a.uiAmount).slice(0, 20)}});
    }
    if(method === 'getMultipleAccounts' && params[1]?.encoding === 'base64') return json({result: {value: params[0].map(a => {
      const c = curveData.get(a); if(!c) return null;
      const u = Buffer.alloc(81); u.writeBigUInt64LE(BigInt(c.vTok), 8); u.writeBigUInt64LE(BigInt(c.vSol), 16); u.writeBigUInt64LE(BigInt(c.realSol), 32); u[48] = 0;
      return {data: [u.toString('base64'), 'base64']};
    })}});
    if(method === 'getMultipleAccounts') return json({result: {value: params[0].map(a => ({data: {parsed: {info: {owner: acctOwner.get(a)?.owner}}}}))}});
    if(method === 'getAssetBatch') return json({result: params.ids.map(id => ({id, content: {metadata: {symbol: 'X', name: 'X'}}}))});
    return json({error: {message: 'unknown method ' + method}});
  }
  if(url.includes('api.dexscreener.com')){
    if(url.includes('token-boosts') || url.includes('token-profiles')) return json(listed.map(c => ({chainId: 'solana', tokenAddress: c.mint})));
    const mints = url.split('/').pop().split(',');
    const pairs = [...listed, ...curveOnly].filter(c => mints.includes(c.mint)).map(c => ({chainId: 'solana', dexId: 'pumpswap', baseToken: {address: c.mint, symbol: c.sym, name: c.sym},
      quoteToken: {address: 'So11111111111111111111111111111111111111112', symbol: 'SOL'}, priceUsd: '0.0005', priceNative: '0.0000025',
      marketCap: 500000, liquidity: {usd: c.liqUsd}, volume: {h24: c.vol}, priceChange: {h24: 120}, txns: {h24: {buys: 900, sells: 400}}, pairCreatedAt: c.createdAt,
      info: {socials: [{type: 'twitter', url: `https://x.com/${c.handle}`}], websites: []}}));
    if(url.includes('/latest/dex/tokens/')) pairs.push({chainId: 'solana', baseToken: {address: 'So11111111111111111111111111111111111111112'}, quoteToken: {symbol: 'USDC'}, priceUsd: '200', liquidity: {usd: 1e8}});
    return json(url.includes('/tokens/v1/') ? pairs : {pairs});
  }
  if(url.startsWith('https://api.anthropic.com')){
    const body = JSON.parse(opts.body); claudeCalls.push(body);
    assert.equal(opts.headers['anthropic-version'], '2023-06-01');
    const tool = body.tools[0].name;
    if(tool === 'report_verdicts'){
      const ids = [...body.messages[0].content.matchAll(/"id":"(c[0-9a-z]+)"/g)].map(m => m[1]);
      return json({content: [{type: 'tool_use', name: tool, input: {verdicts: ids.map(id => ({id, verdict: 'cabal', confidence: 88, why: 'Same-block buys and synced exits on every coin.', alert: 'Same 3 wallets aped the launch block and dumped together'}))}}], usage: {}});
    }
    if(tool === 'thesis'){
      const coin = JSON.parse(body.messages[0].content);
      return json({content: [{type: 'tool_use', name: tool, input: {headline: `$${coin.coin}: Claude's take`, why: coin.draft.why.length ? coin.draft.why : ['passed every kill'], risks: coin.draft.risks, wrong: coin.draft.wrong}}], usage: {}});
    }
    return json({content: [{type: 'tool_use', name: tool, input: {headline: 'Cabal ran ALPHA, BETA and GAMMA', body: 'Test recap body.'}}], usage: {}});
  }
  if(url.startsWith('https://api.geckoterminal.com/')){
    if(geckoBlocked) return json({}, 429);
    return json({data: url.includes('page=1') ? geckoFeed : []});
  }
  if(url.startsWith('https://frontend-api-v3.pump.fun/coins')){
    if(pumpBlocked) return json({}, 403);
    assert.equal(opts.headers?.origin, 'https://pump.fun');
    return json(url.includes('offset=0&') ? pumpFeed : []);
  }
  if(url.startsWith('https://api.fxtwitter.com/')){
    const h = url.split('/').pop();
    return json({code: 200, user: {screen_name: h, followers: 4200, tweets: 85, description: 'the official ' + h, joined: new Date(Date.now() - 3 * 86400e3).toUTCString()}});
  }
  if(url.startsWith('https://api.telegram.org')){
    const method = url.split('/').pop(), body = JSON.parse(opts.body);
    if(method === 'sendMessage'){ sent.push(body.text); return json({ok: true}); }
    if(method === 'getUpdates'){ const r = tgUpdates.filter(u => u.update_id >= body.offset); tgUpdates = []; return json({ok: true, result: r}); }
  }
  throw new Error('unexpected fetch ' + url);
}

/* ---------- run ---------- */
const dir = await mkdtemp(join(tmpdir(), 'firstin-'));
const statePath = join(dir, 'agent.json');
const cfgPath = join(dir, 'config.json');
const cfg = JSON.parse(await readFile(join(HERE, '..', 'config.json'), 'utf8'));
cfg.seedWatch = [{a: W1, label: 'whale1'}, {a: W2, label: 'whale2'}];
cfg.scan.coinsPerRun = 4;
await writeFile(cfgPath, JSON.stringify(cfg));
const env = {HELIUS_API_KEY: 'test', ANTHROPIC_API_KEY: 'sk-test', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42'};
const go = (task, e = env) => runAgent({task, env: e, fetchImpl: fakeFetch, statePath, configPath: cfgPath, gapMs: 0});

await seed(statePath, cfgPath);
// 1. first watch run only bookmarks each wallet
trade({owner: W1, mint: rand(), slot: 1, t: nowS() - 9000, solAmt: 1, tokAmt: 1e6});
let s = await go('watch');
assert.equal(s.watch.length, 2);
assert.ok(s.watch.every(w => 'lastSig' in w));
assert.equal(s.alerts.filter(a => ['buy', 'overlap'].includes(a.kind)).length, 0, 'no wallet alerts on the first bookmark run');
// the sweep ran on the same wake-up: every runner got a quick pass and the best clean ones are picks with a thesis
assert.ok(s.desk.radar.swept >= 4, 'sweep covers all runners: ' + JSON.stringify(s.desk.radar));
const pk = s.desk.picks[0];
assert.ok(pk && pk.thesis.why.length && pk.thesis.wrong.length && pk.thesis.headline.startsWith('$'), JSON.stringify(s.desk.picks));
assert.ok(s.alerts.some(a => a.kind === 'pick'));
assert.match(sent.join('\n'), /CHIEF'S PICK/);
assert.match(sent.join('\n'), /never takes a position/);
assert.equal(s.alerts.filter(a => a.kind === 'octo').length, 1, 'Octo pings its strong grab once');

// 2. both whales buy BETA -> two buy pings + overlap
trade({owner: W1, mint: coins[1].mint, slot: 400000000, t: nowS() - 60, solAmt: 3, tokAmt: 1e6});
trade({owner: W2, mint: coins[1].mint, slot: 400000001, t: nowS() - 30, solAmt: 1.5, tokAmt: 1e6});
sent.length = 0;
s = await go('watch');
assert.equal(s.alerts.filter(a => a.kind === 'buy').length, 2);
assert.equal(s.alerts.filter(a => a.kind === 'overlap').length, 1);
assert.match(sent.join('\n'), /Overlap: 2 watched wallets in \$BETA/);
// a third run with nothing new doesn't repeat alerts
const before = s.alerts.length; s = await go('watch'); assert.equal(s.alerts.length, before, 'picks are not re-pinged within 6h: ' + JSON.stringify(s.alerts.slice(0, 3).map(a => a.title)));

// 3. scan + cabal hunt with Claude judging
sent.length = 0;
s = await go('scan');
const scanned = s.coins.filter(c => !c.skipped);
assert.equal(scanned.length, 4, 'three runners plus Octo\'s grab scanned: ' + JSON.stringify(s.log.slice(0, 8)));
assert.ok(scanned.every(c => c.buyers.length >= 9), scanned.map(c => c.symbol + ' ' + c.buyers.length + ' ' + JSON.stringify(c.diag)).join('\n'));
assert.equal(scanned.find(c => c.symbol === 'GAMMA').diag.addr, 'mint', 'thin curve history falls back to the mint');
const top = s.analysis.clusters[0];
assert.ok(top, 'cluster found');
assert.deepEqual([...top.wallets].sort(), [...cabal].sort());
assert.equal(top.sameSlotCoins, 3); assert.equal(top.syncExitCoins, 3);
assert.equal(top.verdict, 'cabal'); assert.equal(top.confidence, 88);
assert.ok(s.analysis.repeaters.some(r => r.owner === cabal[0] && r.hits === 3));
assert.ok(cabal.every(a => s.watch.some(w => w.a === a && w.by === 'agent')), 'cabal auto-watched');
assert.match(sent.join('\n'), /CABAL/);
// the desk: free_kill -> social_kill -> chain -> verdict
const rows = s.desk.pipeline.rows;
assert.equal(rows.find(r => r.symbol === 'TINY').free, 'thin_liquidity');
assert.ok(s.desk.killed[delta.mint], 'DELTA killed on its recycled X handle');
assert.ok(!s.desk.radar.coins.some(r => r.symbol === 'DELTA'), 'a social kill keeps it off the radar');
// Octo found the curve-only coin, scored it, pinged it, and the desk scanned it
const octaRow = rows.find(r => r.symbol === 'OCTA');
assert.equal(octaRow?.src, 'octo'); assert.ok(octaRow.chain);
assert.ok(s.octo.grabs.some(g => g.symbol === 'OCTA' && g.score > 0.72), JSON.stringify(s.octo.grabs));
assert.ok(!s.octo.grabs.some(g => g.symbol === 'SPAM'));
assert.ok(s.alerts.some(a => a.kind === 'octo' && /OCTA/.test(a.title)));
assert.ok(s.desk.agents.octo.stats.touched >= 2);
const va = scanned.find(c => c.symbol === 'ALPHA').desk;
assert.ok(va.vet.facts.devPct > 0 && va.vet.facts.devPct < 0.05, 'dev bag read: ' + JSON.stringify(va.vet.facts));
assert.equal(va.social.handle, 'alphacoin');
assert.match(va.social.line, /4\.2K followers/);
assert.ok(s.desk.verdicts.length === 4 && s.desk.verdicts.filter(v => v.verdict === 'CABAL RUN').length === 3, 'cabal found this run must flag its coins: ' + JSON.stringify(s.desk.verdicts));
assert.ok(s.desk.radar.coins.filter(r => r.verdict === 'CABAL RUN' && r.deep).length === 3, 'deep scan updates the radar: ' + JSON.stringify(s.desk.radar.coins.map(r => [r.symbol, r.verdict])));
// picks the deep scan proved wrong are withdrawn, and say so
const withdrawn = s.desk.picks.filter(p => p.status === 'withdrawn');
assert.ok(withdrawn.every(p => p.withdrawnFor === 'CABAL RUN') && withdrawn.length >= 1, JSON.stringify(s.desk.picks.map(p => [p.symbol, p.status])));
assert.match(sent.join('\n'), /Chief withdraws/);
assert.ok(['chief', 'scan', 'vet', 'social', 'hunt', 'watch'].every(a => s.desk.agents[a]), 'agent cards');
assert.ok(s.desk.events.some(e => e.agent === 'social') && s.desk.events.some(e => e.agent === 'vet'));
assert.match(sent.join('\n'), /🧑‍⚖️/);
const cabalProfit = scanned[0].buyers.find(b => b.owner === cabal[0]).pos;
assert.equal(cabalProfit.status, 'sold'); assert.ok(Math.abs(cabalProfit.pnl - 7) < 1e-6, 'pnl 9 - 2 = 7 SOL, got ' + cabalProfit.pnl);
const judgeCalls = claudeCalls.length;

// re-running scan doesn't re-judge or re-alert the same cluster
s = await go('scan');
assert.equal(claudeCalls.length, judgeCalls, 'no new Claude call for an already-judged cluster');
assert.equal(s.alerts.filter(a => a.kind === 'cluster').length, 1);

// 4. Telegram commands
const NEW = rand();
tgUpdates = [
  {update_id: 10, message: {chat: {id: 42}, text: `/watch ${NEW} sniper king`}},
  {update_id: 11, message: {chat: {id: 999}, text: `/watch ${rand()} stranger`}},
  {update_id: 12, message: {chat: {id: 42}, text: '/status'}},
  {update_id: 13, message: {chat: {id: 42}, text: '/recap'}},
];
sent.length = 0;
s = await go('watch');
assert.ok(s.watch.some(w => w.a === NEW && w.label === 'sniper king'));
assert.ok(!s.watch.some(w => w.label === 'stranger'), 'ignores other chats');
assert.equal(s.tgOffset, 14);
assert.match(sent.join('\n'), /Status/);
assert.equal(s.recaps.length, 1);
assert.equal(s.recaps[0].headline, 'Cabal ran ALPHA, BETA and GAMMA');

// 5. no Claude key -> rules still work
s = await go('recap', {...env, ANTHROPIC_API_KEY: ''});
assert.equal(s.recaps[0].by, 'rules');
assert.match(s.recaps[0].body, /buys from watched wallets/);

// 6. state stays small enough for a quick page load
const size = (await readFile(statePath)).length;
assert.ok(size < 400000, 'state is ' + size + ' bytes');

// 7. pump.fun blocks us: Octo comes in through GeckoTerminal, reads the curve from chain, still grabs
pumpBlocked = true;
geckoFeed = [{id: 'solana_x', attributes: {name: 'OCTB / SOL', market_cap_usd: '41000', pool_created_at: new Date(Date.now() - 1800e3).toISOString(), transactions: {h1: {buyers: 120}}, volume_usd: {h24: '90000'}}, relationships: {base_token: {data: {id: 'solana_' + octb.mint}}}}];
s = await go('watch');
assert.equal(s.octo.route, 'GeckoTerminal', s.octo.error);
const gb = s.octo.grabs.find(g => g.symbol === 'OCTB');
assert.ok(gb && Math.abs(gb.progress - 40 / 85) < 0.01, 'curve progress read from chain: ' + JSON.stringify(s.octo.grabs));
// 8. GeckoTerminal is down too: Octo reads pump.fun's program activity on chain
geckoBlocked = true;
s = await go('watch');
assert.equal(s.octo.route, 'chain', s.octo.error);
assert.ok(s.octo.grabs.some(g => g.mint === octb.mint), 'chain route finds the live coin: ' + JSON.stringify(s.octo));
// and the hourly limit on the paid route holds
s = await go('watch');
assert.equal(s.octo.ok, false); assert.match(s.octo.error, /403/);

if(process.env.STATE_OUT) await writeFile(process.env.STATE_OUT, await readFile(statePath));
console.log(`All agent tests passed · state ${Math.round(size / 1024)} KB · ${claudeCalls.length} Claude calls · ${sent.length} Telegram messages in last run`);
