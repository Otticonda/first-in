// SOCIAL: checks the project's X account.
// Uses the official X API when X_BEARER_TOKEN is set (paid per lookup), otherwise the free
// public FxTwitter API. If neither answers, it still judges what DexScreener lists.

const DAY = 86400e3;

/* What kind of X link the project listed: a profile, a community, a single post, or nothing. */
export function parseX(socials = []){
  const s = socials.find(x => /twitter|^x$/i.test(x.type) || /(?:^|\/\/)(?:www\.)?(?:x|twitter)\.com\//i.test(x.url));
  if(!s) return {kind: 'none'};
  let u; try { u = new URL(s.url); } catch { return {kind: 'none'}; }
  const parts = u.pathname.split('/').filter(Boolean);
  if(parts[0] === 'i' && parts[1] === 'communities') return {kind: 'community', url: s.url};
  const handle = (parts[0] || '').replace(/^@/, '');
  if(!/^[A-Za-z0-9_]{1,15}$/.test(handle) || ['home', 'search', 'intent', 'share', 'i'].includes(handle.toLowerCase())) return {kind: 'none'};
  return {kind: parts[1] === 'status' ? 'post' : 'profile', handle, url: s.url};
}

async function viaXApi(handle, token, fetchImpl){
  const r = await fetchImpl(`https://api.x.com/2/users/by/username/${handle}?user.fields=created_at,public_metrics,description,verified`, {headers: {authorization: `Bearer ${token}`}});
  if(!r.ok) return null;
  const j = await r.json(); const d = j?.data;
  if(!d) return null;
  return {created: Date.parse(d.created_at) || 0, followers: d.public_metrics?.followers_count ?? null, tweets: d.public_metrics?.tweet_count ?? null, bio: d.description || '', source: 'x'};
}
async function viaFx(handle, fetchImpl){
  const r = await fetchImpl(`https://api.fxtwitter.com/${handle}`);
  if(!r.ok) return null;
  const j = await r.json(); const u = j?.user;
  if(!u) return null;
  return {created: Date.parse(u.joined) || 0, followers: u.followers ?? null, tweets: u.tweets ?? null, bio: u.description || '', source: 'fx'};
}

/*
 * Returns {kind, handle, account, flags: {name: 0..1}, score, line}.
 * score is the worst flag: higher = more suspicious.
 * seenHandles: Map handle -> Set of mints from earlier coins (a handle reused across coins is the strongest sign).
 */
export async function checkSocial(coin, {token, fetchImpl = fetch, seenHandles = new Map(), now = Date.now()} = {}){
  const x = parseX(coin.socials);
  const flags = {};
  let account = null;
  const sym = (coin.symbol || '').toLowerCase().replace(/[^a-z0-9]/g, '');

  if(x.kind === 'none') flags.no_socials = coin.websites?.length ? 0.6 : 0.8;
  if(x.kind === 'community') flags.community_only = 0.3;
  if(x.kind === 'post') flags.post_not_account = 0.35;

  if(x.handle){
    const h = x.handle.toLowerCase();
    const other = [...(seenHandles.get(h) || [])].filter(m => m !== coin.mint);
    if(other.length) flags.recycled_account = 1;
    try { account = token ? await viaXApi(x.handle, token, fetchImpl) : null; } catch {}
    if(!account) try { account = await viaFx(x.handle, fetchImpl); } catch {}
    if(account){
      const launched = coin.createdAt || now;
      const ageBefore = (launched - account.created) / DAY;       // days the account existed before the coin
      const handleMatches = sym.length >= 3 && (h.includes(sym) || (account.bio || '').toLowerCase().includes(sym));
      if(account.created && ageBefore > 30){
        // an old account wearing a new coin's name is the classic recycled account
        flags.recycled_account = Math.max(flags.recycled_account || 0, Math.min(0.9, 0.45 + ageBefore / 1000 + (handleMatches ? 0.15 : 0) + ((account.tweets || 0) > 2000 ? 0.15 : 0)));
      } else if(account.created) flags.recycled_account = Math.max(flags.recycled_account || 0, 0.1);
      if(account.followers != null && account.followers < 150) flags.ghost_account = 0.5;
      if(!handleMatches) flags.account_not_the_project = 0.4;
    } else if(x.kind === 'profile') flags.account_unreadable = 0.2;
  }

  const [worstName, worst] = Object.entries(flags).sort((a, b) => b[1] - a[1])[0] || ['clean', 0];
  const bits = [];
  if(x.handle) bits.push('@' + x.handle);
  else if(x.kind === 'community') bits.push('X community only');
  else bits.push('no X listed');
  if(account){
    if(account.created) bits.push(`${Math.max(0, Math.round((now - account.created) / DAY))}d old`);
    if(account.followers != null) bits.push(`${fmtK(account.followers)} followers`);
  }
  if(flags.recycled_account === 1) bits.push('handle used on another coin');
  return {kind: x.kind, handle: x.handle || '', url: x.url || '', account, flags, worst: worstName, score: round2(worst), line: bits.join(' · ')};
}

const fmtK = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
const round2 = v => Math.round(v * 100) / 100;
