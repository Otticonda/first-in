// OCTO: reads pump.fun first. Reaches into the live coin feed with its tentacles, grabs the
// curve coins worth a closer look, and hands them to the desk. Uses pump.fun's public feed only,
// so it costs no Helius credits.

const API = 'https://frontend-api-v3.pump.fun';
const GRAD_SOL = 85;   // SOL in the curve at graduation

const HEADERS = {accept: 'application/json', origin: 'https://pump.fun', referer: 'https://pump.fun/', 'user-agent': 'Mozilla/5.0 (compatible; FirstInAgent/1.0)'};

function normalize(c){
  const socials = [];
  if(c.twitter) socials.push({type: 'twitter', url: c.twitter});
  if(c.telegram) socials.push({type: 'telegram', url: c.telegram});
  return {
    src: 'octo', mint: c.mint, symbol: String(c.symbol || '').trim(), name: String(c.name || '').trim(),
    mcap: Number(c.usd_market_cap) || 0, ath: Number(c.ath_market_cap) || 0,
    createdAt: Number(c.created_timestamp) || 0, lastTrade: Number(c.last_trade_timestamp) || 0,
    progress: Math.max(0, Math.min(1, (Number(c.real_sol_reserves) || 0) / 1e9 / GRAD_SOL)),
    replies: Number(c.reply_count) || 0, creator: c.creator || '', complete: !!c.complete,
    socials, websites: c.website ? [c.website] : [], liq: 0, vol24: 0,
  };
}

/* The live tape: coins with the most recent trades, a few pages deep. */
export async function crawlPump({fetchImpl = fetch, pages = 3, perPage = 50} = {}){
  const out = new Map(); let reqs = 0, ok = 0, error = '';
  for(let p = 0; p < pages; p++){
    reqs++;
    try {
      const r = await fetchImpl(`${API}/coins?offset=${p * perPage}&limit=${perPage}&sort=last_trade_timestamp&order=DESC&includeNsfw=false&complete=false`, {headers: HEADERS});
      if(!r.ok){ error = `pump.fun answered ${r.status}`; break; }
      const j = await r.json();
      const list = Array.isArray(j) ? j : (j?.coins || []);
      ok++;
      for(const c of list) if(c?.mint && !c.complete) out.set(c.mint, normalize(c));
      if(list.length < perPage) break;
    } catch(e){ error = 'pump.fun unreachable: ' + e.message; break; }
  }
  return {coins: [...out.values()], reqs, ok, error};
}

/* ---------- route 2: GeckoTerminal's pump.fun pools (free, keyless, ~10 calls/min) ---------- */
export async function crawlGecko({fetchImpl = fetch, pages = 2} = {}){
  const out = new Map(); let reqs = 0, ok = 0, error = '';
  for(let p = 1; p <= pages; p++){
    reqs++;
    try {
      const r = await fetchImpl(`https://api.geckoterminal.com/api/v2/networks/solana/dexes/pump-fun/pools?page=${p}&sort=h24_tx_count_desc`, {headers: {accept: 'application/json'}});
      if(!r.ok){ error = `GeckoTerminal answered ${r.status}`; break; }
      const j = await r.json(); ok++;
      for(const pool of j?.data || []){
        const at = pool.attributes || {};
        const mint = String(pool.relationships?.base_token?.data?.id || '').replace(/^solana_/, '');
        if(!mint) continue;
        out.set(mint, {
          src: 'octo', mint, symbol: String(at.name || '').split(' / ')[0].trim(), name: '',
          mcap: Number(at.market_cap_usd || at.fdv_usd) || 0, ath: 0,
          createdAt: Date.parse(at.pool_created_at) || 0, progress: null, replies: 0,
          buyers1h: at.transactions?.h1?.buyers || 0, creator: '', complete: false, socials: [], websites: [], liq: 0, vol24: Number(at.volume_usd?.h24) || 0,
        });
      }
    } catch(e){ error = 'GeckoTerminal unreachable: ' + e.message; break; }
  }
  return {coins: [...out.values()], reqs, ok, error};
}

/* ---------- route 3: pump.fun's own program activity, read through Helius (costs credits) ---------- */
export async function crawlChain(rpc, {sample = 60, PUMP} = {}){
  const sigs = (await rpc('getSignaturesForAddress', [PUMP, {limit: 1000}])).filter(s => !s.err);
  const step = Math.max(1, Math.floor(sigs.length / sample));
  const picked = sigs.filter((_, i) => i % step === 0).slice(0, sample);
  const seen = new Map();
  for(const s of picked){
    let tx; try { tx = await rpc('getTransaction', [s.signature, {encoding: 'jsonParsed', maxSupportedTransactionVersion: 255, commitment: 'confirmed'}]); } catch { continue; }
    for(const b of tx?.meta?.postTokenBalances || []){
      if(!b.mint || b.mint.startsWith('So111')) continue;
      const e = seen.get(b.mint) || {mint: b.mint, signers: new Set(), t: s.blockTime || 0};
      const signer = tx.transaction.message.accountKeys.find(k => k.signer)?.pubkey;
      if(signer) e.signers.add(signer);
      seen.set(b.mint, e);
    }
  }
  const coins = [...seen.values()].sort((a, b) => b.signers.size - a.signers.size).slice(0, 40).map(e => ({
    src: 'octo', mint: e.mint, symbol: '', name: '', mcap: 0, ath: 0, createdAt: 0, progress: null, replies: 0,
    buyers1h: e.signers.size, creator: '', complete: false, socials: [], websites: [], liq: 0, vol24: 0,
  }));
  return {coins, reqs: 1 + picked.length, ok: 1, error: ''};
}

