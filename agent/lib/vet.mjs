// VET: is it real? Reads the chain for the things that usually end a memecoin early.
// Every flag is 0..1, higher = worse. Uses the early-buyer scan plus three cheap RPC reads.

import {isWalletKey} from './solana.mjs';

const amt = a => Number(a?.uiAmount ?? a?.tokenAmount?.uiAmount ?? 0);
const r2 = v => Math.round(v * 100) / 100;

export async function vetChain(coin, rpc, {cabalWallets = new Set()} = {}){
  const flags = {}, facts = {};
  const supply = coin.supply || 0;
  const buyers = coin.buyers || [];

  // dev still holding a bag
  if(coin.dev && supply){
    try {
      const r = await rpc('getTokenAccountsByOwner', [coin.dev, {mint: coin.mint}, {encoding: 'jsonParsed'}]);
      const held = (r?.value || []).reduce((s, a) => s + amt(a.account?.data?.parsed?.info?.tokenAmount), 0);
      facts.devPct = held / supply;
      flags.dev_still_loaded = r2(Math.min(1, facts.devPct / 0.05));   // 5% of supply = maxed out
    } catch {}
  }

  // top 10 real wallets (pools, curves and lockers are program accounts, so they're skipped)
  if(supply){
    try {
      const top = (await rpc('getTokenLargestAccounts', [coin.mint]))?.value || [];
      const infos = top.length ? (await rpc('getMultipleAccounts', [top.map(t => t.address), {encoding: 'jsonParsed'}]))?.value || [] : [];
      const owners = new Map();
      top.forEach((t, i) => {
        const owner = infos[i]?.data?.parsed?.info?.owner;
        if(!owner || !isWalletKey(owner)) return;
        owners.set(owner, (owners.get(owner) || 0) + amt(t));
      });
      const ranked = [...owners.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      facts.top10Pct = ranked.reduce((s, [, v]) => s + v, 0) / supply;
      facts.topWalletPct = ranked[0] ? ranked[0][1] / supply : 0;
      flags.top10_concentration = r2(Math.min(1, facts.top10Pct / 0.5));  // half the supply in 10 wallets = maxed
    } catch {}
  }

  // early buyers: snipers, still-loaded, cabal
  if(buyers.length){
    // bundled launch: several wallets buying inside the same transaction
    const perTx = new Map(); for(const b of buyers) if(b.sig) perTx.set(b.sig, (perTx.get(b.sig) || 0) + 1);
    const bundled = buyers.filter(b => b.sig && perTx.get(b.sig) >= 3).length;
    facts.bundledShare = bundled / buyers.length;
    if(bundled) flags.bundled_launch = r2(Math.min(1, facts.bundledShare / 0.4));
    const snipers = buyers.filter(b => b.slotDelta <= 1).length;
    facts.sniperShare = snipers / buyers.length;
    flags.sniped_launch = r2(Math.min(1, facts.sniperShare / 0.5));
    const holding = buyers.filter(b => (b.pos?.held || 0) > 0);
    facts.earlyHoldingPct = supply ? holding.reduce((s, b) => s + (b.pos.held || 0), 0) / supply : 0;
    flags.early_bags_loaded = r2(Math.min(1, facts.earlyHoldingPct / 0.25));
    facts.cabalWallets = buyers.filter(b => cabalWallets.has(b.owner)).length;
    if(facts.cabalWallets) flags.cabal_in_early = r2(Math.min(1, facts.cabalWallets / 4));
    const read = buyers.filter(b => b.pos && b.pos.status !== 'unknown');
    facts.earlyInProfit = read.filter(b => b.pos.pnl > 0.0005).length;
    facts.earlyRead = read.length;
  }

  const [worst, score] = Object.entries(flags).sort((a, b) => b[1] - a[1])[0] || ['clean', 0];
  const bits = [];
  if(facts.devPct != null) bits.push(`dev ${(facts.devPct * 100).toFixed(1)}%`);
  if(facts.top10Pct != null) bits.push(`top10 ${Math.round(facts.top10Pct * 100)}%`);
  if(facts.sniperShare != null) bits.push(`snipers ${Math.round(facts.sniperShare * 100)}%`);
  if(facts.bundledShare) bits.push(`bundled ${Math.round(facts.bundledShare * 100)}%`);
  if(facts.cabalWallets) bits.push(`${facts.cabalWallets} cabal wallets early`);
  return {flags, facts, worst, score: r2(score), line: bits.join(' · ')};
}
