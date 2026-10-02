import { db } from './db.js';
import { initCombat, loadCombat, render as renderCombat, addMonsterToCombat, combatantCount, monsterCount, clearMonsters, setLoaded, partyForBackup, mergePartyFromBackup } from './combat.js';
import { initSync } from './sync.js';
import { initEncounters, loadEncounters, openEncounters, saveFromCombat, encountersForBackup, mergeEncountersFromBackup } from './encounters.js';
import { HP_BY_CR, blankMonster, detectSpellcasting, crNum, pbForCr, XP_BY_CR } from './parser.js';

const SRD_VERSION = 1;
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const CRS = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SECTIONS = [
  ['traits', 'Traits'], ['actions', 'Actions'], ['bonusActions', 'Bonus actions'],
  ['reactions', 'Reactions'], ['legendary', 'Legendary actions'], ['lair', 'Lair actions'],
];

const $ = s => document.querySelector(s);
const appEl = $('#app');
const listEl = $('#list');
const detailEl = $('#detail');

const state = {
  monsters: [],
  byId: new Map(),
  selectedId: null,
  editing: null,      // working copy while the editor is open
  dirty: false,
  settings: { theme: 'night', spellMode: 'slots', initMode: 'rolls', hpMode: 'block' },
  deletedSrd: [],     // [{id, at}]
  srdOriginals: null, // lazy-loaded for "revert"
  tab: 'stats',       // 'stats' | 'lore' on the monster page
};

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const mod = n => { const v = Math.floor((n - 10) / 2); return (v >= 0 ? '+' : '') + v; };
const fmtFormula = f => String(f || '').replace(/\s+/g, '').replace(/([+-])/g, ' $1 ');
const now = () => Date.now();
const uid = () => 'c-' + now().toString(36) + Math.random().toString(36).slice(2, 7);
const isNarrow = () => matchMedia('(max-width:820px)').matches;

function toast(msg) {
  document.querySelectorAll('.toast').forEach(x => x.remove());
  const t = document.createElement('div');
  t.className = 'toast'; t.setAttribute('role', 'status'); t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), Math.max(2600, msg.length * 55));
}

function confirmBox(title, body, yesLabel) {
  const dlg = $('#confirmDlg');
  $('#confirmTitle').textContent = title;
  $('#confirmBody').textContent = body;
  $('#confirmYes').textContent = yesLabel;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'yes'), { once: true }));
}

// Multi-button prompt; resolves with the chosen value, or '' if cancelled
function choice(title, body, buttons) {
  const dlg = $('#choiceDlg');
  $('#choiceTitle').textContent = title;
  $('#choiceBody').textContent = body;
  $('#choiceBtns').innerHTML = '<button class="btn" value="" type="submit">Cancel</button>'
    + buttons.map(([v, label], i) => `<button class="btn ${i === buttons.length - 1 ? 'primary' : ''}" value="${esc(v)}" type="submit">${esc(label)}</button>`).join('');
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue), { once: true }));
}

/* ---------- Library / Combat switch ---------- */
let mode = 'library';
function setMode(m) {
  mode = m;
  $('.main').hidden = m !== 'library';
  $('#combatView').hidden = m !== 'combat';
  document.querySelectorAll('.libonly').forEach(b => { b.hidden = m !== 'library'; });
  document.querySelectorAll('.modes button').forEach(b => b.setAttribute('aria-pressed', b.dataset.mode === m));
  if (m === 'combat') { $('#combatView').dataset.view = 'list'; renderCombat(); }
}
function updateBadge() {
  const n = combatantCount();
  const badge = $('#combatBadge');
  badge.hidden = !n; badge.textContent = n;
}

// One-line text prompt; resolves with the text, or null if cancelled
function promptBox(title, label, value = '', placeholder = '') {
  const dlg = $('#promptDlg');
  $('#promptTitle').textContent = title;
  $('#promptLabel').textContent = label;
  const inp = $('#promptInput'); inp.value = value; inp.placeholder = placeholder;
  dlg.returnValue = '';
  dlg.showModal(); inp.focus();
  return new Promise(res => dlg.addEventListener('close', () => res(dlg.returnValue === 'ok' ? inp.value.trim() : null), { once: true }));
}

function averageFromFormula(f) {
  const m = String(f).replace(/\s+/g, '').match(/^(\d+)d(\d+)([+-]\d+)?$/i);
  if (!m) return null;
  return Math.floor(+m[1] * (+m[2] + 1) / 2) + (+m[3] || 0);
}

/* ---------- data ---------- */
async function loadAll() {
  const [settings, deleted, seeded] = await Promise.all([db.getMeta('settings'), db.getMeta('deletedSrd'), db.getMeta('srdVersion')]);
  if (settings) Object.assign(state.settings, settings);
  state.deletedSrd = deleted || [];
  if ((seeded || 0) < SRD_VERSION) await seedSrd();
  setMonsters(await db.all());
}

async function seedSrd() {
  const srd = await fetch('srd-monsters.json').then(r => r.json());
  const existing = new Set((await db.all()).map(m => m.id));
  const gone = new Set(state.deletedSrd.map(d => d.id));
  const fresh = srd.filter(m => !existing.has(m.id) && !gone.has(m.id)).map(m => ({ ...m, created: 0, updated: 0 }));
  await db.putMany(fresh);
  await db.setMeta('srdVersion', SRD_VERSION);
}

async function srdOriginal(id) {
  if (!state.srdOriginals) {
    const srd = await fetch('srd-monsters.json').then(r => r.json());
    state.srdOriginals = new Map(srd.map(m => [m.id, m]));
  }
  return state.srdOriginals.get(id);
}

function setMonsters(list) {
  state.monsters = list;
  state.byId = new Map(list.map(m => [m.id, m]));
  buildFilterOptions();
  renderList();
}

async function saveMonster(m) {
  m.updated = now();
  if (!m.created) m.created = m.id.startsWith('srd-') ? 0 : m.updated;
  if (m.id.startsWith('srd-')) m.edited = true;
  await db.put(m);
  const i = state.monsters.findIndex(x => x.id === m.id);
  if (i >= 0) state.monsters[i] = m; else state.monsters.push(m);
  state.byId.set(m.id, m);
  buildFilterOptions();
}

