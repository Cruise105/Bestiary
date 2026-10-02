import { db } from './db.js';
import { initCombat, loadCombat, render as renderCombat, addMonsterToCombat, combatantCount, partyForBackup, mergePartyFromBackup } from './combat.js';
import { blankMonster, detectSpellcasting, crNum, pbForCr, XP_BY_CR } from './parser.js';

const SRD_VERSION = 1;
const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const CRS = ['0', '1/8', '1/4', '1/2', ...Array.from({ length: 30 }, (_, i) => String(i + 1))];
const ABILS = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
const SECTIONS = [
  ['traits', 'Traits'], ['actions', 'Actions'], ['bonusActions', 'Bonus actions'],
  ['reactions', 'Reactions'], ['legendary', 'Legendary actions'],
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
  settings: { theme: 'night', spellMode: 'slots' },
  deletedSrd: [],     // [{id, at}]
  srdOriginals: null, // lazy-loaded for "revert"
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
    || $('#fCrMin').value !== '0' || $('#fCrMax').value !== '30';
}

function renderList() {
  const items = filtered();
  $('#count').textContent = `${items.length} of ${state.monsters.length} monsters`;
  $('#clearFilters').hidden = !filtersActive();
  listEl.innerHTML = items.map(m => {
    const mine = !m.id.startsWith('srd-');
    const tag = mine ? '<span class="tag">Mine</span>' : m.edited ? '<span class="tag">Edited</span>' : '';
    return `<li><button type="button" data-id="${esc(m.id)}" aria-current="${m.id === state.selectedId}">
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
    ${statBlockHtml(m)}
    ${m.notes ? `<div class="notes">${fmt(m.notes)}</div>` : ''}
    <p class="sb-foot">${esc(m.source || 'No source')}${m.tags ? ` · Tags: ${esc(m.tags)}` : ''}${m.updated ? ` · Edited ${new Date(m.updated).toLocaleDateString()}` : ''}</p>
  </div>`;
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

function statBlockHtml(m) {
  const sub = [m.size, m.type + (m.subtype ? ` (${m.subtype})` : '')].filter(Boolean).join(' ') + (m.alignment ? `, ${m.alignment}` : '');
  const sections = SECTIONS.slice(1).map(([k, label]) => {
    const list = m[k] || [];
    if (!list.length) return '';
    const intro = k === 'legendary' && m.legendaryIntro ? `<p class="entry">${fmt(m.legendaryIntro)}</p>` : '';
    return `<h3>${label.replace(/\b\w/g, c => c.toUpperCase())}</h3>${intro}${list.map(entryHtml).join('')}`;
  }).join('');
  return `<article class="statblock" aria-label="${esc(m.name)} stat block">
    <h2>${esc(m.name)}</h2>
    <p class="sub">${esc(sub)}</p>
    <hr class="taper">
    ${line('Armor Class', m.ac)}
    ${line('Hit Points', `${m.hp}${m.hpFormula ? ` (${fmtFormula(m.hpFormula)})` : ''}`)}
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
    ${m.description ? `<h3>Description</h3><p class="desc">${fmt(m.description)}</p>` : ''}
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
      <label class="f" style="margin-top:10px">Description or lore<textarea class="field" data-k="description" rows="3">${esc(m.description)}</textarea></label>
    </fieldset>

    <div class="editbar">
      <button class="btn" type="button" data-act="cancel">Cancel</button>
      <button class="btn primary" type="submit">Save monster</button>
    </div>
  </form>`;
}

function entryRow(sec, e, i, n) {
  return `<div class="entryrow" data-i="${i}">
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
    case 'addcombat': addMonsterToCombat(m, 1); updateBadge(); toast(`Added ${m.name} to combat`); break;
    case 'dup': {
      const c = structuredClone(m);
      c.id = ''; c.name = `${m.name} (copy)`; c.edited = false; c.created = 0; c.updated = 0;
      if (c.source === 'SRD 5.1') c.source = 'Homebrew';
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
      const ta = btn.closest('.entryrow').querySelector('textarea');
      const { selectionStart: s, selectionEnd: e2, value: v } = ta;
      if (s === e2) { toast('Select the words to italicize first.'); ta.focus(); return; }
      const sel = v.slice(s, e2).trim();
      const lead = v.slice(s, e2).indexOf(sel);
      ta.value = v.slice(0, s + lead) + `*${sel}*` + v.slice(s + lead + sel.length);
      ta.focus(); ta.setSelectionRange(s + lead, s + lead + sel.length + 2);
      state.dirty = true;
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
async function exportBackup() {
  const all = await db.all();
  const mine = all.filter(m => !m.id.startsWith('srd-') || m.edited);
  const data = { app: 'bestiary', format: 1, exported: new Date().toISOString(), monsters: mine, deletedSrd: state.deletedSrd, settings: state.settings, party: partyForBackup() };
  const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
  const a = document.createElement('a');
  const d = new Date();
  a.href = URL.createObjectURL(blob);
  a.download = `bestiary-backup-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(`Saved backup with ${mine.length} monster${mine.length === 1 ? '' : 's'}`);
}

async function importBackup(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That file is not a bestiary backup.'); }
  if (data?.app !== 'bestiary' || !Array.isArray(data.monsters)) return toast('That file is not a bestiary backup.');
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
  setMonsters(await db.all());
  renderDetail();
  const parts = [`${added} added`, `${updated} updated`];
  if (kept) parts.push(`${kept} already up to date`);
  if (removed) parts.push(`${removed} removed`);
  if (await mergePartyFromBackup(data.party)) parts.push('party updated');
  toast(`Backup loaded: ${parts.join(', ')}`);
}

/* ---------- settings ---------- */
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.querySelector('meta[name="theme-color"]').content = { day: '#f7f9fa', night: '#141a22', red: '#000000' }[state.settings.theme];
  $('#themeSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.theme === state.settings.theme));
  $('#spellSeg').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', b.dataset.spell === state.settings.spellMode));
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
  ['#q', '#fType', '#fSource', '#fSize', '#fSort', '#fCrMin', '#fCrMax'].forEach(s => $(s).addEventListener('input', renderList));
  $('#clearFilters').addEventListener('click', () => {
    $('#q').value = ''; ['#fType', '#fSource', '#fSize'].forEach(s => { $(s).value = ''; });
    $('#fCrMin').value = '0'; $('#fCrMax').value = '30'; renderList();
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
  $('#exportBtn').addEventListener('click', exportBackup);
  $('#restoreBtn').addEventListener('click', () => $('#restoreFile').click());
  $('#restoreFile').addEventListener('change', e => { const f = e.target.files[0]; if (f) importBackup(f); e.target.value = ''; });

  document.querySelector('.modes').addEventListener('click', e => {
    const b = e.target.closest('button[data-mode]'); if (!b || b.dataset.mode === mode) return;
    if (state.editing && state.dirty) return guardLeave(() => { state.editing = null; state.dirty = false; renderDetail(); setMode(b.dataset.mode); });
    setMode(b.dataset.mode);
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
    toast, confirmBox, choice, statBlockHtml,
    getMonster: id => state.byId.get(id),
    allMonsters: () => state.monsters,
    settings: () => state.settings,
    onChange: updateBadge,
    pushDetail: () => { if (isNarrow()) history.pushState({ view: 'cdetail' }, ''); },
  });
  try {
    await loadAll();
    await loadCombat();
    updateBadge();
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
