// Combat tracker: party roster, initiative, HP, conditions, legendary actions,
// monster spellcasting (slots or points with the table's strain rule), and
// the players' 5th/6th-level free-cast counters.
import { db } from './db.js';

const CONDITIONS = ['blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'];
const EXHAUSTION = ['', 'Disadvantage on ability checks', 'Speed halved', 'Disadvantage on attack rolls and saving throws',
  'Hit point maximum halved', 'Speed reduced to 0', 'Death'];
const SP_POOL = [0, 4, 6, 14, 17, 27, 32, 38, 44, 57, 64, 73, 73, 83, 83, 94, 94, 107, 114, 123, 133];
const SP_MAXLVL = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 9];
const SP_COST = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11, 9: 13 };
const ABIL_NAME = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' };
const ORD = n => n + (['th', 'st', 'nd', 'rd'][n] || 'th');
const FREE_CASTS = 3;

let ctx;          // helpers handed in by app.js
let root;         // #combatView
const cs = {      // combat state
  party: [],
  partyUpdated: 0,
  enc: { combatants: [], round: 0, turn: -1, started: false },
  sel: null,      // selected cid
};

const uid = () => 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const modOf = n => Math.floor((n - 10) / 2);
const sign = n => (n >= 0 ? '+' : '') + n;

/* ---------- persistence ---------- */
let saveTimer;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    db.setMeta('encounter', cs.enc);
    db.setMeta('party', { list: cs.party, updated: cs.partyUpdated });
  }, 150);
  ctx?.onChange?.();
}
function touchParty() { cs.partyUpdated = Date.now(); persist(); }

export async function loadCombat() {
  const [p, e] = await Promise.all([db.getMeta('party'), db.getMeta('encounter')]);
  if (p) { cs.party = p.list || []; cs.partyUpdated = p.updated || 0; }
  if (e) cs.enc = e;
}

export function partyForBackup() { return { list: cs.party, updated: cs.partyUpdated }; }
export async function mergePartyFromBackup(p) {
  if (!p || !Array.isArray(p.list)) return false;
  if ((p.updated || 0) <= cs.partyUpdated) return false;
  cs.party = p.list; cs.partyUpdated = p.updated;
  await db.setMeta('party', { list: cs.party, updated: cs.partyUpdated });
  render();
  return true;
}
export function combatantCount() { return cs.enc.combatants.length; }

/* ---------- model helpers ---------- */
const pc = id => cs.party.find(p => p.id === id);
// The record that holds HP/conditions: party member for players, the combatant itself for monsters
const rec = c => (c.kind === 'pc' ? pc(c.pcId) : c) || c;
const nameOf = c => rec(c).name || c.name;
const selected = () => cs.enc.combatants.find(c => c.cid === cs.sel);
const isDown = c => c.kind === 'monster' && rec(c).hp <= 0;

function newPc() {
  return { id: uid(), name: '', ac: 10, maxHp: 10, hp: 10, temp: 0, passive: 10, conds: [], exh: 0,
    conc: false, death: { s: 0, f: 0 }, strainOn: false, free: { 5: 0, 6: 0 }, notes: '' };
}

function saveBonus(m, abil) {
  const re = new RegExp(`\\b${abil}\\w*\\s*([+-]\\d+)`, 'i');
  const hit = (m.saves || '').match(re);
  if (hit) return +hit[1];
  return modOf(m[abil.toLowerCase()] ?? 10);
}

function fromMonster(m, n) {
  const sc = m.spellcasting;
  const lvl = Math.min(20, Math.max(0, +(sc?.level) || 0));
  const slots = {};
  Object.entries(sc?.slots || {}).forEach(([l, v]) => { if (+v > 0) slots[l] = { max: +v, used: 0 }; });
  return {
    cid: uid(), kind: 'monster', monsterId: m.id, name: n ? `${m.name} ${n}` : m.name, init: null,
    bonus: modOf(m.dex ?? 10), ac: parseInt(m.ac, 10) || 10, maxHp: +m.hp || 1, hp: +m.hp || 1, temp: 0,
    conds: [], exh: 0, conc: false, react: false,
    legMax: +m.legendaryCount || 0, legUsed: 0, lrMax: +m.legendaryResistance || 0, lrUsed: 0,
    caster: sc ? { abil: sc.ability || '', save: sc.ability ? saveBonus(m, sc.ability) : 0, level: lvl, spMax: SP_POOL[lvl], spUsed: 0, free: { 5: 0, 6: 0 }, slots, log: [] } : null,
    xp: +m.xp || 0,
  };
}