/* Fill in curve progress, completion, creator and (when missing) market cap straight from the bonding curves. */
export async function readCurves(coins, rpc, {bondingCurveOf, solUsd = 0} = {}){
  const need = coins.filter(c => c.progress == null || !c.creator);
  for(let i = 0; i < need.length; i += 100){
    const chunk = need.slice(i, i + 100);
    const bcs = await Promise.all(chunk.map(c => bondingCurveOf(c.mint)));
    let res; try { res = (await rpc('getMultipleAccounts', [bcs, {encoding: 'base64'}]))?.value || []; } catch { continue; }
    chunk.forEach((c, k) => {
      const b64 = res[k]?.data?.[0]; if(!b64) { c.progress = c.progress ?? 0; return; }
      const u = Buffer.from(b64, 'base64'); if(u.length < 49) return;
      const vTok = Number(u.readBigUInt64LE(8)), vSol = Number(u.readBigUInt64LE(16)), realSol = Number(u.readBigUInt64LE(32));
      c.complete = u[48] === 1;
      c.progress = Math.max(0, Math.min(1, realSol / 1e9 / GRAD_SOL));
      if(u.length >= 81 && !c.creator) c.creator = bs58(u.subarray(49, 81));
      if(!c.mcap && vTok && solUsd) c.mcap = (vSol / 1e9) / (vTok / 1e6) * 1e9 * solUsd;
    });
  }
  return coins.filter(c => !c.complete);
}
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function bs58(b){ let n = 0n; for(const x of b) n = n * 256n + BigInt(x); let s = ''; while(n > 0n){ s = B58[Number(n % 58n)] + s; n /= 58n; } for(const x of b){ if(x === 0) s = '1' + s; else break; } return s; }

/* Hard rules: things that make a curve coin not worth a look, before any scoring. */
export function octoKill(c, th, now = Date.now()){
  const ageMin = c.createdAt ? (now - c.createdAt) / 60000 : null;
  const checks = [
    ['too_new', ageMin != null && ageMin < th.min_age_minutes],
    ['too_old', ageMin != null && ageMin > th.max_age_hours * 60],
    ['curve_too_early', c.progress < th.min_curve_progress],
    ['dumped_from_ath', c.ath > 0 && c.mcap / c.ath < th.min_mcap_vs_ath],
    ['too_small', c.mcap < th.min_mcap_usd],
  ];
  const hit = checks.find(([, bad]) => bad);
  return hit ? {pass: false, reason: hit[0]} : {pass: true};
}

/* 0..1, higher = more worth a closer look. Each part says why. */
export function octoScore(c, {creatorCoins = 0, now = Date.now()} = {}){
  const parts = {};
  // the curve: past the noise, not yet migrated
  parts.curve = c.progress < 0.2 ? c.progress : c.progress <= 0.95 ? 0.6 + 0.4 * Math.min(1, (c.progress - 0.2) / 0.5) : 0.7;
  // holding up near its high instead of bleeding out
  parts.holding = c.ath > 0 ? Math.max(0, Math.min(1, (c.mcap / c.ath - 0.5) / 0.5)) : 0.5;
  // people talking in the replies
  parts.crowd = c.replies ? Math.min(1, Math.log10(1 + c.replies) / 2) : Math.min(1, Math.log10(1 + (c.buyers1h || 0)) / 2);
  // a real X account (not a post or a community link) and somewhere else to find it
  const tw = c.socials.find(s => s.type === 'twitter')?.url || '';
  const account = /(?:x|twitter)\.com\/(?!i\/)[A-Za-z0-9_]{1,15}\/?(?:\?|$)/.test(tw);
  parts.socials = (account ? 0.6 : tw ? 0.25 : 0) + (c.websites.length ? 0.25 : 0) + (c.socials.some(s => s.type === 'telegram') ? 0.15 : 0);
  // fresh but not seconds old
  const ageH = c.createdAt ? (now - c.createdAt) / 3600e3 : null;
  parts.age = ageH == null ? 0.6 : ageH < 0.15 ? 0.3 : ageH <= 6 ? 1 : Math.max(0.2, 1 - (ageH - 6) / 18);
  let score = 0.35 * parts.curve + 0.2 * parts.holding + 0.15 * parts.crowd + 0.15 * parts.socials + 0.15 * parts.age;
  const serial = creatorCoins >= 3;
  if(serial) score *= 0.6;
  const why = [`${Math.round(c.progress * 100)}% to grad`, c.replies ? `${c.replies} replies` : `${c.buyers1h || 0} buyers/1h`];
  if(c.ath) why.push(`${Math.round(c.mcap / c.ath * 100)}% of ATH`);
  why.push(account ? 'X account' : tw ? 'X post/community' : 'no X');
  if(serial) why.push(`creator launched ${creatorCoins} coins`);
  return {score: Math.round(score * 100) / 100, parts, why: why.join(' · '), serial};
}
