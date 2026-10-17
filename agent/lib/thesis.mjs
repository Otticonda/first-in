// The Chief's thesis: why a coin is on the desk, what could kill it, and what would prove it wrong.
// Built from the desk's own numbers. First In never buys; a thesis is a reason to watch, not a trade.

const pct = v => `${Math.round(v * 100)}%`;
const usd = v => { const a = Math.abs(v || 0); return a >= 1e6 ? '$' + (a / 1e6).toFixed(1) + 'M' : a >= 1e3 ? '$' + Math.round(a / 1e3) + 'K' : '$' + Math.round(a); };
const clamp = v => Math.max(0, Math.min(1, v));

/* How hard it's moving right now, 0..1. DexScreener numbers for runners, Octo's score for curve coins. */
export function momentum(c){
  if(c.src === 'octo' && c.score != null && !c.buys24) return {value: c.score, facts: octoFacts(c)};
  const trades = (c.buys24 || 0) + (c.sells24 || 0);
  const pressure = trades ? c.buys24 / trades : 0.5;
  const turnover = c.mcap ? c.vol24 / c.mcap : 0;
  const value = 0.4 * clamp((pressure - 0.45) / 0.25) + 0.35 * clamp(((c.change1h || 0) + 10) / 40) + 0.25 * clamp(turnover / 3);
  const facts = [], against = [];
  if(c.change24) (c.change24 > 0 ? facts : against).push(`${c.change24 > 0 ? '+' : ''}${Math.round(c.change24)}% in 24h on ${usd(c.vol24)} volume`);
  if(c.change1h) (c.change1h > 0 ? facts : against).push(`${c.change1h > 0 ? '+' : ''}${Math.round(c.change1h)}% in the last hour`);
  if(trades) (pressure >= 0.5 ? facts : against).push(pressure >= 0.5 ? `buyers outnumber sellers ${(c.buys24 / Math.max(1, c.sells24)).toFixed(1)} to 1` : `sellers outnumber buyers ${(c.sells24 / Math.max(1, c.buys24)).toFixed(1)} to 1`);
  if(turnover >= 1) facts.push(`its whole market cap traded ${turnover.toFixed(1)}x today`);
  return {value: Math.round(value * 100) / 100, facts, against, pressure};
}
function octoFacts(c){
  const f = [`${pct(c.progress || 0)} through the bonding curve`];
  if(c.buyers1h) f.push(`${c.buyers1h} buyers in the last hour`);
  if(c.replies) f.push(`${c.replies} replies on pump.fun`);
  if(c.ath && c.mcap) f.push(`holding ${pct(c.mcap / c.ath)} of its high`);
  return f;
}

/* Safety 0..1: 1 minus the worst flag the Social and Vet agents raised. */
export function safety(social, vet){
  const worst = Math.max(0, ...Object.values(social?.flags || {}), ...Object.values(vet?.flags || {}));
  return Math.round((1 - worst) * 100) / 100;
}

export function deskScore(m, s){ return Math.round((0.5 * m + 0.5 * s) * 100) / 100; }