async function saveSettings() {
  await db.setMeta('settings', state.settings);
}

/* ---------- filters + list ---------- */
function buildFilterOptions() {
  const types = [...new Set(state.monsters.map(m => (m.type || '').toLowerCase()).filter(Boolean))].sort();
  const sources = [...new Set(state.monsters.map(m => m.source).filter(Boolean))].sort();
  fill($('#fType'), 'All types', types);
  fill($('#fSource'), 'All sources', [...sources, '__mine']);
  fill($('#fSize'), 'All sizes', SIZES);
  $('#sourceList').innerHTML = sources.map(s => `<option value="${esc(s)}">`).join('');
}

function fill(sel, allLabel, values) {
  const cur = sel.value;
  sel.innerHTML = `<option value="">${allLabel}</option>` + values.map(v =>
    `<option value="${esc(v)}">${v === '__mine' ? 'My monsters and edits' : esc(v[0].toUpperCase() + v.slice(1))}</option>`).join('');
  sel.value = values.includes(cur) ? cur : '';
}

function initCrSelects() {
  $('#fCrMin').innerHTML = CRS.map(c => `<option>${c}</option>`).join('');
  $('#fCrMax').innerHTML = CRS.map(c => `<option>${c}</option>`).join('');
  $('#fCrMin').value = '0'; $('#fCrMax').value = '30';
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const type = $('#fType').value, src = $('#fSource').value, size = $('#fSize').value;
  const lo = crNum($('#fCrMin').value), hi = crNum($('#fCrMax').value);
  const sort = $('#fSort').value;
  let out = state.monsters.filter(m => {
    if (q && !(`${m.name} ${m.tags} ${m.source} ${m.type} ${m.subtype}`.toLowerCase().includes(q))) return false;
    if (type && (m.type || '').toLowerCase() !== type) return false;
    if (src === '__mine' ? !(m.edited || !m.id.startsWith('srd-')) : (src && m.source !== src)) return false;
    if (size && m.size !== size) return false;
    if (m.dead && $('#fHideDead').checked) return false;
    const c = crNum(m.cr);
    return c >= lo && c <= hi;
  });
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (q) {
    // Name matches float to the top: starts-with, then contains, then tag/type matches
    const rank = m => { const n = m.name.toLowerCase(); return n.startsWith(q) ? 0 : n.includes(q) ? 1 : 2; };
    const base = sort === 'cr' ? (a, b) => crNum(a.cr) - crNum(b.cr) || byName(a, b)
      : sort === 'updated' ? (a, b) => (b.updated || 0) - (a.updated || 0) || byName(a, b) : byName;
    return out.sort((a, b) => rank(a) - rank(b) || base(a, b));
  }
  if (sort === 'cr') out.sort((a, b) => crNum(a.cr) - crNum(b.cr) || byName(a, b));
  else if (sort === 'updated') out.sort((a, b) => (b.updated || 0) - (a.updated || 0) || byName(a, b));
  else out.sort(byName);
  return out;
}

function filtersActive() {
  return $('#q').value || $('#fType').value || $('#fSource').value || $('#fSize').value
    || $('#fCrMin').value !== '0' || $('#fCrMax').value !== '30' || $('#fHideDead').checked;
}

function renderList() {
  const items = filtered();
  $('#count').textContent = `${items.length} of ${state.monsters.length} monsters`;
  $('#clearFilters').hidden = !filtersActive();
  listEl.innerHTML = items.map(m => {
    const mine = !m.id.startsWith('srd-');
    const tag = (m.dead ? '<span class="tag deadtag">Dead</span>' : '') + (mine ? '<span class="tag">Mine</span>' : m.edited ? '<span class="tag">Edited</span>' : '');
    return `<li${m.dead ? ' class="isdead"' : ''}><button type="button" data-id="${esc(m.id)}" aria-current="${m.id === state.selectedId}">
      <span class="nm">${esc(m.name)}${tag}</span>
      <span class="cr">${esc(m.cr)}<small>CR</small></span>
      <span class="meta">${esc(m.size)} ${esc(m.type)} · ${esc(m.source || 'No source')}</span>
    </button></li>`;
  }).join('');
}

/* ---------- views ---------- */
function setView(view, push = true) {
  appEl.dataset.view = view;
  if (push && isNarrow()) history.pushState({ view }, '');
}

function select(id, push = true) {
  if (state.editing && state.dirty) return guardLeave(() => { state.editing = null; state.dirty = false; select(id, push); });
  state.editing = null;
  state.selectedId = id;
  listEl.querySelectorAll('button[aria-current]').forEach(b => b.setAttribute('aria-current', b.dataset.id === id));
  renderDetail();
  setView('detail', push);
  detailEl.scrollTop = 0;
}

async function guardLeave(proceed) {
  const ok = await confirmBox('Discard changes?', 'You have unsaved edits to this monster.', 'Discard');
  if (ok) proceed();
}

