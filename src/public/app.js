const $ = (id) => document.getElementById(id);
const PATHS = {
  search:'<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>',
  cal:'<rect x="2" y="3" width="12" height="11" rx="2"/><path d="M2 7h12M5.5 1.5v3M10.5 1.5v3"/>',
  hist:'<path d="M2.5 8a5.5 5.5 0 1 0 1.8-4.1"/><path d="M2.5 2.5v3h3M8 5v3.2l2 1.2"/>',
  alert:'<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.6v.1"/>',
  info:'<circle cx="8" cy="8" r="6"/><path d="M8 7.2v4M8 4.9v.1"/>',
  up:'<path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/>',
  stop:'<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor"/>',
  menu:'<path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11"/>',
  x:'<path d="M4 4l8 8M12 4l-8 8"/>',
  trace:'<path d="M2 4h5M2 8h9M2 12h6"/>',
  plus:'<path d="M8 3v10M3 8h10"/>',
  down:'<path d="M8 2.5v8M4.5 7.5L8 11l3.5-3.5M3 13.5h10"/>',
  flag:'<path d="M3.5 14V2.5M3.5 3h8l-1.8 2.6L11.5 8h-8"/>',
};
const ico = (n, s = 14) => `<svg class="ico" viewBox="0 0 16 16" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[n]}</svg>`;
const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
const ls = { get(k){ try { return localStorage.getItem(k); } catch { return null; } }, set(k,v){ try { localStorage.setItem(k,v); } catch {} } };
const wrap = $('wrap'), log = $('log'), input = $('input'), sendBtn = $('send'), list = $('list');
let conversationId = ls.get('conversationId') || crypto.randomUUID(); ls.set('conversationId', conversationId);
let busy = false, ctrl = null, tab = 'chats', health = null;

