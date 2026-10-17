// Offline end-to-end test: a fake Solana chain, DexScreener, Claude and Telegram.
// Run: node agent/test/run-tests.mjs
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {b58encode, bondingCurveOf} from '../lib/solana.mjs';
import {runAgent, seed} from '../run.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const rand = () => b58encode(globalThis.crypto.getRandomValues(new Uint8Array(32)).map((x, i) => i === 0 ? (x || 1) : x));
let sigN = 0; const newSig = () => 'sig' + (++sigN).toString().padStart(6, '0') + 'x'.repeat(40);

/* ---------- fake chain ---------- */
const sigsByAddr = new Map(), txs = new Map(), accounts = new Map(), tokAcct = new Map();
const acctOf = (o, m) => { const k = o + m; if(!tokAcct.has(k)) tokAcct.set(k, rand()); return tokAcct.get(k); };
const holdings = new Map(); // owner|mint -> amount
function addSig(addr, s){ const l = sigsByAddr.get(addr) || []; l.push(s); sigsByAddr.set(addr, l); }
function trade({owner, mint, bc, slot, t, solAmt, tokAmt}){ // tokAmt > 0 buy, < 0 sell
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
  for(const a of [owner, acct, bc].filter(Boolean)) addSig(a, s);
  return s;
}
const nowS = () => Math.floor(Date.now() / 1000);

async function makeCoin(sym, cabal, extraBuyers, launchAgo){
  const mint = rand().slice(0, 40) + 'pump';
  // make sure it's still a valid 32-byte address
  const m = (await import('../lib/solana.mjs')).isAddr(mint) ? mint : rand();
  const bc = await bondingCurveOf(m);
  const slot0 = 300000000 + Math.floor(Math.random() * 1e6), t0 = nowS() - launchAgo;
  const dev = rand();
  trade({owner: dev, mint: m, bc, slot: slot0, t: t0, solAmt: 1, tokAmt: 1e7});
  // cabal: all buy in the same slot 2 after launch, all sell within a minute
  cabal.forEach(w => trade({owner: w, mint: m, bc, slot: slot0 + 2, t: t0 + 1, solAmt: 2, tokAmt: 5e7}));
  extraBuyers.forEach((w, i) => trade({owner: w, mint: m, bc, slot: slot0 + 5 + i * 3, t: t0 + 3 + i * 2, solAmt: 0.5, tokAmt: 1e7}));
  cabal.forEach((w, i) => trade({owner: w, mint: m, bc, slot: slot0 + 900, t: t0 + 600 + i * 20, solAmt: 9, tokAmt: -5e7}));
  const data = Buffer.alloc(49); data.writeBigUInt64LE(800000000000000n, 8); data.writeBigUInt64LE(40000000000n, 16); data[48] = 0;
  accounts.set(bc, data.toString('base64'));
  return {mint: m, sym, bc, createdAt: (t0) * 1000};
}

const W1 = rand(), W2 = rand();
const cabal = [rand(), rand(), rand()];
const coins = [];
for(const [i, s] of ['ALPHA', 'BETA', 'GAMMA'].entries()) coins.push(await makeCoin(s, cabal, Array.from({length: 6}, rand), 3600 * (i + 2)));
coins.forEach(c => { c.symbol = c.sym; });