function renderDetail() {
  if (state.editing) return renderEditor();
  const m = state.byId.get(state.selectedId);
  if (!m) {
    detailEl.innerHTML = `<div class="empty"><h2>Pick a monster</h2>
      <p>Search or filter on the left, or add your own with New monster.</p></div>`;
    return;
  }
  const isSrd = m.id.startsWith('srd-');
  detailEl.innerHTML = `<div class="sb">
    <div class="sb-actions">
      <button class="btn back" type="button" data-act="back">Back to list</button>
      <span class="spacer"></span>
      <button class="btn primary" type="button" data-act="addcombat">Add to combat</button>
      <button class="btn" type="button" data-act="edit">Edit</button>
      <button class="btn" type="button" data-act="dup">Duplicate</button>
      ${isSrd && m.edited ? '<button class="btn" type="button" data-act="revert">Revert to SRD</button>' : ''}
      <button class="btn danger" type="button" data-act="delete">Delete</button>
    </div>
    <div class="tabrow">
    <div class="tabs" role="tablist" aria-label="Monster page">
      <button type="button" role="tab" data-act="tab" data-tab="stats" aria-selected="${state.tab === 'stats'}">Stat block</button>
      <button type="button" role="tab" data-act="tab" data-tab="lore" aria-selected="${state.tab === 'lore'}">Lore${hasLore(m) ? '<span class="dot" aria-label="has content"></span>' : ''}</button>
    </div>
    <label class="deadtoggle${m.dead ? ' on' : ''}"><input type="checkbox" data-act="dead" ${m.dead ? 'checked' : ''}> Dead</label>
    </div>
    ${state.tab === 'lore' ? loreHtml(m) : `${statBlockHtml(m)}
    ${m.notes ? `<div class="notes">${fmt(m.notes)}</div>` : ''}`}
    <p class="sb-foot">${esc(m.source || 'No source')}${m.tags ? ` · Tags: ${esc(m.tags)}` : ''}${m.updated ? ` · Edited ${new Date(m.updated).toLocaleDateString()}` : ''}</p>
  </div>`;
}

/* ---------- Lore tab ---------- */
const hasLore = m => !!(m.description || m.tactics || m.image);

function loreHtml(m) {
  if (!hasLore(m)) return `<div class="lore empty-lore"><p>No lore yet. Tap Edit to add a picture, combat tactics, or background for ${esc(m.name)}.</p></div>`;
  queueMicrotask(() => showImage(m, '#loreImg'));
  return `${deadBanner(m)}<article class="lore">
    ${m.image ? `<figure class="lorepic"><button type="button" class="picbtn" data-act="bigpic" aria-label="View picture full size"><img id="loreImg" alt="${esc(m.name)}"></button></figure>` : ''}
    ${m.tactics ? `<section class="lorebox tactics"><h3>Tactics</h3><p class="desc">${fmt(m.tactics)}</p></section>` : ''}
    ${m.description ? `<section class="lorebox"><h3>Lore</h3><div class="desc">${fmt(m.description)}</div></section>` : ''}
  </article>`;
}

async function showImage(m, sel) {
  const el = document.querySelector(sel);
  if (!el || !m.image) return;
  const rec = await db.getImage(m.id);
  if (rec) el.src = rec.data;
  else el.closest('figure')?.classList.add('pending');
}

// Shrink a picked photo so it stays small on the device and in sync
async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error("That file couldn't be opened as a picture.")); img.src = url; });
    const max = 1200;
    const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * s), h = Math.round(img.naturalHeight * s);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    cv.getContext('2d').drawImage(img, 0, 0, w, h);
    let out = cv.toDataURL('image/webp', 0.82);
    if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/jpeg', 0.82);
    return out;
  } finally { URL.revokeObjectURL(url); }
}

// DMG spell points variant (2014), with Cruise's high-level casting strain rule.
const SP_POOL = [0, 4, 6, 14, 17, 27, 32, 38, 44, 57, 64, 73, 73, 83, 83, 94, 94, 107, 114, 123, 133];
const SP_MAXLVL = [0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 9, 9];
const SP_COST = { 1: 2, 2: 3, 3: 5, 4: 6, 5: 7, 6: 9, 7: 10, 8: 11, 9: 13 };
const ORD = n => n + (['th', 'st', 'nd', 'rd'][n] || 'th');