marked.setOptions({ breaks: true, gfm: true });
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
const fmtMs = (ms) => ms == null ? '' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms/1000).toFixed(1)} s`;
const dayKey = (d) => d.toDateString();
const dayLabel = (d) => { const t = new Date(); const y = new Date(Date.now()-864e5);
  return dayKey(d)===dayKey(t) ? 'Today' : dayKey(d)===dayKey(y) ? 'Yesterday' : d.toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short',year: d.getFullYear()!==t.getFullYear()?'numeric':undefined}); };
const clock = (iso) => new Date(iso).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'});
function normUrl(u){ try { const x=new URL(u); return (x.hostname.replace(/^www\./,'')+x.pathname.replace(/\/+$/,'')+x.search).toLowerCase(); } catch { return (u||'').toLowerCase(); } }
const announce = (m) => { const r = $('sr'); r.textContent = ''; setTimeout(() => { r.textContent = m; }, 100); };
const scrollDown = () => { log.scrollTop = log.scrollHeight; };

/* ---------- header ---------- */
function tickNow(){ const d = new Date(); const city = tz.split('/').pop().replace(/_/g,' '); $('now').innerHTML = `<b>${d.toLocaleDateString('en-GB',{weekday:'short',day:'numeric',month:'short',year:'numeric'})}</b><span class="sep">·</span><span>${esc(city)}</span>`; }
tickNow(); setInterval(tickNow, 60000);

/* ---------- rendering an assistant message ---------- */
const visible = (s) => s.replace(/\s*<ledger[\s\S]*$/i, '').replace(/\s*<l(?:e(?:d(?:g(?:e(?:r)?)?)?)?)?$/i, '');
function renderMd(el, text, sources, unverified) {
  text = visible(text);
  el.innerHTML = DOMPurify.sanitize(marked.parse(text));
  const byUrl = new Map((sources||[]).map(s => [normUrl(s.url), s]));
  const bad = new Set((unverified||[]).map(normUrl));
  el.querySelectorAll('a').forEach(a => {
    a.target = '_blank'; a.rel = 'noopener noreferrer';
    const k = normUrl(a.href), s = byUrl.get(k);
    if (s) { const sup = document.createElement('sup'); sup.className='cite'; const l = document.createElement('a'); l.href='#'; l.textContent=s.domain.length>20?s.domain.slice(0,19)+'…':s.domain; l.title=`[${s.n}] ${s.title} — ${s.domain}`; l.setAttribute('aria-label',`Source ${s.n}: ${s.title}, ${s.domain}`); l.onclick=(e)=>{e.preventDefault(); highlight(el.closest('.a'), s.n);}; sup.appendChild(l); a.after(sup); }
    else if (bad.has(k)) { a.classList.add('unverified'); a.title = 'This link did not appear in any search result'; }
  });
}
function highlight(msg, n){ if (msg?._turn) openPanel(msg._turn, n); }

const hue = (str) => { let h = 0; for (const c of str) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
function renderSources(t) {
  const sources = t.sources || []; t.srcs.innerHTML = '';
  if (!sources.length) return;
  const doms = [...new Set(sources.map(x => x.domain))];
  const b = document.createElement('button'); b.type = 'button'; b.className = 'strip'; b.setAttribute('aria-expanded', 'false');
  b.innerHTML = `<span class="avs">${doms.slice(0,4).map(d => `<span class="av" style="background:hsl(${hue(d)} 45% 32%)">${esc(d[0] || '?')}</span>`).join('')}</span><span>${sources.length} source${sources.length>1?'s':''}</span><span class="meta2">${doms.length} site${doms.length>1?'s':''}</span>`;
  b.onclick = () => openPanel(t);
  t.srcs.appendChild(b); t.strip = b;
}
let panelTurn = null;
function openPanel(t, n) {
  panelTurn = t; document.body.classList.add('panel');
  document.querySelectorAll('.strip').forEach(x => x.setAttribute('aria-expanded', x === t.strip));
  const box = $('srcbody'); box.innerHTML = '';
  const q = document.createElement('div'); q.className = 'srcq'; q.textContent = `Retrieved for this answer. “Date unknown” means the page showed no publication date.`; box.appendChild(q);
  for (const s of t.sources || []) {
    const a = document.createElement('a'); a.className = 'src'; a.href = s.url; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.dataset.n = s.n;
    a.innerHTML = `<div class="h"><span class="n">${s.n}</span><span class="dm">${esc(s.domain)}</span><span class="${s.date?'':'nodate'}">${s.date?esc(s.date):'date unknown'}</span></div><div class="tt">${esc(s.title)}</div>`;
    box.appendChild(a);
  }
  if (n) { const c = box.querySelector(`.src[data-n="${n}"]`); c?.scrollIntoView({ block:'nearest', behavior:'smooth' }); c?.classList.add('hl'); setTimeout(() => c?.classList.remove('hl'), 1600); }
}
function closePanel() { document.body.classList.remove('panel'); document.querySelectorAll('.strip').forEach(x => x.setAttribute('aria-expanded', 'false')); }

const STATUS = { unchanged:['✓','Unchanged'], changed:['Δ','Changed'], unverified:['?','Not verified'], new:['＋','Recorded'] };
function renderLedger(t) {
  const items = t.ledger || []; const box = t.ledgerEl;
  if (!items.length) { box.hidden = true; return; }
  const check = items.some(i => i.was);
  const n = { changed:0, unchanged:0, unverified:0 }; items.forEach(i => { if (n[i.status] !== undefined) n[i.status]++; });
  box.hidden = false;
  box.innerHTML = `<div class="lh"><b>${check ? 'What changed' : 'Facts recorded'}</b><span>${check ? `${n.changed} changed · ${n.unchanged} unchanged · ${n.unverified} not verified` : `${items.length} tracked for later re-checks`} · verdicts checked by code against this turn’s sources</span></div>`;
  for (const i of items) {
    const [icon, label] = STATUS[i.status] || STATUS.unverified;
    const row = document.createElement('div'); row.className = 'lrow';
    let src = ''; if (i.source) { let d = i.source; try { d = new URL(i.source).hostname.replace(/^www\./, ''); } catch {} src = `<a href="${esc(i.source)}" target="_blank" rel="noopener noreferrer">${esc(d)}</a>`; }
    const vals = i.was && i.now && i.was !== i.now ? `<s>${esc(i.was)}</s><span class="arrow">→</span><span>${esc(i.now)}</span>` : `<span>${esc(i.now || i.was || '—')}</span>`;
    row.innerHTML = `<div class="it">${esc(i.item)}${i.note ? `<small>${esc(i.note)}</small>` : ''}</div><div class="vals">${vals}${src}</div><span class="st ${i.status}" title="${esc(label)}">${icon} ${esc(label)}</span>${i.adjusted ? `<div class="lfix">⚑ Label corrected by code: ${esc(i.adjusted)}.</div>` : ''}`;
    box.appendChild(row);
  }
}

function renderInspector(t) {
  const total = Math.max(t.done?.ms || 1, 1); const parts = [];
  const bar = (start, ms, cls) => `<div class="track"><div class="fill ${cls||''}" style="left:${Math.min(start/total*100,99)}%;width:${Math.max(ms/total*100,1.5)}%"></div></div>`;
  let cursor = 0;
  if (t.memory) {
    const w = t.memory.windows.map(x => `“${esc(x.text)}” → ${esc(x.label)}`).join('; ');
    parts.push(`<div class="note">Memory resolved in code before the model was called. ${w ? 'Dates: ' + w + '.' : 'No date expressions found.'} ${t.memory.recalled.length} past turn(s) injected.</div>`);
    parts.push(`<div class="row"><span class="lbl">memory lookup</span>${bar(0, Math.max(t.memory.ms,1), 'mem')}<span class="ms">${fmtMs(t.memory.ms)}</span></div>`);
  }
  t.steps.forEach((s, i) => {
    const tools = t.tools.filter(x => x.step === i + 1);
    parts.push(`<div class="row"><span class="lbl">model step ${s.n}${s.ttftMs!=null?` · first token ${fmtMs(s.ttftMs)}`:''}</span>${bar(cursor, s.ms)}<span class="ms">${fmtMs(s.ms)}</span></div>`);
    cursor += s.ms;
    const longest = Math.max(0, ...tools.map(x => x.ms));
    tools.forEach(x => parts.push(`<div class="row sub"><span class="lbl" title="${esc(x.query)}">↳ ${esc(x.query)}</span>${bar(cursor, x.ms, 'tool')}<span class="ms">${x.error ? '✗ ' : ''}${fmtMs(x.ms)}</span></div>`));
    cursor += longest; // parallel: the step waits for the slowest search
  });
  if (t.done) parts.push(`<div class="note" style="padding-top:8px">Total ${fmtMs(t.done.ms)}${t.done.ttftMs!=null?` · first token at ${fmtMs(t.done.ttftMs)}`:''} · ${t.done.searches} search${t.done.searches===1?'':'es'} · searches within a step run in parallel.</div>`);
  return parts.join('');
}

function newTurn(userText) {
  const u = document.createElement('div'); u.className='u'; u.textContent = userText;
  const a = document.createElement('div'); a.className='a';
  a.innerHTML = `<div class="chips open"></div><div class="thinking"><i></i><i></i><i></i><span>Thinking</span></div><div class="body md"></div><div class="ledger" hidden></div><div class="srcs"></div><div class="warnbox" hidden></div><div class="bar" hidden></div><div class="insp" hidden></div>`;
  wrap.append(u, a);
  a._turn = null; a.setAttribute('role','article'); a.setAttribute('aria-label','Assistant answer');
  const t = { a, chips:a.querySelector('.chips'), think:a.querySelector('.thinking'), body:a.querySelector('.body'), ledgerEl:a.querySelector('.ledger'), ledger:[], srcs:a.querySelector('.srcs'), warn:a.querySelector('.warnbox'), bar:a.querySelector('.bar'), insp:a.querySelector('.insp'),
    strip:null, text:'', sources:[], memory:null, steps:[], tools:[], done:null, chipFor:new Map() };
  a._turn = t; scrollDown(); return t;
}

function finalize(t, meta) {
  t.think.remove();
  renderMd(t.body, t.text, t.sources, t.done?.unverified);
  renderSources(t); renderLedger(t);
  const un = t.done?.unverified || [];
  if (un.length) { t.warn.hidden = false; t.warn.innerHTML = `${ico('alert')} ${un.length} link${un.length>1?'s':''} in this answer didn’t appear in any search result — treat as unverified.`; }
  const fg = t.done?.figures;
  const mk = (cls, html) => { const d = document.createElement('div'); d.className = cls; d.innerHTML = html; t.warn.after(d); };
  if (fg?.fromMemory?.length) mk('info', `${ico('info')} Not re-confirmed this turn (carried over from earlier chats): <b>${fg.fromMemory.map(esc).join(', ')}</b>.`);
  if (fg?.unsupported?.length) { t.warn.hidden = false; t.warn.innerHTML += `${t.warn.innerHTML ? '<br>' : ''}${ico('alert')} Figures not found in any source this turn (may be calculated): <b>${fg.unsupported.map(esc).join(', ')}</b>.`; }
  const nSearch = t.chips.querySelectorAll('.srch').length;
  if (nSearch) { t.chips.classList.remove('open'); const sm = document.createElement('button'); sm.type='button'; sm.className='chip sum'; sm.innerHTML = `${ico('search',13)} ${nSearch} search${nSearch>1?'es':''} ▾`; sm.setAttribute('aria-expanded','false'); sm.onclick = () => { const o = t.chips.classList.toggle('open'); sm.setAttribute('aria-expanded', o); sm.innerHTML = `${ico('search',13)} ${nSearch} search${nSearch>1?'es':''} ${o?'▴':'▾'}`; }; t.chips.appendChild(sm); }
  t.bar.hidden = false;
  const info = meta ? `${fmtMs(meta.ms)}${meta.searches?` · ${meta.searches} search${meta.searches>1?'es':''}`:' · no search needed'}` : '';
  const stamp = t.ts ? new Date(t.ts).toLocaleString('en-GB', { weekday:'short', day:'numeric', month:'short', hour:'2-digit', minute:'2-digit' }) : '';
  t.bar.innerHTML = `<span>${[stamp, info].filter(Boolean).join(' · ')}</span><span class="sp1"></span>`;
  const copy = btn('Copy', () => { navigator.clipboard?.writeText(t.text); copy.textContent = 'Copied'; setTimeout(()=>copy.textContent='Copy',1200); });
  t.bar.appendChild(copy);
  if (t.memory) { const ib = btn('Inspect', () => { t.insp.hidden = !t.insp.hidden; if(!t.insp.hidden){ t.insp.innerHTML = renderInspector(t); scrollDown(); } }); t.bar.appendChild(ib); }
}
function btn(label, fn){ const b = document.createElement('button'); b.className='ghost'; b.type='button'; b.textContent=label; b.onclick=fn; return b; }

function addChip(t, html, cls) { const c = document.createElement('span'); c.className = 'chip ' + (cls||''); c.innerHTML = html; t.chips.appendChild(c); return c; }

function handle(t, ev, d) {
  if (ev === 'memory') {
    t.memory = d;
    for (const w of d.windows) addChip(t, `${ico('cal',13)} “${esc(w.text)}” → <b>${esc(w.label)}</b>`, 'mem');
    if (d.recalled.length) addChip(t, `${ico('hist',13)} recalled <b>${d.recalled.length}</b> past chat${d.recalled.length>1?'s':''}`, 'mem');
    else if (d.windows.length) addChip(t, `nothing stored for that date`, 'err');
  } else if (ev === 'status') {
    const q = d.text.replace(/^Searching: /,''); t.think.querySelector('span').textContent = 'Searching the web';
    t.chipFor.set(q, addChip(t, `<span class="sp"></span>${ico('search',13)} ${esc(q.length>46?q.slice(0,46)+'…':q)}`, 'srch'));
  } else if (ev === 'tool') {
    d.step = t.steps.length; t.tools.push(d);
    const c = t.chipFor.get(d.query); if (c) { c.classList.add(d.error?'err':'done'); if (d.error) c.querySelector('.sp').outerHTML=ico('alert',13); c.insertAdjacentHTML('beforeend', `<span style="color:var(--faint)">${fmtMs(d.ms)}</span>`); }
  } else if (ev === 'step') { t.steps.push(d); t.think.querySelector('span').textContent = d.toolCalls ? 'Reading results' : 'Writing';
  } else if (ev === 'ledger') { t.ledger = d.items;
  } else if (ev === 'sources') { t.sources = d.sources; renderSources(t);
  } else if (ev === 'reset') { t.text=''; t.body.innerHTML=''; if(!t.think.isConnected) return; t.think.hidden=false;
  } else if (ev === 'text') { t.text += d.delta; t.think.hidden = true; if (!t.raf) t.raf = requestAnimationFrame(() => { t.raf=0; renderMd(t.body, t.text, t.sources); scrollDown(); });
  } else if (ev === 'done') { t.done = d;
  } else if (ev === 'error') throw new Error(d.message);
}

/* ---------- sending ---------- */
function setBusy(b) { busy = b; sendBtn.classList.toggle('stop', b); sendBtn.innerHTML = ico(b ? 'stop' : 'up', 16); sendBtn.setAttribute('aria-label', b ? 'Stop' : 'Send'); if (!b) sendBtn.disabled = false; }

async function submit(text) {
  text = (text ?? input.value).trim();
  if (!text || busy) return;
  input.value = ''; input.style.height = 'auto';
  wrap.querySelector('.hero')?.remove();
  const nowIso = new Date().toISOString(); daySep(nowIso);
  const t = newTurn(text); t.ts = nowIso;
  setBusy(true); ctrl = new AbortController(); announce('Generating answer');
  try {
    const res = await fetch('/api/chat', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ message:text, conversationId, tz }), signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error((await res.json().catch(()=>({}))).error || 'Request failed');
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream:true }); let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0,i); buf = buf.slice(i+2);
        const ev = /^event: (.*)$/m.exec(raw)?.[1], data = /^data: (.*)$/m.exec(raw)?.[1];
        if (ev && data) handle(t, ev, JSON.parse(data));
      }
    }
    cancelAnimationFrame(t.raf);
    finalize(t, t.done && { ms:t.done.ms, searches:t.done.searches });
    refreshSide(); announce('Answer complete');
  } catch (err) {
    cancelAnimationFrame(t.raf); t.think.remove();
    announce(err.name === 'AbortError' ? 'Stopped' : 'Error: ' + err.message);
    if (err.name === 'AbortError') { if (t.text) renderMd(t.body, t.text, t.sources); t.bar.hidden=false; t.bar.textContent='Stopped — this exchange was not saved to memory.'; }
    else { t.body.innerHTML = ''; const e = document.createElement('div'); e.className='errbox'; e.innerHTML = ico('alert') + ' ' + esc(err.message); t.body.appendChild(e); const r = btn('Retry', () => { e.remove(); r.remove(); submit(text); }); t.bar.hidden=false; t.bar.appendChild(r); }
  } finally { setBusy(false); ctrl = null; input.focus(); scrollDown(); }
}

/* ---------- empty state / history ---------- */
function hero() {
  lastDay = '';
  wrap.innerHTML = `<div class="hero"><div class="kicker">Ago</div><h2>Ask anything.<br>I’ll check the web, and remember when.</h2>
    <p>Live search with sources you can open, and a memory that knows what you asked and on which day.</p>
    <div class="feats">
      <div class="feat"><b>${ico('search')} Live search</b>Parallel, date-filtered, primary sources first.</div>
      <div class="feat"><b>${ico('cal')} Dated memory</b>“Last Tuesday” and “since Monday” are resolved in code.</div>
      <div class="feat"><b>${ico('trace')} Checked answers</b>Links, figures and verdicts are verified against sources.</div>
    </div>
    <div class="try"></div></div>`;
  const box = wrap.querySelector('.try');
  for (const q of ['What did I ask you on Monday?','Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?','On Monday we shortlisted 5 CRM tools. Has any of them changed pricing or shipped something big since?','What changed in the latest Node.js release?']) { const b = document.createElement('button'); b.textContent = q; b.onclick = () => submit(q); box.appendChild(b); }
  const d = document.createElement('button'); d.className='sample'; d.type='button'; d.innerHTML = `${ico('hist')} New here? Add sample history to try the memory questions`; d.onclick = addSample; box.appendChild(d);
}

let lastDay = '';
function daySep(iso) {
  const k = dayKey(new Date(iso)); if (k === lastDay) return; lastDay = k;
  const s = document.createElement('div'); s.className = 'daysep'; s.innerHTML = `<span>${esc(dayLabel(new Date(iso)))}</span>`; wrap.appendChild(s);
}
async function loadHistory() {
  const turns = await fetch('/api/history?conversationId=' + conversationId).then(r => r.json()).catch(() => []);
  if (!turns.length) return hero();
  wrap.innerHTML = ''; lastDay = '';
  for (const h of turns) {
    daySep(h.ts);
    const t = newTurn(h.user); t.ts = h.ts; t.text = h.assistant; t.sources = h.sources || []; t.ledger = h.ledger || [];
    finalize(t, h.meta && { ms:h.meta.ms, searches:h.meta.searches });
  }
  scrollDown();
}

/* ---------- sidebar: chats + memory timeline ---------- */
async function refreshSide() {
  const mem = await fetch('/api/memory').then(r => r.json()).catch(() => []);
  $('memcount').textContent = `${mem.length} remembered turn${mem.length===1?'':'s'}`;
  list.innerHTML = '';
  if (tab === 'chats') {
    const convs = await fetch('/api/conversations').then(r => r.json()).catch(() => []);
    if (!convs.length) list.innerHTML = '<div class="empty-note">No chats yet. Ask something to get started.</div>';
    for (const c of convs) {
      const it = document.createElement('div'); it.className = 'item' + (c.id===conversationId?' active':''); it.tabIndex = 0; it.setAttribute('role', 'button');
      it.innerHTML = `<div class="t">${esc(c.title)}</div><div class="m">${dayLabel(new Date(c.ts))} · ${c.turns} turn${c.turns>1?'s':''}</div><div class="acts"><button class="mini danger del" type="button">Delete chat</button></div>`;
      const open = () => { conversationId = c.id; ls.set('conversationId', c.id); closeSide(); loadHistory(); refreshSide(); };
      it.onclick = open; it.onkeydown = (e) => { if (e.target === it && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); open(); } };
      it.querySelector('.del').onclick = async (e) => { e.stopPropagation(); if (!confirm('Delete this chat? Ago will also forget it.')) return; await fetch('/api/conversations/' + c.id, { method:'DELETE' }); if (c.id === conversationId) newChat(); else refreshSide(); };
      list.appendChild(it);
    }
  } else {
    if (!mem.length) { list.innerHTML = '<div class="empty-note">Nothing remembered yet. Everything you ask is stored here with its date, and you can delete any of it.</div>'; const b = document.createElement('button'); b.className = 'mini'; b.style.margin = '0 10px'; b.textContent = 'Add sample history'; b.onclick = addSample; list.appendChild(b); }
    let last = '';
    for (const m of mem) {
      const d = new Date(m.ts), k = dayKey(d);
      if (k !== last) { const h = document.createElement('div'); h.className='day'; h.textContent = dayLabel(d); list.appendChild(h); last = k; }
      const it = document.createElement('div'); it.className = 'item'; it.tabIndex = 0;
      it.innerHTML = `<div class="t">${esc(m.user)}</div><div class="m">${clock(m.ts)}${m.sources?` · ${m.sources} sources`:''}</div><div class="acts"><button class="mini re">Still correct?</button><button class="mini danger fg">Forget</button></div>`;
      it.querySelector('.re').onclick = (e) => { e.stopPropagation(); closeSide(); submit(`Is your answer to my question “${m.user.slice(0,140)}” from ${d.toLocaleDateString('en-GB',{weekday:'long',day:'numeric',month:'long',year:'numeric'})} still correct today? Re-check it.`); };
      it.querySelector('.fg').onclick = async (e) => { e.stopPropagation(); if (!confirm('Forget this exchange? It will be removed from memory.')) return; await fetch('/api/turns/' + m.id, { method:'DELETE' }); refreshSide(); if (m.conversationId===conversationId) loadHistory(); };
      list.appendChild(it);
    }
  }
}
function setTab(t) { tab = t; $('tab-chats').setAttribute('aria-selected', t==='chats'); $('tab-mem').setAttribute('aria-selected', t==='mem'); refreshSide(); }
const closeSide = () => document.body.classList.remove('open');
async function addSample() { await fetch('/api/sample', { method:'POST' }); setTab('mem'); }
function newChat() { if (busy) return; conversationId = crypto.randomUUID(); ls.set('conversationId', conversationId); hero(); refreshSide(); closeSide(); input.focus(); }

/* ---------- wiring ---------- */
$('form').addEventListener('submit', (e) => { e.preventDefault(); busy ? ctrl?.abort() : submit(); });
input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); } });
input.addEventListener('input', () => { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 180) + 'px'; });
$('new').onclick = newChat;
$('newlabel').innerHTML = `${ico('plus')} New chat`; $('export').innerHTML = `${ico('down', 13)} Export`; $('burger').innerHTML = ico('menu', 18); $('srcclose').innerHTML = ico('x', 16); sendBtn.innerHTML = ico('up', 16);
$('export').onclick = () => { location.href = '/api/export'; };
const help = $('help'); $('helpbtn').onclick = () => help.showModal();
$('tab-chats').onclick = () => setTab('chats'); $('tab-mem').onclick = () => setTab('mem');
$('srcclose').onclick = closePanel;
$('burger').onclick = () => document.body.classList.add('open'); $('scrim').onclick = closeSide;
document.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); newChat(); } else if (e.key === 'Escape') closePanel(); else if (e.key === '?' && !/^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) { e.preventDefault(); help.showModal(); } else if (e.key === '/' && document.activeElement !== input) { e.preventDefault(); input.focus(); } });

fetch('/api/health').then(r => r.json()).then(h => { health = h;
  $('modeltxt').textContent = `${h.model} · ${h.search}`; $('helpbtn').title = `${h.name} v${h.version}: shortcuts and how it works`; document.title = h.name; document.querySelectorAll('.brandname').forEach(el => { el.textContent = h.name; }); $('dot').classList.toggle('bad', !h.ok);
  if (!h.ok) { const b = $('banner'); b.style.display = 'block'; b.textContent = 'Missing ' + h.missing.join(', ') + ' — add it to .env and restart.'; }
}).catch(() => { $('modeltxt').textContent = 'offline'; $('dot').classList.add('bad'); });
loadHistory(); refreshSide();
