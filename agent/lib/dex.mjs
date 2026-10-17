// DexScreener: market info for alerts, and discovery of fresh runners to scan.
// Free API, no key. Boost/profile endpoints allow ~60 req/min, token lookups ~300 req/min.

const API = 'https://api.dexscreener.com';

async function getJson(fetchImpl, url){
  try { const r = await fetchImpl(url); if(!r.ok) return null; return await r.json(); } catch { return null; }
}

/* Best (most liquid) Solana pair per mint: {mint, symbol, name, mcap, liq, priceUsd, vol24, change24, createdAt, url} */
export async function pairInfo(mints, fetchImpl = fetch){
  const out = {};
  const list = [...new Set(mints)];
  for(let i = 0; i < list.length; i += 30){
    const j = await getJson(fetchImpl, `${API}/tokens/v1/solana/${list.slice(i, i + 30).join(',')}`);
    const pairs = Array.isArray(j) ? j : (j?.pairs || []);
    for(const p of pairs){
      if(p.chainId !== 'solana') continue;
      const mint = p.baseToken?.address;
      if(!list.includes(mint)) continue;
      const liq = p.liquidity?.usd || 0;
      if(out[mint] && out[mint].liq >= liq) continue;
      out[mint] = {
        mint, symbol: p.baseToken?.symbol || '', name: p.baseToken?.name || '',
        mcap: p.marketCap || p.fdv || 0, liq, priceUsd: Number(p.priceUsd) || 0,
        vol24: p.volume?.h24 || 0, change24: p.priceChange?.h24 || 0,
        createdAt: p.pairCreatedAt || 0, dex: p.dexId || '', url: p.url || `https://dexscreener.com/solana/${mint}`
      };
    }
  }
  return out;
}

/* Fresh Solana coins that are actually running, best first. */
export async function discover({minMcapUsd = 250000, maxAgeHours = 72, minLiquidityUsd = 15000, exclude = new Set(), limit = 10} = {}, fetchImpl = fetch){
  const feeds = await Promise.all([
    getJson(fetchImpl, `${API}/token-boosts/top/v1`),
    getJson(fetchImpl, `${API}/token-boosts/latest/v1`),
    getJson(fetchImpl, `${API}/token-profiles/latest/v1`),
  ]);
  const mints = new Set();
  for(const feed of feeds) for(const t of (Array.isArray(feed) ? feed : [])){
    if(t?.chainId === 'solana' && t.tokenAddress && !exclude.has(t.tokenAddress)) mints.add(t.tokenAddress);
  }
  if(!mints.size) return [];
  const info = await pairInfo([...mints], fetchImpl);
  const now = Date.now();
  return Object.values(info)
    .filter(c => c.mcap >= minMcapUsd && c.liq >= minLiquidityUsd && c.createdAt && (now - c.createdAt) <= maxAgeHours * 3600e3)
    // pump.fun coins scan far cheaper, so they go first among similar runners
    .map(c => ({...c, score: Math.log10(1 + c.vol24) + (c.mint.endsWith('pump') ? 0.5 : 0)}))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
