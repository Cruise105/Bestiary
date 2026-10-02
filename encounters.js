// Saved encounters: build fights during prep, load them into the tracker at the table.
import { db } from './db.js';

let ctx;
const es = { list: [], deleted: [], editing: null, dirty: false };
const uid = () => 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const esc = s => String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const $ = s => document.querySelector(s);

/* ---------- persistence + backup ---------- */
async function persist() {
  await db.setMeta('encounters', { list: es.list, deleted: es.deleted });
}

export async function loadEncounters() {
  const d = await db.getMeta('encounters');
  if (d) { es.list = d.list || []; es.deleted = d.deleted || []; }
}

export function encountersForBackup() { return { list: es.list, deleted: es.deleted }; }

export async function mergeEncountersFromBackup(d) {
  if (!d || !Array.isArray(d.list)) return 0;
  let changed = 0;
  for (const enc of d.list) {
    const cur = es.list.find(x => x.id === enc.id);
    const gone = es.deleted.find(x => x.id === enc.id);
    if (gone && gone.at >= (enc.updated || 0)) continue;
    if (!cur) { es.list.push(enc); changed++; }
    else if ((enc.updated || 0) > (cur.updated || 0)) { Object.assign(cur, enc); changed++; }
  }
  for (const g of d.deleted || []) {
    const cur = es.list.find(x => x.id === g.id);
    if (cur && (cur.updated || 0) < g.at) { es.list = es.list.filter(x => x.id !== g.id); changed++; }
    if (!es.deleted.some(x => x.id === g.id)) es.deleted.push(g);
  }
  await persist();
  return changed;
}

/* ---------- helpers ---------- */
function summary(enc) {
  return enc.monsters.map(r => {
    const m = ctx.getMonster(r.id);
    return `${m ? m.name : 'Missing monster'}${r.count > 1 ? ` ×${r.count}` : ''}`;
  }).join(', ') || 'No monsters yet';
}
function totalXp(enc) {
  return enc.monsters.reduce((s, r) => s + (ctx.getMonster(r.id)?.xp || 0) * r.count, 0);
}
function groups() { return [...new Set(es.list.map(e => e.group).filter(Boolean))].sort(); }

/* ---------- list view ---------- */
function renderList() {
  es.editing = null;
  const body = $('#encBody');
  if (!es.list.length) {
    body.innerHTML = `<p class="note">No saved encounters yet. Tap New encounter to build one, or set up monsters in the tracker and use Save encounter.</p>`;
  } else {
    const byGroup = new Map();
    [...es.list].sort((a, b) => a.name.localeCompare(b.name)).forEach(e => {
      const g = e.group || '';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(e);
    });
    const order = [...byGroup.keys()].sort((a, b) => (a === '') - (b === '') || a.localeCompare(b));
    body.innerHTML = order.map(g => `<section class="encgroup">
      <h3>${g ? esc(g) : 'Ungrouped'}</h3>
      <ul class="enclist">${byGroup.get(g).map(e => `<li>
        <div class="encinfo">
          <span class="nm">${esc(e.name)}</span>
          <span class="meta">${esc(summary(e))} · ${totalXp(e).toLocaleString()} XP</span>
          ${e.notes ? `<span class="encnote">${esc(e.notes)}</span>` : ''}
        </div>
        <span class="encctl">
          <button class="btn" type="button" data-e="edit" data-id="${e.id}">Edit</button>
          <button class="btn primary" type="button" data-e="load" data-id="${e.id}">Load</button>
        </span>
      </li>`).join('')}</ul></section>`).join('');
  }
  $('#encFoot').innerHTML = `<button class="btn" type="button" data-e="new">New encounter</button>
    <span class="spacer"></span><button class="btn primary" type="submit" value="close">Done</button>`;
  $('#encTitle').textContent = 'Encounters';
}

/* ---------- edit view ---------- */
function openEditor(enc) {
  es.editing = structuredClone(enc);
  es.dirty = !enc.updated;
  renderEditor();
}

