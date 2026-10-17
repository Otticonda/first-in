// Solana reading for the agent. Ported from index.html so the agent and the
// site read launches, buys and positions exactly the same way.

const sleep = ms => new Promise(r => setTimeout(r, ms));
export const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';

/* ---------- base58 + PDA ---------- */
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function b58decode(s){ let n=0n; for(const c of s){ const i=B58.indexOf(c); if(i<0) throw new Error('bad'); n=n*58n+BigInt(i);} const out=[]; while(n>0n){ out.push(Number(n%256n)); n/=256n; } for(const c of s){ if(c==='1') out.push(0); else break; } return new Uint8Array(out.reverse()); }
export function b58encode(b){ let n=0n; for(const x of b) n=n*256n+BigInt(x); let s=''; while(n>0n){ s=B58[Number(n%58n)]+s; n/=58n; } for(const x of b){ if(x===0) s='1'+s; else break; } return s; }
const P = 2n**255n - 19n; const mod = a => ((a%P)+P)%P;
function pw(b,e){ let r=1n; b=mod(b); while(e>0n){ if(e&1n) r=r*b%P; b=b*b%P; e>>=1n; } return r; }
const D = mod(-121665n * pw(121666n, P-2n));
function onCurve(by){ let y=0n; for(let i=31;i>=0;i--) y=(y<<8n)|BigInt(by[i]); y=mod(y&((1n<<255n)-1n)); const y2=y*y%P; const u=mod(y2-1n), v=mod(D*y2+1n); if(v===0n) return false; const x2=u*pw(v,P-2n)%P; if(x2===0n) return true; return pw(x2,(P-1n)/2n)===1n; }
export async function findPda(seeds, program){
  const pid = b58decode(program), tail = new TextEncoder().encode('ProgramDerivedAddress');
  for(let bump=255; bump>=0; bump--){
    const parts=[...seeds, new Uint8Array([bump]), pid, tail];
    const buf=new Uint8Array(parts.reduce((a,p)=>a+p.length,0)); let o=0; for(const p of parts){ buf.set(p,o); o+=p.length; }
    const h=new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', buf));
    if(!onCurve(h)) return b58encode(h);
  }
  throw new Error('no PDA');
}
export const isWalletKey = a => { try { return onCurve(b58decode(a)); } catch { return false; } };
export function isAddr(s){ try { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58decode(s).length===32; } catch { return false; } }
export const bondingCurveOf = mint => findPda([new TextEncoder().encode('bonding-curve'), b58decode(mint)], PUMP);

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
export const WSOL = 'So11111111111111111111111111111111111111112';
export const STABLES = ['EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v','Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'];
export const SKIP_MINTS = new Set([WSOL, ...STABLES]);

export class BudgetError extends Error { constructor(){ super('Credit budget for this run is used up'); this.name = 'BudgetError'; } }
const passThrough = e => e instanceof BudgetError;

/* ---------- parsing (pure) ---------- */
export function keysOf(tx){ return tx.transaction.message.accountKeys.map(k => typeof k === 'string' ? {pubkey:k, signer:false} : k); }
const ui = b => Number(b?.uiTokenAmount?.uiAmount || 0);
export function deltas(tx, filterOwner){
  const d = new Map();
  const add = (b, sign) => { if(filterOwner && b.owner !== filterOwner) return; const k = b.owner+'|'+b.mint; d.set(k, (d.get(k)||0) + sign*ui(b)); };
  (tx.meta.preTokenBalances||[]).forEach(b => add(b,-1));
  (tx.meta.postTokenBalances||[]).forEach(b => add(b, 1));
  return d;
}
/* SOL the owner gained in a tx: native lamports + wrapped SOL + stablecoins converted at the SOL price. */
export function solChange(tx, owner, keys, d, solUsd){
  const i = keys.findIndex(x => x.pubkey === owner);
  let v = i >= 0 ? (tx.meta.postBalances[i] - tx.meta.preBalances[i]) / 1e9 : 0;
  v += d.get(owner+'|'+WSOL) || 0;
  if(solUsd) for(const s of STABLES){ const x = d.get(owner+'|'+s); if(x) v += x / solUsd; }
  return v;
}
export function curveIn(tx, keys, bc){
  const bi = keys.findIndex(x => x.pubkey === bc);
  return bi >= 0 ? (tx.meta.postBalances[bi] - tx.meta.preBalances[bi]) / 1e9 : 0;
}
export function buysIn(tx, mint){
  if(!tx || !tx.meta || tx.meta.err) return [];
  const keys = keysOf(tx), signers = new Set(keys.filter(k=>k.signer).map(k=>k.pubkey));
  const pre = tx.meta.preTokenBalances || [];
  const by = new Map();
  for(const b of tx.meta.postTokenBalances || []){
    if(b.mint !== mint || !signers.has(b.owner)) continue;
    const dd = ui(b) - ui(pre.find(x => x.accountIndex === b.accountIndex));
    if(dd <= 0) continue;
    const e = by.get(b.owner) || {owner: b.owner, amount: 0, acct: keys[b.accountIndex]?.pubkey};
    e.amount += dd; by.set(b.owner, e);
  }
  return [...by.values()];
}
export function walletBuys(tx, wallet, solUsd){
  if(!tx || !tx.meta || tx.meta.err) return [];
  const keys = keysOf(tx);
  const i = keys.findIndex(x => x.pubkey === wallet);
  if(i < 0 || !keys[i].signer) return [];
  const d = deltas(tx, wallet);
  const spent = -solChange(tx, wallet, keys, d, solUsd);
  const out = [];
  for(const [k, v] of d){ const m = k.split('|')[1]; if(v > 0 && !SKIP_MINTS.has(m)) out.push({mint:m, amount:v, sol: spent}); }
  return out;
}

