// Telegram: alerts out, commands in. Commands are read each time the agent wakes up (every ~15 min),
// and only from the one chat set in TELEGRAM_CHAT_ID.

export const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));

export function createTelegram({token, chatId, fetchImpl = fetch, dryRun = false}){
  const enabled = !!(token && chatId);
  const api = (method, body) => fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  }).then(r => r.json()).catch(e => ({ok: false, description: e.message}));

  async function send(html){
    if(!html) return;
    if(dryRun || !enabled){ console.log('[telegram]', html.replace(/<[^>]+>/g, '')); return; }
    // Telegram caps messages at 4096 chars; split on line breaks
    const parts = []; let cur = '';
    for(const line of html.split('\n')){
      if((cur + '\n' + line).length > 3900){ parts.push(cur); cur = line; } else cur = cur ? cur + '\n' + line : line;
    }
    if(cur) parts.push(cur);
    for(const text of parts){
      const r = await api('sendMessage', {chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true});
      if(!r.ok) console.warn('Telegram send failed:', r.description);
    }
  }

  /* New commands since `offset`. Returns {commands: [{cmd, args, text}], offset}. */
  async function poll(offset = 0){
    if(!enabled || dryRun) return {commands: [], offset};
    const r = await api('getUpdates', {offset, timeout: 0, allowed_updates: ['message']});
    if(!r.ok){ console.warn('Telegram poll failed:', r.description); return {commands: [], offset}; }
    const commands = [];
    let next = offset;
    for(const u of r.result || []){
      next = Math.max(next, u.update_id + 1);
      const m = u.message;
      if(!m || String(m.chat?.id) !== String(chatId) || typeof m.text !== 'string') continue;
      const match = m.text.trim().match(/^\/(\w+)(?:@\w+)?\s*(.*)$/s);
      if(match) commands.push({cmd: match[1].toLowerCase(), args: match[2].trim().split(/\s+/).filter(Boolean), text: m.text});
    }
    return {commands, offset: next};
  }

  return {send, poll, enabled};
}