function renderEditor() {
  const e = es.editing;
  $('#encTitle').textContent = e.updated ? 'Edit encounter' : 'New encounter';
  $('#encBody').innerHTML = `
    <div class="grid">
      <label class="f">Name<input class="field" id="encName" value="${esc(e.name)}" placeholder="e.g. Yeti ambush"></label>
      <label class="f">Group (optional)<input class="field" id="encGroup" value="${esc(e.group)}" list="encGroups" placeholder="e.g. Rime – Chapter 2"></label>
    </div>
    <datalist id="encGroups">${groups().map(g => `<option value="${esc(g)}">`).join('')}</datalist>
    <label class="f">Notes<textarea class="field" id="encNotes" rows="2" placeholder="Setup, tactics, reinforcements…">${esc(e.notes)}</textarea></label>
    <div>
      <h3 class="ench">Monsters <span class="note">${totalXp(e).toLocaleString()} XP total</span></h3>
      <ul class="encmons">${e.monsters.map((r, i) => {
        const m = ctx.getMonster(r.id);
        return `<li>
          <span class="nm">${m ? esc(m.name) : 'Missing monster'}<small> CR ${esc(m?.cr ?? '?')}</small></span>
          <span class="stepper">
            <button class="btn icon" type="button" data-e="minus" data-i="${i}" aria-label="One fewer">−</button>
            <b>${r.count}</b>
            <button class="btn icon" type="button" data-e="plus" data-i="${i}" aria-label="One more">+</button>
            <button class="btn icon danger" type="button" data-e="drop" data-i="${i}" aria-label="Remove">×</button>
          </span>
        </li>`;
      }).join('') || '<li class="note">No monsters yet. Search below to add some.</li>'}</ul>
    </div>
    <input class="field" id="encSearch" type="search" placeholder="Search your library to add monsters" autocomplete="off" aria-label="Search your library">
    <ul class="addlist short" id="encResults"></ul>`;
  $('#encFoot').innerHTML = `${e.updated ? '<button class="btn danger" type="button" data-e="delete">Delete</button>' : ''}
    <span class="spacer"></span>
    <button class="btn" type="button" data-e="cancel">Cancel</button>
    ${e.updated ? '<button class="btn" type="button" data-e="saveas">Save as new</button>' : ''}
    <button class="btn primary" type="button" data-e="save">${e.updated ? 'Save changes' : 'Save encounter'}</button>`;
  renderResults();
}

function renderResults() {
  const q = ($('#encSearch')?.value || '').trim().toLowerCase();
  const out = $('#encResults'); if (!out) return;
  if (!q) { out.innerHTML = ''; return; }
  const list = ctx.allMonsters().filter(m => m.name.toLowerCase().includes(q))
    .sort((a, b) => (b.name.toLowerCase().startsWith(q) - a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name)).slice(0, 8);
  out.innerHTML = list.map(m => `<li><span class="nm">${esc(m.name)}</span><span class="meta">CR ${esc(m.cr)} · ${esc(m.source || '')}</span>
    <span class="addctl"><button class="btn primary" type="button" data-e="addm" data-id="${esc(m.id)}">Add</button></span></li>`).join('') || '<li class="note">No matches.</li>';
}

function readFields() {
  const e = es.editing; if (!e) return;
  e.name = $('#encName').value.trim();
  e.group = $('#encGroup').value.trim();
  e.notes = $('#encNotes').value.trim();
}

async function saveEditor() {
  readFields();
  const e = es.editing;
  if (!e.name) { ctx.toast('Give the encounter a name.'); $('#encName').focus(); return; }
  e.updated = Date.now();
  const i = es.list.findIndex(x => x.id === e.id);
  if (i >= 0) es.list[i] = e; else es.list.push(e);
  es.dirty = false;
  await persist();
  ctx.toast(`Saved ${e.name}`);
  renderList();
}