function spellTrackingHtml(m) {
  const sc = m.spellcasting;
  if (!sc) return '';
  if (state.settings.spellMode === 'points') {
    const lvl = Math.min(20, Math.max(0, +sc.level || 0));
    if (!lvl) return `<div class="spelltrack"><p class="ln"><b>Spell Points</b> set a caster level in the editor to see this caster's pool.</p></div>`;
    const max = SP_MAXLVL[lvl];
    const costs = Object.entries(SP_COST).filter(([l]) => +l <= max).map(([l, c]) => `${ORD(+l)} ${c}`).join(', ');
    const strain = [];
    const abil = { INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' }[sc.ability] || 'spellcasting ability';
    if (max >= 5) strain.push(`${max >= 6 ? '5th and 6th level: 3 free casts of each per long rest' : '5th level: 3 free casts per long rest'}; after that, each cast needs ${/^[AEIOU]/.test(abil) ? "an" : "a"} ${abil} saving throw (DC 10 + spell level), and a failure adds exhaustion equal to half the spell's level, rounded down`);
    if (max >= 7) strain.push('7th level and higher: that save applies to every cast, including the first');
    return `<div class="spelltrack">
      <p class="ln"><b>Spell Points</b> ${SP_POOL[lvl]} (${ORD(lvl)}-level caster; spells up to ${ORD(max)} level)</p>
      <p class="ln"><b>Cost</b> ${costs}</p>
      ${strain.length ? `<p class="ln"><b>Strain</b> ${strain.join('. ')}.</p>` : ''}
    </div>`;
  }
  const slots = Object.entries(sc.slots || {}).filter(([, n]) => +n > 0).map(([l, n]) => `${ORD(+l)} ${n}`).join(', ');
  return slots ? `<div class="spelltrack"><p class="ln"><b>Spell Slots</b> ${slots}</p></div>` : '';
}

// Traits, with the spell tracking box placed right after the Spellcasting trait
function traitsHtml(m) {
  const traits = m.traits || [];
  const box = spellTrackingHtml(m);
  if (!traits.length) return box ? '<hr class="taper">' + box : '';
  let idx = traits.findIndex(t => /spellcasting/i.test(t.name) && !/innate/i.test(t.name));
  if (idx < 0) idx = traits.findIndex(t => /spellcasting/i.test(t.name));
  const parts = traits.map(entryHtml);
  if (box) parts.splice(idx < 0 ? parts.length : idx + 1, 0, box);
  return '<hr class="taper">' + parts.join('');
}

// Light formatting you can type: *italic* and **bold**
function fmt(text) {
  return esc(text)
    .replace(/\*\*(?=\S)([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '<i>$1</i>');
}

function entryHtml(e) {
  const desc = fmt(e.desc)
    .replace(/^(Melee or Ranged Weapon Attack:|Melee Weapon Attack:|Ranged Weapon Attack:|Melee Spell Attack:|Ranged Spell Attack:)/, '<i>$1</i>')
    .replace(/\bHit:/g, '<i>Hit:</i>');
  return `<p class="entry"><i>${esc(e.name)}.</i> <span class="desc">${desc}</span></p>`;
}

function line(label, val) {
  return val ? `<p class="ln"><b>${label}</b> ${esc(val)}</p>` : '';
}

function deadBanner(m) {
  if (!m.dead) return '';
  return `<div class="deadbanner" role="status"><b>Dead</b>${m.dead.when ? `<span>${esc(m.dead.when)}</span>` : ''}
    <button class="btn deaddate" type="button" data-act="deaddate">${m.dead.when ? 'Edit date' : 'Add date'}</button></div>`;
}

function statBlockHtml(m) {
  const sub = [m.size, m.type + (m.subtype ? ` (${m.subtype})` : '')].filter(Boolean).join(' ') + (m.alignment ? `, ${m.alignment}` : '');
  const sections = SECTIONS.slice(1).map(([k, label]) => {
    const list = m[k] || [];
    if (!list.length) return '';
    const introText = k === 'legendary' ? m.legendaryIntro : k === 'lair' ? m.lairIntro : '';
    const intro = introText ? `<p class="entry">${fmt(introText)}</p>` : '';
    return `<h3>${label.replace(/\b\w/g, c => c.toUpperCase())}</h3>${intro}${list.map(entryHtml).join('')}`;
  }).join('');
  return `${deadBanner(m)}<article class="statblock${m.dead ? ' dead' : ''}" aria-label="${esc(m.name)} stat block">
    <h2>${esc(m.name)}</h2>
    <p class="sub">${esc(sub)}</p>
    <hr class="taper">
    ${line('Armor Class', m.ac)}
    ${line('Hit Points', `${m.hp}${m.hpFormula ? ` (${fmtFormula(m.hpFormula)})` : ''}`)}
    ${state.settings.hpMode === 'cr' && HP_BY_CR[String(m.cr)] ? `<p class="ln hpcr">In combat: random ${HP_BY_CR[String(m.cr)].join('–')} (CR ${esc(m.cr)} range)</p>` : ''}
    ${line('Speed', m.speed)}
    <hr class="taper">
    <div class="abilities">${ABILS.map(a => `<div><b>${a.toUpperCase()}</b><span>${m[a]} (${mod(m[a])})</span></div>`).join('')}</div>
    <hr class="taper">
    ${line('Saving Throws', m.saves)}
    ${line('Skills', m.skills)}
    ${line('Damage Vulnerabilities', m.vulnerabilities)}
    ${line('Damage Resistances', m.resistances)}
    ${line('Damage Immunities', m.immunities)}
    ${line('Condition Immunities', m.conditionImmunities)}
    ${line('Senses', m.senses)}
    ${line('Languages', m.languages)}
    <p class="ln"><b>Challenge</b> ${esc(m.cr)} (${Number(m.xp || 0).toLocaleString()} XP) &nbsp; <b>Proficiency Bonus</b> +${esc(m.pb)}</p>
    ${traitsHtml(m)}
    ${sections}
  </article>`;
}

/* ---------- editor ---------- */
function openEditor(m, { isNew = false } = {}) {
  state.editing = structuredClone(m);
  state.editing._isNew = isNew;
  state.dirty = isNew;
  renderEditor();
  setView('detail');
  detailEl.scrollTop = 0;
}

function inp(k, label, val, attrs = '') {
  return `<label class="f">${label}<input class="field" data-k="${k}" value="${esc(val)}" ${attrs}></label>`;
}

function renderEditor() {
  const m = state.editing;
  queueMicrotask(async () => {
    const el = document.querySelector('#edImg'); if (!el) return;
    if (m._img) el.src = m._img;
    else if (m.image && m.id) { const rec = await db.getImage(m.id); if (rec) el.src = rec.data; }
  });
  const sc = m.spellcasting || { ability: '', dc: '', attack: '', level: '', slots: {} };
  detailEl.innerHTML = `<form class="editor" id="editForm" autocomplete="off">
    <h2>${m._isNew ? 'New monster' : 'Edit ' + esc(m.name)}</h2>
    <fieldset><legend>Basics</legend><div class="grid">
      ${inp('name', 'Name', m.name, 'required')}
      ${inp('source', 'Source', m.source, 'list="sourceList"')}
      <label class="f">Size<select class="field" data-k="size">${SIZES.map(s => `<option ${s === m.size ? 'selected' : ''}>${s}</option>`).join('')}</select></label>
      ${inp('type', 'Type', m.type, 'placeholder="giant"')}
      ${inp('subtype', 'Subtype', m.subtype, 'placeholder="optional"')}
      ${inp('alignment', 'Alignment', m.alignment)}
      ${inp('tags', 'Tags', m.tags, 'placeholder="e.g. Icewind Dale, chapter 2"')}
    </div></fieldset>

    <fieldset><legend>Defense and movement</legend><div class="grid">
      ${inp('ac', 'Armor Class', m.ac, 'placeholder="15 (natural armor)"')}
      ${inp('hp', 'Hit points', m.hp, 'type="number" inputmode="numeric" min="0"')}
      <label class="f">Hit dice<span style="display:flex;gap:6px"><input class="field" data-k="hpFormula" value="${esc(m.hpFormula)}" placeholder="8d10+40"><button class="btn" type="button" data-act="avg" title="Set hit points to the formula's average">Avg</button></span></label>
      ${inp('speed', 'Speed', m.speed)}
    </div></fieldset>

    <fieldset><legend>Ability scores</legend><div class="grid six">
      ${ABILS.map(a => inp(a, a.toUpperCase(), m[a], 'type="number" inputmode="numeric" min="1" max="30"')).join('')}
    </div></fieldset>

    <fieldset><legend>Details</legend><div class="grid">
      ${inp('saves', 'Saving throws', m.saves, 'placeholder="Con +5, Wis +2"')}
      ${inp('skills', 'Skills', m.skills)}
      ${inp('vulnerabilities', 'Damage vulnerabilities', m.vulnerabilities)}
      ${inp('resistances', 'Damage resistances', m.resistances)}
      ${inp('immunities', 'Damage immunities', m.immunities)}
      ${inp('conditionImmunities', 'Condition immunities', m.conditionImmunities)}
      ${inp('senses', 'Senses', m.senses)}
      ${inp('languages', 'Languages', m.languages)}
      <label class="f">Challenge<select class="field" data-k="cr">${CRS.map(c => `<option ${c === String(m.cr) ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      ${inp('xp', 'XP', m.xp, 'type="number" inputmode="numeric" min="0"')}
      ${inp('pb', 'Proficiency bonus', m.pb, 'type="number" inputmode="numeric" min="0"')}
    </div></fieldset>

    <p class="hint">For italics, select words in a description and tap <b><i>I</i></b>, or type *asterisks* around them. Double asterisks make **bold**.</p>
    ${SECTIONS.map(([k, label]) => `<fieldset><legend>${label}</legend>
      ${k === 'legendary' ? `<div class="grid" style="margin-bottom:10px">
        ${inp('legendaryCount', 'Legendary actions per round', m.legendaryCount, 'type="number" inputmode="numeric" min="0"')}
        ${inp('legendaryResistance', 'Legendary resistance per day', m.legendaryResistance, 'type="number" inputmode="numeric" min="0"')}
        <label class="f wide">Intro text<textarea class="field" data-k="legendaryIntro" rows="2">${esc(m.legendaryIntro)}</textarea></label>
      </div>` : ''}
      ${k === 'lair' ? `<p class="hint">Lair actions join the combat tracker automatically on initiative 20 when this monster is in the fight.</p>
        <label class="f" style="margin-bottom:10px">Intro text<textarea class="field" data-k="lairIntro" rows="2" placeholder="On initiative count 20 (losing initiative ties), the creature takes a lair action…">${esc(m.lairIntro || '')}</textarea></label>` : ''}
      <div class="entrylist" data-sec="${k}">${(m[k] || []).map((e, i) => entryRow(k, e, i, m[k].length)).join('')}</div>
      <button class="btn" type="button" data-act="add" data-sec="${k}" style="margin-top:10px">Add ${label.toLowerCase().replace(/s$/, '')}</button>
    </fieldset>`).join('')}

    <fieldset><legend>Spellcasting for the tracker</legend>
      <p class="hint">Slots are what the combat tracker counts down. Caster level sets the spell point pool when your table uses spell points.</p>
      <div class="grid" style="margin-bottom:10px">
        <label class="f">Ability<select class="field" data-sc="ability">${['', 'INT', 'WIS', 'CHA'].map(a => `<option ${a === sc.ability ? 'selected' : ''} value="${a}">${a || 'None'}</option>`).join('')}</select></label>
        <label class="f">Caster level<input class="field" data-sc="level" type="number" inputmode="numeric" min="0" max="20" value="${esc(sc.level ?? '')}"></label>
        <label class="f">Spell save DC<input class="field" data-sc="dc" type="number" inputmode="numeric" value="${esc(sc.dc ?? '')}"></label>
        <label class="f">Spell attack bonus<input class="field" data-sc="attack" type="number" inputmode="numeric" value="${esc(sc.attack ?? '')}"></label>
      </div>
      <div class="slots">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(l => `<label class="f">Lv ${l}<input class="field" data-slot="${l}" type="number" inputmode="numeric" min="0" value="${esc((sc.slots || {})[l] ?? '')}"></label>`).join('')}</div>
      <button class="btn" type="button" data-act="detectsc" style="margin-top:10px">Fill from Spellcasting trait</button>
    </fieldset>

    <fieldset><legend>Notes</legend>
      <label class="f">Your notes (shown under the stat block)<textarea class="field" data-k="notes" rows="4">${esc(m.notes)}</textarea></label>
    </fieldset>

    <fieldset><legend>Lore tab</legend>
      <div class="picedit">
        <div class="picprev" id="edPicBox">${m._img === null || (!m._img && !m.image) ? '<span class="note">No picture</span>' : '<img id="edImg" alt="Picture preview">'}</div>
        <div class="picbtns">
          <button class="btn" type="button" data-act="pickpic">${m._img || (m._img === undefined && m.image) ? 'Change picture' : 'Add picture'}</button>
          ${m._img || (m._img === undefined && m.image) ? '<button class="btn danger" type="button" data-act="rmpic">Remove picture</button>' : ''}
          <p class="note">Any photo or image on this device. It's shrunk to save space and syncs with your other device.</p>
        </div>
        <input type="file" id="picFile" accept="image/*" hidden>
      </div>
      <div class="fmtwrap" data-fmt style="margin-top:12px">
        <label class="f">Tactics (also shown in the combat tracker)<textarea class="field" data-k="tactics" rows="3" placeholder="Opens with Fire Breath, focuses spellcasters, flees below half HP…">${esc(m.tactics || '')}</textarea></label>
        <button class="btn icon fmtbtn" type="button" data-act="italic" aria-label="Italicize selected text" title="Italicize selected text">I</button>
      </div>
      <div class="fmtwrap" data-fmt style="margin-top:12px">
        <label class="f">Lore<textarea class="field" data-k="description" rows="8" placeholder="Background, habitat, behavior, rumors…">${esc(m.description)}</textarea></label>
        <button class="btn icon fmtbtn" type="button" data-act="italic" aria-label="Italicize selected text" title="Italicize selected text">I</button>
      </div>
    </fieldset>

    <div class="editbar">
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save monster</button>
    </div>
  </form>`;
}

function entryRow(sec, e, i, n) {
  return `<div class="entryrow" data-fmt data-i="${i}">
    <input class="field" data-e="name" value="${esc(e.name)}" placeholder="Name, e.g. Bite or Fire Breath (Recharge 5–6)" aria-label="Name">
    <span class="ctl">
      <button class="btn icon fmtbtn" type="button" data-act="italic" aria-label="Italicize selected text" title="Italicize selected text">I</button>
      <button class="btn icon" type="button" data-act="up" data-sec="${sec}" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
      <button class="btn icon" type="button" data-act="down" data-sec="${sec}" data-i="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="Move down">↓</button>
      <button class="btn icon danger" type="button" data-act="remove" data-sec="${sec}" data-i="${i}" aria-label="Remove">×</button>
    </span>
    <textarea class="field" data-e="desc" rows="3" aria-label="Description">${esc(e.desc)}</textarea>
  </div>`;
}

// Pull form values back into state.editing (so re-rendering sections keeps typed text)
function readForm() {
  const m = state.editing, f = $('#editForm');
  if (!f) return m;
  const nums = new Set(['hp', 'xp', 'pb', 'legendaryCount', 'legendaryResistance', ...ABILS]);
  f.querySelectorAll('[data-k]').forEach(el => {
    const k = el.dataset.k;
    m[k] = nums.has(k) ? (el.value === '' ? 0 : +el.value) : el.value.trim();
  });
  f.querySelectorAll('.entrylist').forEach(listDiv => {
    const k = listDiv.dataset.sec;
    m[k] = [...listDiv.querySelectorAll('.entryrow')].map(r => ({
      name: r.querySelector('[data-e="name"]').value.trim(),
      desc: r.querySelector('[data-e="desc"]').value.trim(),
    }));
  });
  const sc = { slots: {} };
  f.querySelectorAll('[data-sc]').forEach(el => {
    const k = el.dataset.sc;
    sc[k] = k === 'ability' ? el.value : (el.value === '' ? null : +el.value);
  });
  f.querySelectorAll('[data-slot]').forEach(el => { if (+el.value > 0) sc.slots[el.dataset.slot] = +el.value; });
  m.spellcasting = (sc.ability || sc.level || Object.keys(sc.slots).length) ? sc : null;
  return m;
}

async function submitEditor() {
  const m = readForm();
  if (!m.name) { toast('Give the monster a name first.'); detailEl.querySelector('[data-k="name"]').focus(); return; }
  for (const [k] of SECTIONS) m[k] = (m[k] || []).filter(e => e.name || e.desc);
  if (!m.legendary.length) m.legendaryCount = 0;
  delete m._isNew;
  if (!m.id) m.id = uid();
  const img = m._img; delete m._img;
  if (img === null) { m.image = null; await db.delImage(m.id); }
  else if (img) { const t = now(); await db.putImage({ id: m.id, data: img, updated: t }); m.image = { updated: t }; }
  await saveMonster(m);
  state.editing = null; state.dirty = false;
  state.selectedId = m.id;
  renderList(); renderDetail();
  toast(`Saved ${m.name}`);
}

/* ---------- actions ---------- */
async function onDetailAction(act, btn) {
  const m = state.byId.get(state.selectedId);
  switch (act) {
    case 'back': history.length > 1 && isNarrow() ? history.back() : setView('list', false); break;
    case 'edit': openEditor(m); break;
    case 'addcombat': addMonsterToCombat(m, 1); updateBadge(); toast(m.dead ? `Added ${m.name} to combat. Heads up: it's marked as dead in your library.` : `Added ${m.name} to combat`); break;
    case 'dup': {
      const c = structuredClone(m);
      c.id = ''; c.name = `${m.name} (copy)`; c.edited = false; c.created = 0; c.updated = 0;
      if (c.source === 'SRD 5.1') c.source = 'Homebrew';
      if (m.image) { const rec = await db.getImage(m.id); c.image = null; if (rec) c._img = rec.data; }
      openEditor(c, { isNew: true });
      break;
    }
    case 'revert': {
      if (!await confirmBox(`Revert ${m.name}?`, 'Your edits are replaced with the original SRD stat block.', 'Revert')) return;
      const o = await srdOriginal(m.id);
      if (!o) return toast('Original not found.');
      const r = { ...o, created: 0, updated: now() };
      await db.put(r);
      state.monsters[state.monsters.findIndex(x => x.id === r.id)] = r; state.byId.set(r.id, r);
      renderList(); renderDetail(); toast(`Reverted ${m.name}`);
      break;
    }
    case 'delete': {
      if (!await confirmBox(`Delete ${m.name}?`, m.id.startsWith('srd-') ? 'It is removed from your library. Backups you load later can bring it back.' : 'This removes it from this device. If it is in a backup file, loading that backup brings it back.', 'Delete')) return;
      await db.del(m.id);
      await db.delImage(m.id);
      if (m.id.startsWith('srd-')) {
        state.deletedSrd = state.deletedSrd.filter(d => d.id !== m.id).concat({ id: m.id, at: now() });
        await db.setMeta('deletedSrd', state.deletedSrd);
      }
      setMonsters(state.monsters.filter(x => x.id !== m.id));
      state.selectedId = null; renderDetail(); setView('list', false);
      toast(`Deleted ${m.name}`);
      break;
    }
    // editor actions
    case 'cancel':
      if (state.dirty && !await confirmBox('Discard changes?', 'You have unsaved edits to this monster.', 'Discard')) return;
      state.editing = null; state.dirty = false;
      if (!state.byId.has(state.selectedId)) setView('list', false);
      renderDetail();
      break;
    case 'avg': {
      const v = averageFromFormula(detailEl.querySelector('[data-k="hpFormula"]').value);
      if (v == null) return toast('Write hit dice like 8d10+40 first.');
      detailEl.querySelector('[data-k="hp"]').value = v; state.dirty = true;
      break;
    }
    case 'add': case 'remove': case 'up': case 'down': {
      const m2 = readForm(); const k = btn.dataset.sec; const i = +btn.dataset.i; const arr = m2[k];
      if (act === 'add') arr.push({ name: '', desc: '' });
      if (act === 'remove') arr.splice(i, 1);
      if (act === 'up') [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]];
      if (act === 'down') [arr[i + 1], arr[i]] = [arr[i], arr[i + 1]];
      state.dirty = true;
      const y = detailEl.scrollTop; renderEditor(); detailEl.scrollTop = y;
      if (act === 'add') { const rows = detailEl.querySelectorAll(`.entrylist[data-sec="${k}"] .entryrow`); rows[rows.length - 1]?.querySelector('input').focus(); }
      break;
    }
    case 'italic': {
      const ta = btn.closest('[data-fmt]').querySelector('textarea');
      const { selectionStart: s, selectionEnd: e2, value: v } = ta;
      if (s === e2) { toast('Select the words to italicize first.'); ta.focus(); return; }
      const sel = v.slice(s, e2).trim();
      const lead = v.slice(s, e2).indexOf(sel);
      ta.value = v.slice(0, s + lead) + `*${sel}*` + v.slice(s + lead + sel.length);
      ta.focus(); ta.setSelectionRange(s + lead, s + lead + sel.length + 2);
      state.dirty = true;
      break;
    }
    case 'pickpic': return document.querySelector('#picFile').click();
    case 'rmpic': {
      readForm(); state.editing._img = null; state.dirty = true;
      const y = detailEl.scrollTop; renderEditor(); detailEl.scrollTop = y;
      break;
    }
    case 'tab': state.tab = btn.dataset.tab; renderDetail(); break;
    case 'deaddate': {
      const when = await promptBox(`When did ${m.name} die?`, 'In-game date (leave blank for none)', m.dead.when || '', 'e.g. 13th of Solentide, 297');
      if (when === null) return;
      m.dead = { ...m.dead, when };
      await saveMonster(m); renderDetail();
      break;
    }
    case 'dead': {
      if (!m.dead) {
        const when = await promptBox(`Mark ${m.name} as dead`, 'In-game date (optional)', '', 'e.g. 13th of Solentide, 297');
        if (when === null) { renderDetail(); return; }
        m.dead = { at: now(), when };
      } else m.dead = null;
      await saveMonster(m);
      renderList(); renderDetail();
      toast(m.dead ? `${m.name} marked as dead` : `${m.name} is alive again`);
      break;
    }
    case 'bigpic': {
      const rec = await db.getImage(m.id); if (!rec) return;
      $('#bigImg').src = rec.data; $('#bigImg').alt = m.name; $('#picDlg').showModal();
      break;
    }
    case 'detectsc': {
      const m2 = readForm();
      const sc = detectSpellcasting(m2.traits);
      if (!sc) return toast('No Spellcasting trait found in Traits.');
      m2.spellcasting = sc; state.dirty = true;
      const y = detailEl.scrollTop; renderEditor(); detailEl.scrollTop = y;
      toast('Filled from the Spellcasting trait.');
      break;
    }
  }
}

/* ---------- backup ---------- */
// Everything worth carrying between devices (also what Drive sync stores)
async function buildBackupData({ images = false } = {}) {
  const all = await db.all();
  const mine = all.filter(m => !m.id.startsWith('srd-') || m.edited);
  const pics = [];
  if (images) for (const m of mine) if (m.image) { const rec = await db.getImage(m.id); if (rec) pics.push(rec); }
  return { images: pics, app: 'bestiary', format: 1, exported: new Date().toISOString(), monsters: mine, deletedSrd: state.deletedSrd, settings: state.settings, party: partyForBackup(), encounters: encountersForBackup() };
}

// Merge another device's data in; newest edit wins. Returns a short summary.
async function mergeBackupData(data) {
  const existing = new Map((await db.all()).map(m => [m.id, m]));
  let added = 0, updated = 0, kept = 0, removed = 0;
  const toPut = [];
  for (const m of data.monsters) {
    if (!m?.id || !m.name) continue;
    const cur = existing.get(m.id);
    if (!cur) { toPut.push(m); added++; }
    else if ((m.updated || 0) > (cur.updated || 0)) { toPut.push(m); updated++; }
    else kept++;
  }
  await db.putMany(toPut);
  for (const d of data.deletedSrd || []) {
    const cur = existing.get(d.id);
    if (cur && (cur.updated || 0) < d.at && !toPut.some(m => m.id === d.id)) { await db.del(d.id); removed++; }
    if (!state.deletedSrd.some(x => x.id === d.id)) state.deletedSrd.push(d);
  }
  await db.setMeta('deletedSrd', state.deletedSrd);
  let picsN = 0;
  for (const rec of data.images || []) {
    const cur = await db.getImage(rec.id);
    if (!cur || (rec.updated || 0) > (cur.updated || 0)) { await db.putImage(rec); picsN++; }
  }
  const partyChanged = await mergePartyFromBackup(data.party);
  const encN = await mergeEncountersFromBackup(data.encounters);
  if (added || updated || removed) { setMonsters(await db.all()); if (!state.editing) renderDetail(); }
  if (partyChanged || encN) renderCombat();
  const parts = [];
  if (added) parts.push(`${added} monster${added === 1 ? '' : 's'} added`);
  if (updated) parts.push(`${updated} updated`);
  if (removed) parts.push(`${removed} removed`);
  if (partyChanged) parts.push('party updated');
  if (encN) parts.push(`${encN} encounter${encN === 1 ? '' : 's'} updated`);
  if (picsN) { parts.push(`${picsN} picture${picsN === 1 ? '' : 's'}`); if (!state.editing) renderDetail(); }
  return { parts, kept, changed: parts.length > 0 };
}

async function exportBackup() {
  const data = await buildBackupData({ images: true });
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `bestiary-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved backup with ${data.monsters.length} monster${data.monsters.length === 1 ? '' : 's'}`);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file is not a bestiary backup.'); }
  if (data?.app !== 'bestiary' || !Array.isArray(data.monsters)) return toast('That file is not a bestiary backup.');
  const r = await mergeBackupData(data);
  toast(r.changed ? `Backup loaded: ${r.parts.join(', ')}` : 'Backup loaded: everything was already up to date.');
}

