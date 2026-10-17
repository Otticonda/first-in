// Cabal hunting: rule-based pattern finding across every coin the agent has scanned.
// The rules find candidates and measure them; Claude only judges the strongest ones.

const hash = s => { let h = 0x811c9dc5; for(let i = 0; i < s.length; i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
export const clusterId = wallets => 'c' + hash([...wallets].sort().join(','));

const buySlot = (c, b) => (c.createSlot || 0) + (b.slotDelta || 0);

/* Wallets that sit early on most coins and buy in the launch block are bots, not a cabal. */
function findBots(appear, nCoins, botCoinShare){
  const bots = new Set();
  const need = Math.max(4, Math.ceil(botCoinShare * nCoins));
  for(const [owner, hits] of appear){
    if(hits.length < need) continue;
    const snipes = hits.filter(h => h.b.slotDelta <= 1).length;
    if(snipes / hits.length >= 0.6) bots.add(owner);
  }
  return bots;
}

export function analyze(coins, {minSharedCoins = 2, botCoinShare = 0.4, syncExitSeconds = 180} = {}){
  const scanned = coins.filter(c => !c.skipped && c.buyers?.length);
  const appear = new Map();
  for(const c of scanned) for(const b of c.buyers){
    const a = appear.get(b.owner) || []; a.push({c, b}); appear.set(b.owner, a);
  }
  const bots = findBots(appear, scanned.length, botCoinShare);

  /* repeat early wallets */
  const repeaters = [...appear].filter(([o, hits]) => hits.length >= 2 && !bots.has(o)).map(([owner, hits]) => {
    const sum = f => hits.reduce((s, h) => s + (f(h) || 0), 0);
    return {
      owner, hits: hits.length,
      coins: hits.map(h => ({mint: h.c.mint, symbol: h.c.symbol, rank: h.b.rank, secs: h.b.secs, pnl: round(h.b.pos?.pnl), status: h.b.pos?.status || 'unknown'})),
      pnl: round(sum(h => h.b.pos?.pnl)), cost: round(sum(h => h.b.pos?.cost)),
      wins: hits.filter(h => (h.b.pos?.pnl || 0) > 0.0005).length,
      snipes: hits.filter(h => h.b.slotDelta <= 1).length,
      dev: hits.some(h => h.b.owner === h.c.dev),
      holding: hits.filter(h => (h.b.pos?.held || 0) > 0).length,
      avgRank: round(sum(h => h.b.rank) / hits.length, 1),
    };
  }).sort((a, b) => b.hits - a.hits || b.pnl - a.pnl);

  /* wallets that keep showing up early together */
  const pairs = new Map();
  for(const c of scanned){
    const owners = [...new Set(c.buyers.map(b => b.owner))].filter(o => !bots.has(o));
    for(let i = 0; i < owners.length; i++) for(let j = i + 1; j < owners.length; j++){
      const k = owners[i] < owners[j] ? owners[i] + '|' + owners[j] : owners[j] + '|' + owners[i];
      const s = pairs.get(k) || new Set(); s.add(c.mint); pairs.set(k, s);
    }
  }
  const parent = new Map();
  const find = x => { while(parent.get(x) !== x){ parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const unite = (a, b) => { for(const x of [a, b]) if(!parent.has(x)) parent.set(x, x); const ra = find(a), rb = find(b); if(ra !== rb) parent.set(ra, rb); };
  for(const [k, mints] of pairs) if(mints.size >= minSharedCoins){ const [a, b] = k.split('|'); unite(a, b); }
  const groups = new Map();
  for(const x of parent.keys()){ const r = find(x); const g = groups.get(r) || []; g.push(x); groups.set(r, g); }

  const clusters = [...groups.values()].filter(g => g.length >= 2).map(wallets => {
    const set = new Set(wallets);
    const coinHits = [];
    for(const c of scanned){
      const inC = c.buyers.filter(b => set.has(b.owner));
      if(inC.length < 2) continue;
      const slots = new Map(); for(const b of inC){ const s = buySlot(c, b); slots.set(s, (slots.get(s) || 0) + 1); }
      const sameSlot = Math.max(...slots.values());
      const sells = inC.map(b => b.pos?.lastSell || 0).filter(Boolean).sort((a, b) => a - b);
      let syncExit = 0;
      for(let i = 0; i < sells.length; i++){ let n = 1; for(let j = i + 1; j < sells.length && sells[j] - sells[i] <= syncExitSeconds; j++) n++; syncExit = Math.max(syncExit, n); }
      coinHits.push({
        mint: c.mint, symbol: c.symbol, wallets: inC.length,
        sameSlot: sameSlot >= 2 ? sameSlot : 0, syncExit: syncExit >= 2 ? syncExit : 0,
        dev: inC.some(b => b.owner === c.dev),
        avgSecs: round(inC.reduce((s, b) => s + b.secs, 0) / inC.length, 1),
        pnl: round(inC.reduce((s, b) => s + (b.pos?.pnl || 0), 0)),
        stillHolding: inC.filter(b => (b.pos?.held || 0) > 0).length,
      });
    }
    const sameSlotCoins = coinHits.filter(h => h.sameSlot).length;
    const syncExitCoins = coinHits.filter(h => h.syncExit).length;
    const devLinked = coinHits.some(h => h.dev);
    const score = 2 * coinHits.length + 3 * sameSlotCoins + 2 * syncExitCoins + (devLinked ? 4 : 0) + (wallets.length >= 3 ? 2 : 0) + (wallets.length >= 5 ? 1 : 0);
    return {
      id: clusterId(wallets), wallets: wallets.sort(), size: wallets.length,
      coins: coinHits, sameSlotCoins, syncExitCoins, devLinked, score,
      pnl: round(coinHits.reduce((s, h) => s + h.pnl, 0)),
      avgSecs: coinHits.length ? round(coinHits.reduce((s, h) => s + h.avgSecs, 0) / coinHits.length, 1) : 0,
    };
  }).filter(c => c.coins.length >= minSharedCoins).sort((a, b) => b.score - a.score);

  return {coinsAnalyzed: scanned.length, bots: [...bots], repeaters, clusters};
}

/* Link a fresh cluster to the closest one judged before, so verdicts carry over and alerts don't repeat. */
export function matchPrevious(cluster, previous){
  let best = null, bestJ = 0;
  const a = new Set(cluster.wallets);
  for(const p of previous){
    const inter = p.wallets.filter(w => a.has(w)).length;
    const j = inter / (a.size + p.wallets.length - inter);
    if(j > bestJ){ best = p; bestJ = j; }
  }
  return bestJ >= 0.5 ? best : null;
}

export function round(v, d = 3){ const f = 10 ** d; return Math.round((v || 0) * f) / f; }