/* ---------- loading into the tracker ---------- */
async function load(id) {
  const enc = es.list.find(x => x.id === id); if (!enc) return;
  let mode = 'replace';
  if (ctx.combat.monsterCount()) {
    mode = await ctx.choice('Monsters already in combat', `The tracker already has monsters. Replace them with ${enc.name}, or add ${enc.name} to the fight?`,
      [['add', 'Add to fight'], ['replace', 'Replace']]);
    if (!mode) return;
  }
  if (mode === 'replace') ctx.combat.clearMonsters();
  let missing = 0;
  for (const r of enc.monsters) {
    const m = ctx.getMonster(r.id);
    if (m) ctx.combat.addMonster(m, r.count); else missing++;
  }
  ctx.combat.setLoaded(enc, mode === 'add');
  $('#encDlg').close();
  ctx.goCombat();
  ctx.toast(missing ? `Loaded ${enc.name}. ${missing} monster${missing > 1 ? 's are' : ' is'} no longer in your library.` : `Loaded ${enc.name}. Enter initiative, then Start combat.`);
}

/* ---------- public ---------- */
export function openEncounters() {
  renderList();
  $('#encDlg').showModal();
}

export function saveFromCombat(counts, loaded) {
  const base = loaded && es.list.find(x => x.id === loaded.id);
  openEditor({
    id: base ? base.id : uid(), name: base ? base.name : '', group: base ? base.group : '', notes: base ? base.notes : '',
    monsters: counts, updated: base ? base.updated : 0,
  });
  es.dirty = true;
  $('#encDlg').showModal();
  if (!base) $('#encName').focus();
}

export function initEncounters(helpers) {
  ctx = helpers;
  const dlg = $('#encDlg');
  dlg.addEventListener('input', e => {
    if (e.target.id === 'encSearch') renderResults();
    else if (es.editing) es.dirty = true;
  });
  dlg.addEventListener('cancel', async ev => {
    if (es.editing && es.dirty) { ev.preventDefault(); if (await ctx.confirmBox('Discard changes?', 'This encounter has unsaved changes.', 'Discard')) { es.editing = null; dlg.close(); } }
  });
  dlg.addEventListener('click', async ev => {
    const b = ev.target.closest('[data-e]'); if (!b) return;
    const act = b.dataset.e; const e = es.editing; const i = +b.dataset.i;
    if (e && ['plus', 'minus', 'drop', 'addm'].includes(act)) readFields();
    switch (act) {
      case 'new': return openEditor({ id: uid(), name: '', group: '', notes: '', monsters: [], updated: 0 });
      case 'edit': return openEditor(es.list.find(x => x.id === b.dataset.id));
      case 'load': return load(b.dataset.id);
      case 'plus': e.monsters[i].count = Math.min(30, e.monsters[i].count + 1); break;
      case 'minus': e.monsters[i].count = Math.max(1, e.monsters[i].count - 1); break;
      case 'drop': e.monsters.splice(i, 1); break;
      case 'addm': {
        const ex = e.monsters.find(r => r.id === b.dataset.id);
        if (ex) ex.count++; else e.monsters.push({ id: b.dataset.id, count: 1 });
        break;
      }
      case 'save': return saveEditor();
      case 'saveas':
        readFields();
        e.id = uid(); e.updated = 0;
        if (es.list.some(x => x.name === e.name)) e.name = `${e.name} (copy)`;
        return saveEditor();
      case 'cancel':
        if (es.dirty && !await ctx.confirmBox('Discard changes?', 'This encounter has unsaved changes.', 'Discard')) return;
        return renderList();
      case 'delete':
        if (!await ctx.confirmBox(`Delete ${e.name || 'this encounter'}?`, 'The saved encounter is removed. Monsters in your library are not affected.', 'Delete')) return;
        es.list = es.list.filter(x => x.id !== e.id);
        es.deleted = es.deleted.filter(x => x.id !== e.id).concat({ id: e.id, at: Date.now() });
        await persist();
        return renderList();
      default: return;
    }
    es.dirty = true;
    const q = $('#encSearch')?.value || '';
    renderEditor();
    if (q) { $('#encSearch').value = q; renderResults(); }
  });
}
