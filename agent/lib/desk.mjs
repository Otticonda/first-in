// The desk: the order coins go through, the numbers the desk believes, and the Chief's verdict.
// free_kill (DexScreener numbers, costs nothing) -> social_kill (one lookup) -> chain_kill (RPC credits) -> verdict

export const DEFAULT_THRESHOLDS = {
  hard: {min_age_minutes: 15, max_age_hours: 72, min_liquidity_usd: 15000, min_volume_h24: 40000, min_mcap_usd: 250000, min_trades_h24: 150},
  octo: {enabled: true, pages: 3, min_age_minutes: 5, max_age_hours: 24, min_curve_progress: 0.2, min_mcap_vs_ath: 0.5, min_mcap_usd: 8000, min_score: 0.5, alert_score: 0.72, alerts_per_run: 2},
  soft: {recycled_account: 0.7, no_socials: 0.7, ghost_account: 0.9, dev_still_loaded: 0.6, top10_concentration: 0.7, bundled_launch: 0.6, sniped_launch: 0.8, cabal_in_early: 0.5, early_bags_loaded: 0.9},
};

export function freeKill(c, hard, now = Date.now()){
  const ageMin = c.createdAt ? (now - c.createdAt) / 60000 : null;
  const trades = (c.buys24 || 0) + (c.sells24 || 0);
  const checks = [
    ['too_new', ageMin != null && ageMin < hard.min_age_minutes, `${Math.round(ageMin)}m old`],
    ['too_old', ageMin == null || ageMin > hard.max_age_hours * 60, ageMin == null ? 'no pair date' : `${Math.round(ageMin / 60)}h old`],
    ['thin_liquidity', c.liq < hard.min_liquidity_usd, `liq $${Math.round(c.liq)}`],
    ['no_volume', c.vol24 < hard.min_volume_h24, `vol $${Math.round(c.vol24)}`],
    ['too_small', c.mcap < hard.min_mcap_usd, `mcap $${Math.round(c.mcap)}`],
    ['dead_tape', trades < hard.min_trades_h24, `${trades} trades`],
  ];
  const hit = checks.find(([, bad]) => bad);
  return hit ? {pass: false, reason: hit[0], detail: hit[2]} : {pass: true};
}

/* score for which free-kill survivors get a closer look first */
export const priority = c => Math.log10(1 + c.vol24) + (c.mint.endsWith('pump') ? 0.5 : 0) + Math.min(1, (c.buys24 || 0) / Math.max(1, c.sells24 || 1) - 1) * 0.3;

export function socialKill(social, soft){
  for(const [k, v] of Object.entries(social?.flags || {})) if(soft[k] != null && v > soft[k]) return {pass: false, reason: k, value: v};
  return {pass: true};
}

const LABELS = {
  cabal_in_early: 'CABAL RUN', dev_still_loaded: 'RUG RISK', top10_concentration: 'RUG RISK',
  sniped_launch: 'BOTTED', bundled_launch: 'BUNDLED', early_bags_loaded: 'HEAVY BAGS',
  recycled_account: 'SKETCHY SOCIALS', no_socials: 'SKETCHY SOCIALS', ghost_account: 'SKETCHY SOCIALS',
};

/* Chief never takes a position: it only says what the coin is. */
export function chiefVerdict({social, vet, read = null}, soft){
  // a verdict needs evidence: without the early buyers there's nothing to call it clean on
  if(read != null && read < 5) return {verdict: 'NO DATA', reasons: [`only ${read} early buyers read`], tone: 'mid'};
  const kills = [];
  for(const src of [social, vet]) for(const [k, v] of Object.entries(src?.flags || {})) if(soft[k] != null && v > soft[k]) kills.push({flag: k, value: v});
  kills.sort((a, b) => (b.value - soft[b.flag]) - (a.value - soft[a.flag]));
  if(!kills.length) return {verdict: 'CLEAN', reasons: [], tone: 'good'};
  return {verdict: LABELS[kills[0].flag] || 'CAUTION', reasons: kills.map(k => `${k.flag} ${k.value.toFixed(2)}`), tone: 'bad'};
}