/* ---------- fake services ---------- */
const sent = [], claudeCalls = [];
let tgUpdates = [];
const json = (o, status = 200) => ({ok: status < 400, status, json: async () => o});
async function fakeFetch(url, opts = {}){
  url = String(url);
  if(url.startsWith('https://mainnet.helius-rpc.com')){
    const {method, params} = JSON.parse(opts.body);
    if(method === 'getSignaturesForAddress'){
      const [addr, o = {}] = params;
      let list = (sigsByAddr.get(addr) || []).slice().sort((a, b) => b.slot - a.slot || (a.signature < b.signature ? 1 : -1));
      if(o.before){ const i = list.findIndex(s => s.signature === o.before); list = list.slice(i + 1); }
      if(o.until){ const i = list.findIndex(s => s.signature === o.until); if(i >= 0) list = list.slice(0, i); }
      return json({result: list.slice(0, o.limit || 1000)});
    }
    if(method === 'getTransaction') return json({result: txs.get(params[0]) || null});
    if(method === 'getTokenSupply') return json({result: {value: {uiAmount: 1e9, decimals: 6}}});
    if(method === 'getAccountInfo'){ const d = accounts.get(params[0]); return json({result: d ? {value: {data: [d, 'base64']}} : {value: null}}); }
    if(method === 'getTokenAccountBalance') return json({result: {value: {uiAmount: 0}}});
    if(method === 'getAssetBatch') return json({result: params.ids.map(id => ({id, content: {metadata: {symbol: 'X', name: 'X'}}}))});
    return json({error: {message: 'unknown method ' + method}});
  }
  if(url.includes('api.dexscreener.com')){
    if(url.includes('token-boosts') || url.includes('token-profiles')) return json(coins.map(c => ({chainId: 'solana', tokenAddress: c.mint})));
    const mints = url.split('/').pop().split(',');
    const pairs = coins.filter(c => mints.includes(c.mint)).map(c => ({chainId: 'solana', dexId: 'pumpswap', baseToken: {address: c.mint, symbol: c.sym, name: c.sym},
      quoteToken: {address: 'So11111111111111111111111111111111111111112', symbol: 'SOL'}, priceUsd: '0.0005', priceNative: '0.0000025',
      marketCap: 500000, liquidity: {usd: 60000}, volume: {h24: 900000}, priceChange: {h24: 120}, pairCreatedAt: c.createdAt}));
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
    return json({content: [{type: 'tool_use', name: tool, input: {headline: 'Cabal ran ALPHA, BETA and GAMMA', body: 'Test recap body.'}}], usage: {}});
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
cfg.scan.coinsPerRun = 3;
await writeFile(cfgPath, JSON.stringify(cfg));
const env = {HELIUS_API_KEY: 'test', ANTHROPIC_API_KEY: 'sk-test', TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '42'};
const go = (task, e = env) => runAgent({task, env: e, fetchImpl: fakeFetch, statePath, configPath: cfgPath, gapMs: 0});

await seed(statePath, cfgPath);
// 1. first watch run only bookmarks each wallet
trade({owner: W1, mint: coins[0].mint, slot: 1, t: nowS() - 9000, solAmt: 1, tokAmt: 1e6});
let s = await go('watch');
assert.equal(s.watch.length, 2);
assert.ok(s.watch.every(w => 'lastSig' in w));
assert.equal(s.alerts.length, 0, 'no alerts on the first bookmark run');

// 2. both whales buy BETA -> two buy pings + overlap
trade({owner: W1, mint: coins[1].mint, slot: 400000000, t: nowS() - 60, solAmt: 3, tokAmt: 1e6});
trade({owner: W2, mint: coins[1].mint, slot: 400000001, t: nowS() - 30, solAmt: 1.5, tokAmt: 1e6});
sent.length = 0;
s = await go('watch');
assert.equal(s.alerts.filter(a => a.kind === 'buy').length, 2);
assert.equal(s.alerts.filter(a => a.kind === 'overlap').length, 1);
assert.match(sent.join('\n'), /Overlap: 2 watched wallets in \$BETA/);
// a third run with nothing new doesn't repeat alerts
const before = s.alerts.length; s = await go('watch'); assert.equal(s.alerts.length, before);

// 3. scan + cabal hunt with Claude judging
sent.length = 0;
s = await go('scan');
const scanned = s.coins.filter(c => !c.skipped);
assert.equal(scanned.length, 3, 'all three runners scanned: ' + JSON.stringify(s.log.slice(0, 8)));
assert.ok(scanned.every(c => c.buyers.length >= 9));
const top = s.analysis.clusters[0];
assert.ok(top, 'cluster found');
assert.deepEqual([...top.wallets].sort(), [...cabal].sort());
assert.equal(top.sameSlotCoins, 3); assert.equal(top.syncExitCoins, 3);
assert.equal(top.verdict, 'cabal'); assert.equal(top.confidence, 88);
assert.ok(s.analysis.repeaters.some(r => r.owner === cabal[0] && r.hits === 3));
assert.ok(cabal.every(a => s.watch.some(w => w.a === a && w.by === 'agent')), 'cabal auto-watched');
assert.match(sent.join('\n'), /CABAL/);
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

if(process.env.STATE_OUT) await writeFile(process.env.STATE_OUT, await readFile(statePath));
console.log(`All agent tests passed · state ${Math.round(size / 1024)} KB · ${claudeCalls.length} Claude calls · ${sent.length} Telegram messages in last run`);