function sortOrder() {
  const cur = cs.enc.combatants[cs.enc.turn]?.cid;
  cs.enc.combatants.sort((a, b) => (b.init ?? -99) - (a.init ?? -99) || (b.bonus ?? 0) - (a.bonus ?? 0) || (a.kind === 'pc' ? -1 : 1) - (b.kind === 'pc' ? -1 : 1));
  if (cur) cs.enc.turn = cs.enc.combatants.findIndex(c => c.cid === cur);
}

/* ---------- public actions used by the library ---------- */
export function addMonsterToCombat(m, count = 1) {
  const existing = cs.enc.combatants.filter(c => c.monsterId === m.id);
  // Number copies once there's more than one of the same monster
  if (existing.length === 1 && !/\d+$/.test(existing[0].name) && count + existing.length > 1) existing[0].name = `${m.name} 1`;
  for (let i = 0; i < count; i++) {
    const n = existing.length + i + 1;
    cs.enc.combatants.push(fromMonster(m, existing.length + count > 1 ? n : 0));
  }
  if (cs.enc.started) sortOrder();
  persist(); render();
}

/* ---------- combat flow ---------- */
function ensurePartyInEncounter() {
  const out = cs.enc.sitOut || [];
  for (const p of cs.party) {
    if (out.includes(p.id)) continue;
    if (!cs.enc.combatants.some(c => c.pcId === p.id)) cs.enc.combatants.push({ cid: uid(), kind: 'pc', pcId: p.id, init: null, bonus: 0 });
  }
  // drop players removed from the roster
  cs.enc.combatants = cs.enc.combatants.filter(c => c.kind !== 'pc' || pc(c.pcId));
}

function startCombat() {
  const missing = cs.enc.combatants.filter(c => c.init == null);
  if (!cs.enc.combatants.length) return ctx.toast('Add monsters or players first.');
  if (missing.length) return ctx.toast(`Enter initiative for ${missing.map(nameOf).slice(0, 3).join(', ')}${missing.length > 3 ? '…' : ''}`);
  sortOrder();
  cs.enc.started = true; cs.enc.round = 1; cs.enc.turn = 0;
  beginTurn(cs.enc.combatants[0]);
  cs.sel = cs.enc.combatants[0].cid;
  persist(); render();
}

function beginTurn(c) {
  // Legendary actions and reactions come back at the start of a creature's own turn
  c.legUsed = 0; c.react = false;
}

function nextTurn(dir = 1) {
  const list = cs.enc.combatants;
  if (!list.length) return;
  let i = cs.enc.turn, guard = 0;
  do {
    i += dir;
    if (i >= list.length) { i = 0; cs.enc.round++; }
    if (i < 0) { i = list.length - 1; cs.enc.round = Math.max(1, cs.enc.round - 1); }
    guard++;
  } while (isDown(list[i]) && guard <= list.length);
  cs.enc.turn = i;
  if (dir > 0) beginTurn(list[i]);
  cs.sel = list[i].cid;
  persist(); render();
  root.querySelector('.crow[aria-current="step"]')?.scrollIntoView({ block: 'nearest' });
}

async function endCombat() {
  const mons = cs.enc.combatants.filter(c => c.kind === 'monster');
  const down = mons.filter(isDown);
  const xp = down.reduce((s, c) => s + (c.xp || 0), 0);
  const body = mons.length
    ? `${down.length} of ${mons.length} monsters defeated, worth ${xp.toLocaleString()} XP${cs.party.length ? ` (${Math.floor(xp / cs.party.length).toLocaleString()} each for ${cs.party.length} players)` : ''}. Monsters are cleared; players keep their current HP and conditions.`
    : 'Players keep their current HP and conditions.';
  if (!await ctx.confirmBox('End combat?', body, 'End combat')) return;
  cs.enc = { combatants: [], round: 0, turn: -1, started: false, sitOut: [] };
  cs.party.forEach(p => { p.conc = false; });
  cs.sel = null;
  touchParty(); persist(); render();
}