/* Plain-language thesis from the numbers. */
export function buildThesis(c, {social, vet, mom, deep} = {}){
  const why = [...(mom?.facts || [])];
  const good = [], risks = [], wrong = [];
  const f = vet?.facts || {}, sf = social?.flags || {}, vf = vet?.flags || {};

  // chain
  if(f.top10Pct != null) (f.top10Pct <= 0.2 ? good : f.top10Pct >= 0.35 ? risks : []).push(`top 10 wallets hold ${pct(f.top10Pct)} of supply`);
  if(f.devPct != null) (f.devPct < 0.01 ? good : f.devPct >= 0.03 ? risks : []).push(f.devPct < 0.01 ? 'dev wallet holds under 1%' : `dev still holds ${(f.devPct * 100).toFixed(1)}%`);
  if(f.launchRead && (f.bundledShare || 0) < 0.2 && (f.sniperShare || 0) < 0.4) good.push(`clean launch: of the first ${f.launchRead} buyers, ${pct(f.bundledShare || 0)} bundled and ${pct(f.sniperShare || 0)} sniped the first block`);
  if(f.launchUnverified) risks.push('launch too deep to read on a free RPC, so bundles and snipers are unchecked');
  if(f.bundledShare >= 0.2) risks.push(`${pct(f.bundledShare)} of the first buyers came in bundled launch transactions`);
  if(f.sniperShare >= 0.4) risks.push(`${pct(f.sniperShare)} of the first buyers sniped the launch block`);
  if(f.cabalWallets) risks.push(`${f.cabalWallets} known cabal wallets were early`);
  if(deep && f.earlyRead){
    if(f.earlyInProfit != null) why.push(`${f.earlyInProfit} of the first ${f.earlyRead} buyers are in profit`);
    if(f.earlyHoldingPct != null && f.earlyHoldingPct < 0.05) good.push('early buyers have mostly sold, so less supply waiting to dump');
    else if(f.earlyHoldingPct >= 0.15) risks.push(`early buyers still sit on ${pct(f.earlyHoldingPct)} of supply`);
  }

  // socials
  if(social){
    const a = social.account;
    if(social.handle && a && !(sf.recycled_account > 0.5) && !(sf.ghost_account > 0)) good.push(`real X account @${social.handle}${a.followers != null ? ` with ${a.followers.toLocaleString()} followers` : ''}`);
    if(sf.recycled_account >= 0.5) risks.push(sf.recycled_account === 1 ? `@${social.handle} was used on another coin` : `@${social.handle} is an older account wearing this coin's name`);
    if(sf.ghost_account) risks.push('the X account has almost no followers');
    if(sf.no_socials) risks.push('no X listed');
    if(sf.community_only) risks.push('only an X community, no project account');
  }
  if(c.src === 'octo' && c.progress >= 0.85) risks.push('close to graduation, where curve coins often dump on migration');
  if(c.liq && c.mcap && c.liq / c.mcap < 0.08) risks.push(`thin liquidity: ${usd(c.liq)} against ${usd(c.mcap)} market cap`);
  risks.push(...(mom?.against || []));

  // what would prove it wrong
  if(c.ath && c.mcap) wrong.push(`market cap falls under ${usd(c.ath * 0.6)} (60% of its high)`);
  else if(c.mcap) wrong.push(`market cap falls under ${usd(c.mcap * 0.6)}`);
  wrong.push(f.top10Pct != null ? `top 10 wallets climb past ${pct(Math.max(0.35, f.top10Pct + 0.1))}` : 'a few wallets start holding most of the supply');
  if(f.devPct != null && f.devPct > 0) wrong.push('the dev wallet sells or moves its bag');
  if(f.cabalWallets) wrong.push('the cabal wallets start selling');

  const lead = why[0] || 'it passed every kill on the desk';
  return {headline: `$${c.symbol}: ${lead}`, why: [...why, ...good].slice(0, 6), risks: risks.slice(0, 5), wrong: wrong.slice(0, 3), by: 'rules'};
}

/* Same thesis written by Claude when a key is set: it may only use the facts it's given. */
export async function claudeThesis(c, rules, facts, {apiKey, model, fetchImpl = fetch}){
  if(!apiKey) return rules;
  try {
    const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: {'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'},
      body: JSON.stringify({model, max_tokens: 700,
        system: 'You are the Chief on First In, a Solana memecoin desk that never takes a position. Write a short thesis for why this coin is worth watching, using ONLY the facts given. Be blunt and specific with numbers. Never invent facts, never tell anyone to buy.',
        tools: [{name: 'thesis', description: 'Publish the thesis.', input_schema: {type: 'object', properties: {
          headline: {type: 'string', description: 'Under 90 characters, starts with $TICKER.'},
          why: {type: 'array', items: {type: 'string'}, description: '2-5 short bullets: why it is on the desk.'},
          risks: {type: 'array', items: {type: 'string'}, description: '1-4 short bullets: what could kill it.'},
          wrong: {type: 'array', items: {type: 'string'}, description: '1-3 short bullets: what would prove the thesis wrong.'}},
          required: ['headline', 'why', 'risks', 'wrong']}}],
        tool_choice: {type: 'tool', name: 'thesis'},
        messages: [{role: 'user', content: JSON.stringify({coin: c.symbol, facts, draft: rules})}]}),
    });
    const j = await res.json();
    const t = (j.content || []).find(b => b.type === 'tool_use')?.input;
    if(!t?.headline || !t.why?.length || !t.wrong?.length) return rules;
    return {headline: String(t.headline).slice(0, 120), why: (t.why || []).slice(0, 6), risks: (t.risks || []).slice(0, 5), wrong: (t.wrong || []).slice(0, 3), by: model};
  } catch { return rules; }
}
