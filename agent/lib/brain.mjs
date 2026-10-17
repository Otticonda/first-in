// The agent's judgment: Claude reads what the rules found and decides what it means.
// Without an ANTHROPIC_API_KEY everything falls back to plain rules, so the agent never stops working.

const API = 'https://api.anthropic.com/v1/messages';

async function callTool({apiKey, model, system, user, tool, maxTokens = 1500, fetchImpl = fetch}){
  const res = await fetchImpl(API, {
    method: 'POST',
    headers: {'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01'},
    body: JSON.stringify({
      model, max_tokens: maxTokens, system,
      tools: [tool], tool_choice: {type: 'tool', name: tool.name},
      messages: [{role: 'user', content: user}],
    }),
  });
  const j = await res.json().catch(() => null);
  if(!res.ok) throw new Error(`Claude API ${res.status}: ${j?.error?.message || 'request failed'}`);
  const block = (j.content || []).find(b => b.type === 'tool_use' && b.name === tool.name);
  if(!block) throw new Error('Claude did not return a result');
  return {result: block.input, usage: j.usage};
}

const VERDICTS = ['cabal', 'smart_money', 'bot_farm', 'noise'];

const JUDGE_SYSTEM = `You are the analyst inside First In, a Solana early-wallet tracker run by a memecoin trader.
You get groups of wallets that bought early on the same coins. Decide what each group most likely is:
- cabal: coordinated insiders (same-block buys, synced exits, dev links, tiny entry times across several coins)
- smart_money: separate skilled traders who independently keep finding the same runners early
- bot_farm: automated snipers or copy-bots with little edge
- noise: coincidence, too little evidence
Weigh evidence honestly. Same-slot buys and exits within minutes of each other are the strongest coordination signals.
A dev link is strong. Two coins is weak evidence; say so via lower confidence. Never invent facts beyond the data.
alert: one punchy line for a Telegram ping, under 140 characters, written for a degen audience, no hashtags.`;

const JUDGE_TOOL = {
  name: 'report_verdicts',
  description: 'Report a verdict for every wallet group you were given.',
  input_schema: {
    type: 'object',
    properties: {verdicts: {type: 'array', items: {type: 'object', properties: {
      id: {type: 'string'}, verdict: {type: 'string', enum: VERDICTS},
      confidence: {type: 'integer', minimum: 0, maximum: 100},
      why: {type: 'string', description: 'One or two sentences citing the evidence.'},
      alert: {type: 'string'},
    }, required: ['id', 'verdict', 'confidence', 'why', 'alert']}}},
    required: ['verdicts'],
  },
};

function ruleVerdict(c){
  const strong = c.sameSlotCoins + c.syncExitCoins + (c.devLinked ? 2 : 0);
  const verdict = strong >= 2 ? 'cabal' : c.pnl > 0 && c.coins.length >= 3 ? 'smart_money' : strong >= 1 ? 'cabal' : 'noise';
  const confidence = Math.min(90, 30 + 10 * strong + 5 * c.coins.length);
  const ev = [`${c.size} wallets early together on ${c.coins.length} coins`];
  if(c.sameSlotCoins) ev.push(`same-block buys on ${c.sameSlotCoins}`);
  if(c.syncExitCoins) ev.push(`synced exits on ${c.syncExitCoins}`);
  if(c.devLinked) ev.push('linked to a dev wallet');
  return {id: c.id, verdict, confidence, why: ev.join(', ') + '.', alert: `${c.size}-wallet group on ${c.coins.map(x => '$' + x.symbol).join(' ')}`, by: 'rules'};
}

export async function judgeClusters(clusters, {apiKey, model, fetchImpl} = {}){
  if(!clusters.length) return [];
  if(!apiKey) return clusters.map(ruleVerdict);
  const payload = clusters.map(c => ({
    id: c.id, wallets: c.size, coins: c.coins, sameSlotCoins: c.sameSlotCoins, syncExitCoins: c.syncExitCoins,
    devLinked: c.devLinked, combinedPnlSol: c.pnl, avgEntrySecondsAfterLaunch: c.avgSecs, ruleScore: c.score,
  }));
  try {
    const {result} = await callTool({apiKey, model, fetchImpl, system: JUDGE_SYSTEM, tool: JUDGE_TOOL,
      user: `Wallet groups found in the latest scans (SOL amounts, seconds after launch):\n${JSON.stringify(payload)}`});
    const byId = new Map((result.verdicts || []).map(v => [v.id, v]));
    return clusters.map(c => {
      const v = byId.get(c.id);
      return v && VERDICTS.includes(v.verdict) ? {...v, by: model} : ruleVerdict(c);
    });
  } catch(e){
    console.warn('Claude judge failed, using rules:', e.message);
    return clusters.map(ruleVerdict);
  }
}

const RECAP_SYSTEM = `You write the daily recap for First In, a Solana early-wallet tracker, sent to its owner on Telegram and shown on the site.
Plain text only, no markdown, no hashtags. 120 to 220 words. Lead with the single most important thing that happened.
Then cover: what watched wallets bought (and any overlaps), notable new coins scanned and who won early, any cabal or smart-money groups found, and one concrete thing worth watching next.
Use $TICKER style. Be direct and specific with numbers from the data; never invent coins, wallets or figures. If it was a quiet day, say so briefly.`;

const RECAP_TOOL = {
  name: 'publish_recap',
  description: 'Publish the daily recap.',
  input_schema: {type: 'object', properties: {headline: {type: 'string', description: 'Under 80 characters.'}, body: {type: 'string'}}, required: ['headline', 'body']},
};

export function ruleRecap(ctx){
  const lines = [];
  lines.push(`${ctx.buys.length} buys from watched wallets in the last 24h${ctx.overlaps.length ? `, ${ctx.overlaps.length} overlap${ctx.overlaps.length > 1 ? 's' : ''}` : ''}.`);
  if(ctx.overlaps.length) lines.push('Overlaps: ' + ctx.overlaps.map(o => `$${o.symbol} (${o.wallets} wallets)`).join(', ') + '.');
  if(ctx.coins.length) lines.push('Scanned: ' + ctx.coins.map(c => `$${c.symbol}${c.inProfit != null ? ` ${c.inProfit}/${c.read} early in profit` : ''}`).join(', ') + '.');
  if(ctx.clusters.length) lines.push('Groups: ' + ctx.clusters.map(c => `${c.verdict} (${c.size} wallets, ${c.coins} coins)`).join(', ') + '.');
  lines.push(`Credits used: ${ctx.creditsToday.toLocaleString()}.`);
  return {headline: ctx.overlaps[0] ? `Overlap on $${ctx.overlaps[0].symbol}` : 'Daily recap', body: lines.join('\n'), by: 'rules'};
}

export async function writeRecap(ctx, {apiKey, model, fetchImpl} = {}){
  if(!apiKey) return ruleRecap(ctx);
  try {
    const {result} = await callTool({apiKey, model, fetchImpl, system: RECAP_SYSTEM, tool: RECAP_TOOL, maxTokens: 1200,
      user: `Last 24 hours of agent data:\n${JSON.stringify(ctx)}`});
    return {headline: String(result.headline || 'Daily recap').slice(0, 100), body: String(result.body || ''), by: model};
  } catch(e){
    console.warn('Claude recap failed, using rules:', e.message);
    return ruleRecap(ctx);
  }
}