/* ---------- settings ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.querySelector('meta[name="theme-color"]').content = { day: '#f7f9fa', night: '#141a22', red: '#000000' }[state.settings.theme];
  $('#themeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === state.settings.theme));
  $('#spellSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.spell === state.settings.spellMode));
  $('#initSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.init === (state.settings.initMode || 'rolls')));
  $('#hpSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.hp === (state.settings.hpMode || 'block')));
}

async function storageInfo() {
  const el = $('#storageInfo');
  if (!navigator.storage) { el.textContent = 'Storage details are not available in this browser.'; return; }
  const persisted = await navigator.storage.persisted?.();
  const est = await navigator.storage.estimate?.();
  const used = est ? (est.usage / 1048576).toFixed(1) : '?';
  el.textContent = `${state.monsters.length} monsters, about ${used} MB used. `
    + (persisted ? 'Storage is protected: the browser will not clear it to free up space.'
      : 'Storage is not protected yet. Installing the app to your home screen usually fixes this.');
}

/* ---------- wiring ---------- */
function wire() {
  ['#q', '#fType', '#fSource', '#fSize', '#fSort', '#fCrMin', '#fCrMax', '#fHideDead'].forEach(s => $(s).addEventListener('input', renderList));
  $('#clearFilters').addEventListener('click', () => {
    $('#q').value = ''; ['#fType', '#fSource', '#fSize'].forEach(s => { $(s).value = ''; });
    $('#fCrMin').value = '0'; $('#fCrMax').value = '30'; $('#fHideDead').checked = false; renderList();
  });
  listEl.addEventListener('click', e => { const b = e.target.closest('button[data-id]'); if (b) select(b.dataset.id); });

  detailEl.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (b) { e.preventDefault(); onDetailAction(b.dataset.act, b); }
  });
  detailEl.addEventListener('input', e => {
    if (!state.editing) return;
    state.dirty = true;
    if (e.target.dataset.k === 'cr') {
      const cr = e.target.value;
      detailEl.querySelector('[data-k="xp"]').value = XP_BY_CR[cr] ?? 0;
      detailEl.querySelector('[data-k="pb"]').value = pbForCr(cr);
    }
  });
  detailEl.addEventListener('submit', e => { e.preventDefault(); submitEditor(); });
  detailEl.addEventListener('change', async e => {
    if (e.target.id !== 'picFile' || !e.target.files[0] || !state.editing) return;
    try {
      readForm();
      state.editing._img = await shrinkImage(e.target.files[0]);
      state.dirty = true;
      const y = detailEl.scrollTop; renderEditor(); detailEl.scrollTop = y;
    } catch (err) { toast(err.message); }
  });

  $('#newBtn').addEventListener('click', () => {
    const m = blankMonster(); m.source = 'Homebrew';
    const go = () => openEditor(m, { isNew: true });
    state.editing && state.dirty ? guardLeave(go) : go();
  });

  const setDlg = $('#settingsDlg');
  $('#settingsBtn').addEventListener('click', () => { applyTheme(); storageInfo(); setDlg.showModal(); });
  $('#themeSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings.theme = b.dataset.theme; applyTheme(); saveSettings();
  });
  $('#spellSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings.spellMode = b.dataset.spell; applyTheme(); saveSettings(); if (!state.editing) renderDetail(); renderCombat();
  });
  $('#initSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings.initMode = b.dataset.init; applyTheme(); saveSettings(); renderCombat();
  });
  $('#hpSeg').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    state.settings.hpMode = b.dataset.hp; applyTheme(); saveSettings(); if (!state.editing) renderDetail();
  });
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });

  document.querySelector('.modes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]'); if (!b || b.dataset.mode === mode) return;
    if (state.editing && state.dirty) return guardLeave(() => { state.editing = null; state.dirty = false; renderDetail(); setMode(b.dataset.mode); });
    setMode(b.dataset.mode);
  });

  // Enter in a dialog's text field shouldn't submit (and close) the dialog
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' || !e.target.matches('dialog input')) return;
    e.preventDefault();
    if (e.target.id === 'promptInput') $('#promptDlg').close('ok'); // Enter saves a one-line prompt
  });

  // Android back button: detail → list
  window.addEventListener('popstate', () => {
    if (mode === 'combat') { $('#combatView').dataset.view = 'list'; return; }
    if (state.editing && state.dirty) {
      history.pushState({ view: 'detail' }, '');
      guardLeave(() => { state.editing = null; state.dirty = false; renderDetail(); setView('list', false); });
      return;
    }
    state.editing = null;
    setView('list', false);
    renderDetail();
  });
  window.addEventListener('beforeunload', e => { if (state.editing && state.dirty) e.preventDefault(); });
}

