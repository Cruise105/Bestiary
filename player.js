// Player view: a read-only screen for the table. Shows HP as stages, never numbers.
// Fed by the combat tracker running in another window on the same device.
(function () {
  const KEY = 'bestiary-player';
  const wrap = document.getElementById('wrap');
  const STAGES = {
    unhurt: ['Unhurt', 4], wounded: ['Wounded', 3], bloodied: ['Bloodied', 2], near: ['Near death', 1],
    down: ['Down', 0], dying: ['Dying', 0], stable: ['Stable', 0], dead: ['Dead', 0],
  };
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let lastAt = 0;

  function segs(stage) {
    const n = (STAGES[stage] || ['', 0])[1];
    return `<span class="segs" aria-hidden="true">${[0, 1, 2, 3].map(i => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</span>`;
  }

  function entry(r, inner = false) {
    const [word] = STAGES[r.stage] || [''];
    const conds = r.conds?.length ? `<span class="conds">${r.conds.map(c => `<span>${esc(c)}</span>`).join('')}</span>` : '';
    if (inner) return `<li class="row ${r.side} s-${r.stage}"><span class="name">${esc(r.name)}</span>
      <span class="stage">${segs(r.stage)}<span class="word">${word}</span></span>${conds}</li>`;
    const mark = r.status === 'current' ? '▶' : r.status === 'acted' ? '✓' : '';
    return `<li class="row ${r.side} s-${r.stage} ${r.status || ''}">
      <span class="mark" aria-hidden="true">${mark}</span>
      <span class="name">${esc(r.name)}</span>
      <span class="stage">${segs(r.stage)}<span class="word">${word}</span></span>${conds}</li>`;
  }

  function group(g) {
    const mark = g.status === 'current' ? '▶' : g.status === 'acted' ? '✓' : '';
    return `<li class="row foe ${g.status || ''}">
      <span class="mark" aria-hidden="true">${mark}</span>
      <span class="name">${esc(g.name)}</span><span></span>
      <ol class="members">${g.members.map(m => entry(m, true)).join('')}</ol></li>`;
  }

  function render(s) {
    if (!s || !s.rows || !s.rows.length) {
      wrap.innerHTML = '<div class="idle"><div><b>Waiting for combat</b>Start a fight in the Bestiary\'s combat tracker.</div></div>';
      return;
    }
    const header = s.started
      ? `<span class="round">Round ${s.round}</span>
         <span class="up">${s.up ? `Up now: <b>${esc(s.up)}</b>` : s.lair ? '' : (s.mode === 'active' ? 'Choosing who goes next…' : '')}</span>
         ${s.lair ? '<span class="lairban">The lair stirs…</span>' : ''}`
      : '<span class="round">Combat is starting</span><span class="up">Get ready…</span>';
    // Count rows (group members take space too) to decide on one or two columns
    const weight = s.rows.reduce((n, r) => n + (r.group ? 1 + r.members.length * 0.6 : 1), 0);
    const cols = weight > 9 ? 2 : 1;
    wrap.innerHTML = `<header>${header}</header>
      <ol class="list" style="column-count:${cols}">
        ${s.rows.map(r => (r.group ? group(r) : entry(r))).join('')}
      </ol>`;
  }

  function take(s) {
    if (!s || s.at < lastAt) return;
    lastAt = s.at;
    render(s);
  }

  function readStored() {
    try { take(JSON.parse(localStorage.getItem(KEY) || 'null')); } catch { /* storage blocked */ }
  }

  try { new BroadcastChannel(KEY).onmessage = e => take(e.data); } catch { /* fall back to storage events */ }
  window.addEventListener('storage', e => { if (e.key === KEY) readStored(); });
  setInterval(readStored, 1500); // safety net if a message is missed
  readStored();

  // Keep the TV awake while this is open
  let lock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen'); } catch { /* not allowed */ }
  }
  keepAwake();
  document.addEventListener('visibilitychange', keepAwake);

  // Tap for full screen
  const hint = document.getElementById('hint');
  setTimeout(() => hint.classList.add('gone'), 6000);
  document.addEventListener('click', () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
    else document.exitFullscreen?.();
    hint.classList.add('gone');
  });
})();