/* ---------- HP + conditions ---------- */
function applyHp(c, kind, amount) {
  const r = rec(c);
  if (!(amount > 0)) return ctx.toast('Type an amount first.');
  if (kind === 'damage') {
    let left = amount;
    if (r.temp > 0) { const t = Math.min(r.temp, left); r.temp -= t; left -= t; }
    const wasZero = r.hp <= 0;
    r.hp = Math.max(0, r.hp - left);
    if (c.kind === 'pc' && wasZero && left > 0) ctx.toast(`${r.name} takes damage at 0 HP: mark a death save failure (two if it was a critical hit).`);
    else if (r.conc) ctx.toast(`Concentration check for ${nameOf(c)}: Constitution save, DC ${Math.max(10, Math.floor(amount / 2))}.`);
  } else if (kind === 'heal') {
    if (r.hp <= 0 && r.death) r.death = { s: 0, f: 0 };
    r.hp = Math.min(r.maxHp, r.hp + amount);
  } else if (kind === 'temp') {
    r.temp = Math.max(r.temp, amount); // temp HP doesn't stack
  }
  if (c.kind === 'pc') touchParty();
  persist(); render();
}

/* ---------- spellcasting ---------- */
function castMonster(c, lvl) {
  const k = c.caster;
  const cost = SP_COST[lvl];
  if (k.spMax - k.spUsed < cost) return ctx.toast(`Not enough spell points for a ${ORD(lvl)}-level spell (${cost} needed).`);
  const spend = (strain) => {
    k.spUsed += cost;
    k.log.push({ lvl, cost, freeUsed: strain === 'free', exh: strain === 'failed' ? Math.floor(lvl / 2) : 0 });
    if (strain === 'free') k.free[lvl]++;
    if (strain === 'failed') c.exh = Math.min(6, c.exh + Math.floor(lvl / 2));
    persist(); render();
    if (strain === 'failed') exhaustionToast(c);
  };
  if ((lvl === 5 || lvl === 6) && k.free[lvl] < FREE_CASTS) return spend('free');
  if (lvl >= 5) {
    const bonus = k.abil ? `${nameOf(c)}'s ${ABIL_NAME[k.abil] || k.abil} save bonus is ${sign(k.save)}.` : '';
    return strainPrompt(c, lvl, bonus, spend);
  }
  spend('none');
}

function strainPrompt(c, lvl, extra, done) {
  const abil = c.kind === 'pc' ? 'spellcasting ability' : (ABIL_NAME[c.caster?.abil] || 'spellcasting ability');
  const why = lvl >= 7 ? `${ORD(lvl)}-level spells always need the save.` : `All ${FREE_CASTS} free ${ORD(lvl)}-level casts are used.`;
  ctx.choice(`${ORD(lvl)}-level spell: strain save`,
    `${why} Roll ${/^[AEIOU]/i.test(abil) ? 'an' : 'a'} ${abil} saving throw, DC ${10 + lvl}. ${extra} The spell is cast either way; a failure adds ${Math.floor(lvl / 2)} level${Math.floor(lvl / 2) === 1 ? '' : 's'} of exhaustion.`,
    [['success', 'Success'], ['failed', 'Failed']]).then(v => { if (v) done(v); });
}

function exhaustionToast(c) {
  const r = rec(c);
  if (r.exh >= 6) ctx.toast(`${nameOf(c)} reaches exhaustion 6 and dies.`);
  else ctx.toast(`${nameOf(c)} is now at exhaustion ${r.exh}: ${EXHAUSTION[r.exh].toLowerCase()} (and everything below).`);
}

function undoCast(c) {
  const k = c.caster; const last = k.log.pop();
  if (!last) return;
  k.spUsed -= last.cost;
  if (last.freeUsed) k.free[last.lvl]--;
  if (last.exh) c.exh = Math.max(0, c.exh - last.exh);
  persist(); render(); ctx.toast(`Undid the ${ORD(last.lvl)}-level cast.`);
}

function castPcHigh(c, lvl) {
  const p = rec(c);
  if (p.free[lvl] < FREE_CASTS) { p.free[lvl]++; touchParty(); render(); return; }
  strainPrompt(c, lvl, '', v => {
    if (v === 'failed') { p.exh = Math.min(6, p.exh + Math.floor(lvl / 2)); exhaustionToast(c); }
    touchParty(); render();
  });
}

