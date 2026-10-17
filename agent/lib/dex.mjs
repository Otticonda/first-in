// DexScreener: market info for alerts, and discovery of fresh runners to scan.
// Free API, no key. Boost/profile endpoints allow ~60 req/min, token lookups ~300 req/min.

const API = 'https://api.dexscreener.com';

async function getJson(fetchImpl, url){
  try { const r = await fetchImpl(url); if(!r.ok) return null; return await r.json(); } catch { return null; }
}

/* Best (most liquid) Solana pair per mint, with the socials the project listed. */
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
        vol24: p.volume?.h24 || 0, change24: p.priceChange?.h24 || 0, change1h: p.priceChange?.h1 || 0,
        buys24: p.txns?.h24?.buys || 0, sells24: p.txns?.h24?.sells || 0,
        createdAt: p.pairCreatedAt || 0, dex: p.dexId || '', pair: p.pairAddress || '',
        socials: (p.info?.socials || []).map(s => ({type: s.type || '', url: s.url || ''})),
        websites: (p.info?.websites || []).map(w => w.url).filter(Boolean),
        url: p.url || `https://dexscreener.com/solana/${mint}`
      };
    }
  }
  return out;
}

/* Fresh Solana coins people are pushing right now (boosts + new profiles), with market data. Unfiltered. */
export async function candidates({exclude = new Set(), max = 60} = {}, fetchImpl = fetch){
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
  const info = await pairInfo([...mints].slice(0, max), fetchImpl);
  return Object.values(info);
}