async function start() {
  initCrSelects();
  wire();
  initCombat({
    toast, confirmBox, choice, statBlockHtml, fmt,
    getMonster: id => state.byId.get(id),
    allMonsters: () => state.monsters,
    settings: () => state.settings,
    onChange: updateBadge,
    pushDetail: () => { if (isNarrow()) history.pushState({ view: 'cdetail' }, ''); },
    openEncounters, saveEncounter: saveFromCombat,
  });
  initEncounters({
    toast, confirmBox, choice,
    getMonster: id => state.byId.get(id),
    allMonsters: () => state.monsters,
    combat: { monsterCount, clearMonsters, setLoaded, addMonster: addMonsterToCombat },
    goCombat: () => { setMode('combat'); updateBadge(); },
  });
  try {
    await loadAll();
    await loadCombat();
    await loadEncounters();
    updateBadge();
    initSync({ toast, build: buildBackupData, merge: mergeBackupData, monsters: () => state.monsters,
      picturesChanged: () => { if (!state.editing) renderDetail(); } });
  } catch (err) {
    detailEl.innerHTML = `<div class="empty"><h2>The library couldn't load</h2><p>${esc(err.message)}. Reload the page; if it keeps happening, load your latest backup file.</p></div>`;
    return;
  }
  applyTheme();
  renderDetail();
  history.replaceState({ view: 'list' }, '');
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    // When an update finishes installing, reload once so the new version shows right away
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) return;
      if (state.editing && state.dirty) { toast('An update is ready. It applies next time you open the app.'); return; }
      location.reload();
    });
  }
}

start();