/* ---------- rendering ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const pips = (n, used, act, extra = '', label = '') =>
  Array.from({ length: n }, (_, i) => `<button type="button" class="pip${i < used ? ' on' : ''}" data-c="${act}" data-i="${i}" ${extra} aria-label="${label} ${i + 1}${i < used ? ', used' : ''}"></button>`).join('');

export function render() {
  if (!root) return;
  ensurePartyInEncounter();
  const e = cs.enc;
  if (!cs.sel && e.combatants.length) cs.sel = e.combatants[0].cid;
  root.innerHTML = `
    <div class="cbar">
      ${e.started
        ? `<span class="round">Round ${e.round}</span>
           <button class="btn" type="button" data-c="prev">Previous</button>
           <button class="btn primary big" type="button" data-c="next">Next turn</button>`
        : `<span class="round">Setting up</span>
           <button class="btn primary big" type="button" data-c="start">Start combat</button>`}
      <span class="spacer"></span>
      ${(e.sitOut || []).map(id => pc(id)).filter(Boolean).map(p => `<button class="btn ghost" type="button" data-c="return" data-pid="${p.id}">Bring back ${esc(p.name)}</button>`).join('')}
      <button class="btn" type="button" data-c="addmon">Add monsters</button>
      <button class="btn" type="button" data-c="party">Party</button>
      ${e.combatants.some(c => c.kind === 'monster') || e.started ? '<button class="btn danger" type="button" data-c="end">End combat</button>' : ''}
    </div>
    <div class="cmain">
      <ol class="clist" aria-label="Initiative order">${e.combatants.map(rowHtml).join('') || `<li class="cempty">No one here yet. Add your players under Party, then add monsters from the library or with Add monsters.</li>`}</ol>
      <section class="cdetail" aria-live="polite">${detailHtml()}</section>
    </div>`;
}

function rowHtml(c, i) {
  const r = rec(c); const e = cs.enc;
  const cur = e.started && i === e.turn;
  const hpPct = r.maxHp ? Math.max(0, Math.min(100, Math.round(r.hp / r.maxHp * 100))) : 0;
  const state = r.exh >= 6 ? 'dead' : (r.hp <= 0 ? (c.kind === 'pc' ? 'dying' : 'down') : '');
  const chips = [...(r.conds || []), r.exh ? `exhaustion ${r.exh}` : '', r.conc ? 'concentrating' : ''].filter(Boolean);
  return `<li class="crow ${c.kind} ${state}" ${cur ? 'aria-current="step"' : ''} ${c.cid === cs.sel ? 'data-sel="1"' : ''}>
    <button type="button" class="cpick" data-c="sel" data-cid="${c.cid}">
      <span class="turnmark" aria-hidden="true">${cur ? '▶' : ''}</span>
      <span class="cinit">${e.started || c.init != null ? (c.init ?? '–') : ''}</span>
      <span class="cname">${esc(nameOf(c))}${state === 'down' ? ' <small>down</small>' : state === 'dying' ? ' <small>at 0 HP</small>' : state === 'dead' ? ' <small>dead</small>' : ''}</span>
      <span class="cac">AC ${esc(r.ac)}</span>
      <span class="chp"><b>${r.hp}</b>/${r.maxHp}${r.temp ? ` <i>+${r.temp}</i>` : ''}</span>
      <span class="hpbar" aria-hidden="true"><span style="width:${hpPct}%"></span></span>
      ${chips.length ? `<span class="chips">${chips.map(x => `<span>${esc(x)}</span>`).join('')}</span>` : ''}
    </button>
    ${!e.started ? `<label class="initin">Init<input type="number" inputmode="numeric" data-c="init" data-cid="${c.cid}" value="${c.init ?? ''}" placeholder="${c.kind === 'monster' ? sign(c.bonus) : ''}" aria-label="Initiative for ${esc(nameOf(c))}"></label>` : ''}
  </li>`;
}

function detailHtml() {
  const c = selected();
  if (!c) return `<div class="empty"><h2>Run a fight</h2><p>Your party joins every combat automatically. Add monsters, enter everyone's initiative, then Start combat.</p></div>`;
  const r = rec(c); const e = cs.enc;
  const sections = [];

  sections.push(`<div class="dhead">
    <button class="btn back" type="button" data-c="back">Back to order</button>
    <h2>${esc(nameOf(c))}</h2>
    <p class="dsub">${c.kind === 'pc' ? `Player · Passive Perception ${esc(r.passive)}` : `Initiative bonus ${sign(c.bonus)}`}${e.started ? ` · Initiative <input class="mini" type="number" inputmode="numeric" data-c="init" data-cid="${c.cid}" value="${c.init ?? ''}" aria-label="Initiative">` : ''}</p>
  </div>`);

  // HP
  sections.push(`<div class="dbox hpbox">
    <div class="hpbig"><span class="hpnow">${r.hp}</span><span class="hpmax">/ ${r.maxHp}</span>${r.temp ? `<span class="hptemp">+${r.temp} temp</span>` : ''}</div>
    <div class="hpctl">
      <input class="field" id="hpAmt" type="number" inputmode="numeric" min="0" placeholder="Amount" aria-label="Amount">
      <button class="btn dmg" type="button" data-c="damage">Damage</button>
      <button class="btn heal" type="button" data-c="heal">Heal</button>
      <button class="btn" type="button" data-c="temp">Temp HP</button>
    </div>
    <div class="hpedit">
      <label>AC <input class="mini" type="number" inputmode="numeric" data-c="setac" value="${esc(r.ac)}"></label>
      <label>Max HP <input class="mini" type="number" inputmode="numeric" data-c="setmax" value="${r.maxHp}"></label>
    </div>
  </div>`);

  // Death saves (players at 0)
  if (c.kind === 'pc' && r.hp <= 0 && r.exh < 6) {
    sections.push(`<div class="dbox"><h3>Death saves</h3>
      <div class="pipsrow"><span>Successes</span>${pips(3, r.death.s, 'ds', '', 'Success')}</div>
      <div class="pipsrow"><span>Failures</span>${pips(3, r.death.f, 'df', '', 'Failure')}</div>
      ${r.death.s >= 3 ? '<p class="note">Stable at 0 HP.</p>' : r.death.f >= 3 ? '<p class="note">Three failures: dead.</p>' : ''}
    </div>`);
  }

  // Turn economy
  if (c.kind === 'monster') {
    const bits = [`<div class="pipsrow"><span>Reaction</span><button type="button" class="pip${c.react ? ' on' : ''}" data-c="react" aria-label="Reaction ${c.react ? 'used' : 'available'}"></button></div>`];
    if (c.legMax) bits.push(`<div class="pipsrow"><span>Legendary actions</span>${pips(c.legMax, c.legUsed, 'leg', '', 'Legendary action')}</div>`);
    if (c.lrMax) bits.push(`<div class="pipsrow"><span>Legendary resistance</span>${pips(c.lrMax, c.lrUsed, 'lr', '', 'Legendary resistance')}</div>`);
    sections.push(`<div class="dbox"><h3>Actions</h3>${bits.join('')}<p class="note">Reaction and legendary actions come back at the start of its turn.</p></div>`);
  }

  // Conditions
  sections.push(`<div class="dbox"><h3>Conditions</h3>
    <div class="condgrid">${CONDITIONS.map(k => `<button type="button" class="cond${(r.conds || []).includes(k) ? ' on' : ''}" data-c="cond" data-k="${k}" aria-pressed="${(r.conds || []).includes(k)}">${k}</button>`).join('')}
      <button type="button" class="cond${r.conc ? ' on' : ''}" data-c="conc" aria-pressed="${!!r.conc}">concentrating</button>
    </div>
    <div class="exhrow">
      <span>Exhaustion</span>
      <button class="btn icon" type="button" data-c="exh" data-d="-1" aria-label="Less exhaustion">−</button>
      <b class="exhn">${r.exh}</b>
      <button class="btn icon" type="button" data-c="exh" data-d="1" aria-label="More exhaustion">+</button>
      <span class="exhtxt">${r.exh ? esc(EXHAUSTION[r.exh]) + (r.exh > 1 && r.exh < 6 ? ', plus everything below' : '') : 'None'}</span>
    </div>
  </div>`);

  // Spellcasting
  if (c.kind === 'monster' && c.caster) sections.push(monsterSpellsHtml(c));
  if (c.kind === 'pc' && r.strainOn) sections.push(pcFreeCastsHtml(c));

  // Notes for players, stat block for monsters
  if (c.kind === 'pc') {
    sections.push(`<div class="dbox"><h3>Notes</h3><textarea class="field" data-c="pcnotes" rows="3" placeholder="Anything to remember about this character">${esc(r.notes || '')}</textarea></div>`);
  } else {
    const m = ctx.getMonster(c.monsterId);
    sections.push(`<div class="dbox sbwrap">${m ? ctx.statBlockHtml(m) : '<p class="note">This monster is no longer in your library.</p>'}</div>`);
  }
  sections.push(`<div class="drow"><button class="btn danger" type="button" data-c="remove">${c.kind === 'pc' ? 'Sit out this combat' : 'Remove from combat'}</button></div>`);
  return sections.join('');
}

function monsterSpellsHtml(c) {
  const k = c.caster;
  if (ctx.settings().spellMode === 'points') {
    if (!k.level) return `<div class="dbox"><h3>Spell points</h3><p class="note">This monster has no caster level set, so there's no pool. Add one in the library editor.</p></div>`;
    const max = SP_MAXLVL[k.level];
    const left = k.spMax - k.spUsed;
    const btns = Object.keys(SP_COST).map(Number).filter(l => l <= max).map(l => {
      const tag = l === 5 || l === 6 ? (k.free[l] < FREE_CASTS ? `${FREE_CASTS - k.free[l]} free` : 'save') : l >= 7 ? 'save' : '';
      return `<button class="btn cast" type="button" data-c="cast" data-l="${l}" ${left < SP_COST[l] ? 'disabled' : ''}><b>${ORD(l)}</b><span>${SP_COST[l]} pts${tag ? ` · ${tag}` : ''}</span></button>`;
    }).join('');
    return `<div class="dbox"><h3>Spell points</h3>
      <div class="spbar"><span class="spnow">${left}</span><span class="spmax">/ ${k.spMax}</span>
        <span class="sbar" aria-hidden="true"><span style="width:${k.spMax ? Math.round(left / k.spMax * 100) : 0}%"></span></span></div>
      <div class="castgrid">${btns}</div>
      <div class="drow">${k.log.length ? `<button class="btn" type="button" data-c="undocast">Undo last cast</button>` : ''}
        <span class="note">Spell save DC ${esc(ctx.getMonster(c.monsterId)?.spellcasting?.dc ?? '—')}${k.abil ? ` · ${ABIL_NAME[k.abil]} save ${sign(k.save)}` : ''}</span></div>
    </div>`;
  }
  const levels = Object.keys(k.slots).map(Number).sort((a, b) => a - b);
  if (!levels.length) return `<div class="dbox"><h3>Spell slots</h3><p class="note">No slots listed. Innate spells are tracked on the stat block.</p></div>`;
  return `<div class="dbox"><h3>Spell slots</h3>
    ${levels.map(l => `<div class="pipsrow"><span>${ORD(l)}</span>${pips(k.slots[l].max, k.slots[l].used, 'slot', `data-l="${l}"`, `${ORD(l)}-level slot`)}</div>`).join('')}
  </div>`;
}

function pcFreeCastsHtml(c) {
  const p = rec(c);
  const row = l => `<div class="pipsrow"><span>${ORD(l)} level</span>${pips(FREE_CASTS, p.free[l], 'free', `data-l="${l}"`, `Free ${ORD(l)}-level cast`)}
    <button class="btn" type="button" data-c="pccast" data-l="${l}">Cast ${ORD(l)}</button></div>`;
  return `<div class="dbox"><h3>Free high-level casts</h3>${row(5)}${row(6)}
    <p class="note">Tap Cast when they cast one. After three, it prompts the strain save (DC ${15} or ${16}). Resets on a long rest.</p></div>`;
}

/* ---------- party dialog ---------- */
function renderParty() {
  const body = document.querySelector('#partyBody');
  body.innerHTML = cs.party.length ? cs.party.map(p => `<div class="prow" data-id="${p.id}">
      <label class="f wide2">Name<input class="field" data-p="name" value="${esc(p.name)}" placeholder="Character name"></label>
      <label class="f">AC<input class="field" data-p="ac" type="number" inputmode="numeric" value="${p.ac}"></label>
      <label class="f">Max HP<input class="field" data-p="maxHp" type="number" inputmode="numeric" value="${p.maxHp}"></label>
      <label class="f">Passive Perc.<input class="field" data-p="passive" type="number" inputmode="numeric" value="${p.passive}"></label>
      <label class="chk"><input type="checkbox" data-p="strainOn" ${p.strainOn ? 'checked' : ''}> Track free 5th/6th casts</label>
      <button class="btn danger" type="button" data-pa="del">Remove</button>
    </div>`).join('') : '<p class="note">No players yet. Add your party once and they join every combat.</p>';
}