/* ---------- RPC client ---------- */
export function createSolana({rpcUrl, fetchImpl = fetch, gapMs = 115, log = () => {}}){
  if(!rpcUrl) throw new Error('No Helius RPC configured (set the HELIUS_API_KEY secret).');
  let credits = 0, creditLimit = Infinity, lastCall = 0, gate = Promise.resolve(), solUsd = 0;
  const txCache = new Map();
  const stats = {calls: {}, errors: {}, retries: 0, nullTx: 0};
  const bad = msg => { msg = String(msg).slice(0, 120); stats.errors[msg] = (stats.errors[msg] || 0) + 1; };

  function slot(){ const p = gate.then(async () => { const w = lastCall + gapMs - Date.now(); if(w>0) await sleep(w); lastCall = Date.now(); }); gate = p; return p; }
  async function rpc(method, params, cost=1){
    if(credits + cost > creditLimit) throw new BudgetError();
    stats.calls[method] = (stats.calls[method] || 0) + 1;
    for(let attempt=0; attempt<6; attempt++){
      await slot();
      let res;
      try { res = await fetchImpl(rpcUrl, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({jsonrpc:'2.0', id:1, method, params})}); }
      catch(e){ bad(`${method}: network ${e.message}`); if(attempt<5){ await sleep(600*2**attempt); continue; } throw new Error('Could not reach the RPC: ' + e.message); }
      if(res.status===401 || res.status===403){ bad(`${method}: HTTP ${res.status}`); throw new Error(`The RPC rejected the key (HTTP ${res.status}).`); }
      if(res.status===429 || res.status>=500){ stats.retries++; bad(`${method}: HTTP ${res.status}`); await sleep(900*2**attempt); continue; }
      let j; try { j = await res.json(); } catch { bad(`${method}: unreadable`); throw new Error('The RPC sent back something unreadable.'); }
      credits += cost;
      if(j.error){
        bad(`${method}: ${j.error.code} ${j.error.message}`);
        if(j.error.code===-32429 || /rate|too many/i.test(j.error.message||'')){ stats.retries++; await sleep(900*2**attempt); continue; }
        throw new Error(j.error.message || 'RPC error');
      }
      return j.result;
    }
    throw new Error('The RPC kept rate-limiting.');
  }
  async function pool(items, conc, fn){
    const out = new Array(items.length); let i = 0;
    await Promise.all(Array.from({length: Math.min(conc, items.length)}, async () => { while(i < items.length){ const k = i++; try { out[k] = await fn(items[k], k); } catch(e){ if(passThrough(e)) throw e; out[k] = null; } } }));
    return out;
  }
  async function getTx(sig){
    if(txCache.has(sig)) return txCache.get(sig);
    const tx = await rpc('getTransaction', [sig, {encoding:'jsonParsed', maxSupportedTransactionVersion:0, commitment:'confirmed'}]);
    if(tx){ if(txCache.size > 4000) txCache.clear(); txCache.set(sig, tx); } else stats.nullTx++;
    return tx;
  }
  async function names(mints){
    const m = {};
    if(!mints.length) return m;
    try {
      for(let i=0;i<mints.length;i+=100){
        const r = await rpc('getAssetBatch', {ids: mints.slice(i,i+100)}, 10);
        for(const a of r||[]) if(a?.id) m[a.id] = {name: a.content?.metadata?.name || '', symbol: a.content?.metadata?.symbol || ''};
      }
    } catch(e){ if(passThrough(e)) throw e; }
    return m;
  }
  async function dexPrices(mints){
    const prices = {}; let su = 0, solLiq = 0;
    const all = [...new Set([...mints, WSOL])];
    for(let i=0; i<all.length; i+=30){
      try {
        const r = await fetchImpl('https://api.dexscreener.com/latest/dex/tokens/' + all.slice(i,i+30).join(','));
        if(!r.ok) continue;
        const j = await r.json();
        for(const p of j.pairs || []){
          if(p.chainId !== 'solana') continue;
          const base = p.baseToken?.address, liq = p.liquidity?.usd || 0;
          if(base === WSOL){ if(/USD/i.test(p.quoteToken?.symbol||'') && liq > solLiq){ su = Number(p.priceUsd) || su; solLiq = liq; } continue; }
          if(!mints.includes(base)) continue;
          const cur = prices[base];
          if(!cur || liq > cur.liq) prices[base] = {liq, priceUsd: Number(p.priceUsd)||0, priceSol: p.quoteToken?.address === WSOL ? Number(p.priceNative)||0 : 0};
        }
      } catch {}
    }
    if(!su) for(const v of Object.values(prices)) if(v.priceSol && v.priceUsd){ su = v.priceUsd / v.priceSol; break; }
    for(const v of Object.values(prices)) if(!v.priceSol && su && v.priceUsd) v.priceSol = v.priceUsd / su;
    if(su) solUsd = su;
    return prices;
  }
  async function curvePrice(bc, decimals){
    try {
      const r = await rpc('getAccountInfo', [bc, {encoding:'base64'}]);
      const b64 = r?.value?.data?.[0]; if(!b64) return null;
      const u = new Uint8Array(Buffer.from(b64, 'base64'));
      if(u.length < 49) return null;
      const dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
      const vTok = Number(dv.getBigUint64(8, true)), vSol = Number(dv.getBigUint64(16, true)), complete = u[48] === 1;
      if(complete || !vTok) return {complete: true};
      return {complete: false, priceSol: (vSol/1e9) / (vTok/10**decimals)};
    } catch(e){ if(passThrough(e)) throw e; return null; }
  }
  async function oldestSigs(address, maxPages){
    // Page backwards until the RPC returns nothing. A short page is NOT the end:
    // Helius can return fewer than `limit` while older history still exists.
    let before, buf = [], pages = 0, total = 0; const sizes = [];
    while(pages < maxPages){
      const opts = {limit:1000}; if(before) opts.before = before;
      const r = await rpc('getSignaturesForAddress', [address, opts]);
      pages++; if(sizes.length < 8) sizes.push(r.length);
      if(!r.length) return {sigs: buf.slice().reverse(), total, complete: true, sizes, pages};
      total += r.length;
      buf = buf.length + r.length > 2000 ? [...buf, ...r].slice(-2000) : [...buf, ...r];
      before = r[r.length-1].signature;
    }
    return {sigs: [], total, complete: false, sizes, pages};
  }
  async function positionFor(owner, acct, mint, c){
    // up to 100 signatures, paging in case the RPC returns short pages
    const all = []; let before;
    for(let p = 0; p < 6 && all.length < 100; p++){
      const opts = {limit: 100 - all.length}; if(before) opts.before = before;
      const r = await rpc('getSignaturesForAddress', [acct, opts]);
      if(!r.length) break;
      all.push(...r); before = r[r.length-1].signature;
    }
    const sigs = all.filter(s => !s.err);
    const txs = await pool(sigs, 6, s => getTx(s.signature));
    let cost = 0, bought = 0, curveCost = 0, curveTok = 0, proceeds = 0, sold = 0, moved = 0, received = 0, buys = 0, sells = 0, lastSell = 0;
    for(let k=0; k<txs.length; k++){
      const tx = txs[k];
      if(!tx || !tx.meta || tx.meta.err) continue;
      const keys = keysOf(tx), d = deltas(tx, owner);
      const tok = d.get(owner+'|'+mint) || 0;
      if(!tok) continue;
      const sc = solChange(tx, owner, keys, d, solUsd);
      const me = keys.find(x => x.pubkey === owner);
      if(tok > 0){
        if(me?.signer && sc < -0.00001){
          bought += tok; cost += -sc; buys++;
          const ci = c.bc ? curveIn(tx, keys, c.bc) : 0;
          if(ci > 0){ curveCost += ci; curveTok += tok; }
        } else received += tok;
      } else {
        if(sc > 0.0005){ sold += -tok; proceeds += sc; sells++; lastSell = Math.max(lastSell, sigs[k].blockTime || 0); }
        else moved += -tok;
      }
    }
    const partial = all.length >= 100;
    let held = Math.max(0, bought + received - sold - moved);
    if(partial){ try { held = ui({uiTokenAmount: (await rpc('getTokenAccountBalance', [acct])).value}); } catch(e){ if(passThrough(e)) throw e; held = 0; } }
    const value = held * (c.priceSol || 0);
    const total = bought + received;
    const entryPrice = curveTok > 0 ? curveCost / curveTok : (bought > 0 ? cost / bought : 0);
    const sellPrice = sold > 0 ? proceeds / sold : 0;
    let status;
    if(total <= 0) status = 'unknown';
    else if(held <= total * 0.01) status = moved > sold ? 'moved' : 'sold';
    else if(sold > 0 || moved > 0) status = moved > sold ? 'moved-part' : 'partial';
    else status = 'diamond';
    return {cost, bought, proceeds, sold, moved, received, held, value, pnl: proceeds + value - cost,
      entryPrice, sellPrice, buys, sells, status, partial, priced: !!c.priceSol, lastSell};
  }
  /* First N buyers of a coin and every one of their positions. Same output shape the site stores. */
  async function scanCoin(mint, N, {meta, maxPagesPump = 600, maxPagesOther = 250} = {}){
    const sym = meta?.symbol || short(mint);
    const bc = await bondingCurveOf(mint);
    const probe = await rpc('getSignaturesForAddress', [bc, {limit:1}]);
    const viaPump = probe.length > 0;
    const addr = viaPump ? bc : mint;
    const {sigs, total, complete, sizes, pages} = await oldestSigs(addr, viaPump ? maxPagesPump : maxPagesOther);
    const diag = {addr: viaPump ? 'curve' : 'mint', pageSizes: sizes, pages, total, errSigs: sigs.filter(s => s.err).length, txRead: 0, txNull: 0, txNoBuy: 0};
    if(!complete) return {mint, symbol: sym, name: meta?.name||'', skipped: `too many transactions (${total.toLocaleString()}+) to reach launch`, at: Date.now(), diag};
    const okSigs = sigs.filter(s => !s.err);
    diag.okSigs = okSigs.length;
    if(!okSigs.length) return {mint, symbol: sym, name: meta?.name||'', skipped: 'no successful transactions found', at: Date.now(), diag};
    let supply = 0, decimals = 6;
    try { const s = (await rpc('getTokenSupply', [mint])).value; supply = Number(s.uiAmount) || 0; decimals = s.decimals ?? 6; } catch(e){ if(passThrough(e)) throw e; }
    const createSlot = okSigs[0].slot, createTime = okSigs[0].blockTime;
    const buyers = []; const seen = new Set(); let dev = null;
    const cap = Math.min(okSigs.length, N*5);
    for(let i=0; i<cap && buyers.length < N; i+=6){
      const batch = okSigs.slice(i, Math.min(i+6, cap));
      const txs = await pool(batch, 6, s => getTx(s.signature));
      txs.forEach((tx, j) => {
        if(!tx){ diag.txNull++; return; }
        diag.txRead++;
        if(i===0 && j===0) dev = keysOf(tx)[0]?.pubkey || null;
        const bs = buysIn(tx, mint);
        if(!bs.length){ diag.txNoBuy++; if(!diag.sampleNoBuy) diag.sampleNoBuy = batch[j].signature; }
        const ci = viaPump && bs.length === 1 ? curveIn(tx, keysOf(tx), bc) : 0;
        for(const b of bs){
          if(seen.has(b.owner) || b.owner === bc) continue;
          seen.add(b.owner);
          buyers.push({owner:b.owner, amount:b.amount, acct:b.acct, firstPrice: ci > 0 ? ci / b.amount : 0, rank: buyers.length+1,
            slotDelta: batch[j].slot - createSlot, secs: Math.max(0, (batch[j].blockTime||0) - (createTime||0)), sig: batch[j].signature, t: batch[j].blockTime});
        }
      });
    }
    const list = buyers.slice(0, N);
    let priceSol = 0, migrated = !viaPump;
    if(viaPump){ const cp = await curvePrice(bc, decimals); if(cp && !cp.complete) priceSol = cp.priceSol; else migrated = true; }
    if(!priceSol){ const p = await dexPrices([mint]); priceSol = p[mint]?.priceSol || 0; }
    else if(!solUsd) await dexPrices([]);
    const ctx = {bc: viaPump ? bc : null, priceSol};
    await pool(list, 2, async b => {
      try { b.pos = await positionFor(b.owner, b.acct, mint, ctx); } catch(e){ if(passThrough(e)) throw e; b.pos = null; }
    });
    log(`${sym}: ${list.length} early wallets read`);
    return {mint, symbol: sym, name: meta?.name || '', viaPump, migrated, dev, createSlot, createTime, supply, decimals, priceSol, buyers: list, at: Date.now(), diag};
  }

  return {
    rpc, pool, getTx, names, stats, dexPrices, curvePrice, scanCoin, positionFor,
    walletBuys: (tx, w) => walletBuys(tx, w, solUsd),
    get credits(){ return credits; },
    get solUsd(){ return solUsd; },
    setSolUsd(v){ if(v) solUsd = v; },
    /* allow `n` more credits from now on */
    budget(n){ creditLimit = n == null ? Infinity : credits + n; },
  };
}