function readParty() {
  document.querySelectorAll('#partyBody .prow').forEach(row => {
    const p = pc(row.dataset.id); if (!p) return;
    row.querySelectorAll('[data-p]').forEach(el => {
      const k = el.dataset.p;
      if (k === 'strainOn') p.strainOn = el.checked;
      else if (k === 'name') p.name = el.value.trim();
      else {
        const v = +el.value || 0;
        if (k === 'maxHp' && v !== p.maxHp) { if (p.hp === p.maxHp || p.hp > v) p.hp = v; }
        p[k] = v;
      }
    });
  });
  cs.party = cs.party.filter(p => p.name || p.id);
  touchParty();
}

async function longRest() {
  if (!await ctx.confirmBox('Long rest for the party?', 'Everyone returns to full HP, temporary HP and death saves clear, exhaustion drops by 1, concentration ends, and free 5th/6th-level casts reset. Conditions stay as they are.', 'Long rest')) return;
  cs.party.forEach(p => {
    p.hp = p.maxHp; p.temp = 0; p.death = { s: 0, f: 0 }; p.exh = Math.max(0, p.exh - 1); p.conc = false; p.free = { 5: 0, 6: 0 };
  });
  touchParty(); renderParty(); render(); ctx.toast('Long rest done.');
}

/* ---------- add monsters dialog ---------- */
function renderAddList() {
  const q = document.querySelector('#addQ').value.trim().toLowerCase();
  const list = ctx.allMonsters()
    .filter(m => !q || m.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const ra = a.name.toLowerCase().startsWith(q) ? 0 : 1, rb = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return ra - rb || a.name.localeCompare(b.name);
    }).slice(0, 60);
  document.querySelector('#addList').innerHTML = list.map(m => `<li>
    <span class="nm">${esc(m.name)}</span><span class="meta">CR ${esc(m.cr)} · ${esc(m.source || '')}</span>
    <span class="addctl">
      <select aria-label="How many">${[1, 2, 3, 4, 5, 6, 8, 10].map(n => `<option>${n}</option>`).join('')}</select>
      <button class="btn primary" type="button" data-add="${esc(m.id)}">Add</button>
    </span></li>`).join('') || '<li class="note">No matches.</li>';
}

/* ---------- events ---------- */
function onClick(e) {
  const b = e.target.closest('[data-c]');
  if (!b || b.tagName === 'INPUT' || b.tagName === 'TEXTAREA') return;
  const act = b.dataset.c;
  const c = selected(); const r = c && rec(c);
  const i = +b.dataset.i;
  const toggleCount = (cur, idx) => (idx < cur ? idx : idx + 1); // tap a filled pip to clear back to it
  switch (act) {
    case 'start': return startCombat();
    case 'next': return nextTurn(1);
    case 'prev': return nextTurn(-1);
    case 'end': return endCombat();
    case 'party': renderParty(); return document.querySelector('#partyDlg').showModal();
    case 'addmon': document.querySelector('#addQ').value = ''; renderAddList(); document.querySelector('#addDlg').showModal(); return;
    case 'sel': cs.sel = b.dataset.cid; render(); if (root.dataset.view !== 'detail') ctx.pushDetail(); root.dataset.view = 'detail'; root.querySelector('.cdetail').scrollTop = 0; return;
    case 'back': history.state?.view === 'cdetail' ? history.back() : (root.dataset.view = 'list'); return;
    case 'return': cs.enc.sitOut = (cs.enc.sitOut || []).filter(id => id !== b.dataset.pid); persist(); render(); return;
  }
  if (!c) return;
  const amt = +root.querySelector('#hpAmt')?.value;
  switch (act) {
    case 'damage': case 'heal': case 'temp': return applyHp(c, act, amt);
    case 'cond': {
      const k = b.dataset.k; r.conds = r.conds || [];
      r.conds = r.conds.includes(k) ? r.conds.filter(x => x !== k) : [...r.conds, k];
      break;
    }
    case 'conc': r.conc = !r.conc; break;
    case 'exh': r.exh = Math.max(0, Math.min(6, r.exh + +b.dataset.d)); if (+b.dataset.d > 0) exhaustionToast(c); break;
    case 'react': c.react = !c.react; break;
    case 'leg': c.legUsed = toggleCount(c.legUsed, i); break;
    case 'lr': c.lrUsed = toggleCount(c.lrUsed, i); break;
    case 'ds': r.death.s = toggleCount(r.death.s, i); break;
    case 'df': r.death.f = toggleCount(r.death.f, i); break;
    case 'slot': { const s = c.caster.slots[b.dataset.l]; s.used = toggleCount(s.used, i); break; }
    case 'cast': return castMonster(c, +b.dataset.l);
    case 'undocast': return undoCast(c);
    case 'free': r.free[b.dataset.l] = toggleCount(r.free[b.dataset.l], i); break;
    case 'pccast': return castPcHigh(c, +b.dataset.l);
    case 'remove': {
      const idx = cs.enc.combatants.findIndex(x => x.cid === c.cid);
      cs.enc.combatants.splice(idx, 1);
      if (c.kind === 'pc') cs.enc.sitOut = [...(cs.enc.sitOut || []), c.pcId];
      if (idx < cs.enc.turn) cs.enc.turn--;
      if (cs.enc.turn >= cs.enc.combatants.length) cs.enc.turn = 0;
      cs.sel = null; root.dataset.view = 'list';
      break;
    }
    default: return;
  }
  if (c.kind === 'pc') touchParty();
  persist(); render();
}

function onChange(e) {
  const el = e.target; const act = el.dataset.c;
  if (!act) return;
  if (act === 'init') {
    const c = cs.enc.combatants.find(x => x.cid === el.dataset.cid);
    if (!c) return;
    c.init = el.value === '' ? null : +el.value;
    if (cs.enc.started) { sortOrder(); render(); }
    persist();
    return;
  }
  const c = selected(); if (!c) return; const r = rec(c);
  if (act === 'setac') r.ac = +el.value || 0;
  if (act === 'setmax') { const v = Math.max(1, +el.value || 1); if (r.hp > v || r.hp === r.maxHp) r.hp = v; r.maxHp = v; }
  if (act === 'pcnotes') r.notes = el.value;
  if (c.kind === 'pc') touchParty();
  persist(); if (act !== 'pcnotes') render();
}

export function initCombat(helpers) {
  ctx = helpers;
  root = document.querySelector('#combatView');
  root.dataset.view = 'list';
  root.addEventListener('click', onClick);
  root.addEventListener('change', onChange);
  root.addEventListener('keydown', e => {
    if (e.key === 'Enter' && e.target.id === 'hpAmt') { e.preventDefault(); applyHp(selected(), 'damage', +e.target.value); }
  });

  // Party dialog
  const pd = document.querySelector('#partyDlg');
  pd.addEventListener('click', e => {
    const b = e.target.closest('[data-pa]'); if (!b) return;
    readParty();
    if (b.dataset.pa === 'add') { cs.party.push(newPc()); renderParty(); pd.querySelector('.prow:last-child [data-p="name"]')?.focus(); }
    if (b.dataset.pa === 'del') {
      const id = b.closest('.prow').dataset.id;
      cs.party = cs.party.filter(p => p.id !== id);
      cs.enc.combatants = cs.enc.combatants.filter(c => c.pcId !== id);
      touchParty(); renderParty();
    }
    if (b.dataset.pa === 'rest') longRest();
  });
  pd.addEventListener('close', () => {
    readParty();
    cs.party = cs.party.filter(p => p.name);
    touchParty(); render();
  });

  // Add monsters dialog
  const ad = document.querySelector('#addDlg');
  document.querySelector('#addQ').addEventListener('input', renderAddList);
  ad.addEventListener('click', e => {
    const b = e.target.closest('[data-add]'); if (!b) return;
    const m = ctx.getMonster(b.dataset.add); if (!m) return;
    const n = +b.closest('li').querySelector('select').value;
    addMonsterToCombat(m, n);
    ctx.toast(`Added ${n} ${m.name}${n > 1 ? 's' : ''}`);
  });
}
