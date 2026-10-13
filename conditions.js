// Condition rules: the SRD's standard conditions plus the table's own custom ones (Rage, Bless, Bane…).
import { db } from './db.js';
import { SRD_CONDITIONS } from './conditions-srd.js';

export const STANDARD = ['blinded', 'charmed', 'deafened', 'frightened', 'grappled', 'incapacitated', 'invisible',
  'paralyzed', 'petrified', 'poisoned', 'prone', 'restrained', 'stunned', 'unconscious'];
export const EXHAUSTION_LEVELS = ['Disadvantage on ability checks', 'Speed halved', 'Disadvantage on attack rolls and saving throws',
  'Hit point maximum halved', 'Speed reduced to 0', 'Death'];

let ctx;
const cc = { list: [], deleted: [], updated: 0, editing: null };
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => 'x' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const norm = s => String(s || '').trim().toLowerCase();

/* ---------- data ---------- */
export async function loadConditions() {
  const d = await db.getMeta('conditions');
  if (d) Object.assign(cc, { list: d.list || [], deleted: d.deleted || [], updated: d.updated || 0 });
}
async function persist() {
  cc.updated = Date.now();
  await db.setMeta('conditions', { list: cc.list, deleted: cc.deleted, updated: cc.updated });
}
export const customConditions = () => [...cc.list].sort((a, b) => a.name.localeCompare(b.name));

// Rules text for any condition name the tracker knows about
export function conditionInfo(name) {
  const n = norm(name);
  if (SRD_CONDITIONS[n]) return { name: n, lines: SRD_CONDITIONS[n], custom: false, showPlayers: true };
  const c = cc.list.find(x => norm(x.name) === n);
  if (c) return { name: c.name, lines: c.desc ? c.desc.split(/\n+/).filter(Boolean) : [], custom: true, showPlayers: c.showPlayers !== false };
  return null;
}
export const showOnPlayerView = name => conditionInfo(name)?.showPlayers !== false;

export function conditionsForBackup() { return { list: cc.list, deleted: cc.deleted, updated: cc.updated }; }
export async function mergeConditionsFromBackup(d) {
  if (!d || !Array.isArray(d.list)) return 0;
  let changed = 0;
  for (const x of d.list) {
    const gone = cc.deleted.find(g => g.id === x.id);
    if (gone && gone.at >= (x.updated || 0)) continue;
    const cur = cc.list.find(y => y.id === x.id);
    if (!cur) { cc.list.push(x); changed++; }
    else if ((x.updated || 0) > (cur.updated || 0)) { Object.assign(cur, x); changed++; }
  }
  for (const g of d.deleted || []) {
    const cur = cc.list.find(y => y.id === g.id);
    if (cur && (cur.updated || 0) < g.at) { cc.list = cc.list.filter(y => y.id !== g.id); changed++; }
    if (!cc.deleted.some(y => y.id === g.id)) cc.deleted.push(g);
  }
  if (changed) { await db.setMeta('conditions', { list: cc.list, deleted: cc.deleted, updated: Math.max(cc.updated, d.updated || 0) }); ctx?.onChange?.(); }
  return changed;
}

/* ---------- reference + editor dialog ---------- */
function rulesList(lines) {
  return lines.length ? `<ul class="rules">${lines.map(l => `<li>${esc(l)}</li>`).join('')}</ul>` : '<p class="note">No rules text yet.</p>';
}

function renderList(focus) {
  cc.editing = null;
  $('#condTitle').textContent = 'Conditions';
  const custom = customConditions();
  $('#condBody').innerHTML = `
    <section>
      <div class="condhead"><h3>Your conditions</h3><button class="btn primary" type="button" data-cd="new">Add condition</button></div>
      ${custom.length ? custom.map(c => `<article class="condref" id="cond-${esc(norm(c.name))}">
          <div class="condhead"><h4>${esc(c.name)}${c.showPlayers === false ? ' <small>hidden from player view</small>' : ''}</h4>
            <button class="btn" type="button" data-cd="edit" data-id="${c.id}">Edit</button></div>
          ${rulesList(c.desc ? c.desc.split(/\n+/).filter(Boolean) : [])}
        </article>`).join('')
        : '<p class="note">None yet. Add things like Rage, Bless, Bane or Haste so they can be tapped on in combat.</p>'}
    </section>
    <section>
      <h3>Standard conditions</h3>
      ${STANDARD.map(k => `<article class="condref" id="cond-${k}"><h4>${k}</h4>${rulesList(SRD_CONDITIONS[k])}</article>`).join('')}
      <article class="condref" id="cond-exhaustion"><h4>exhaustion</h4>
        <p>Measured in six levels. Effects are cumulative: a creature has its current level's effect and every level below. A long rest reduces exhaustion by one level, if the creature has also had food and drink.</p>
        <ol class="rules">${EXHAUSTION_LEVELS.map(l => `<li>${esc(l)}</li>`).join('')}</ol></article>
      <article class="condref" id="cond-concentrating"><h4>concentrating</h4>${rulesList(SRD_CONDITIONS.concentrating)}</article>
    </section>`;
  $('#condFoot').innerHTML = '<span class="spacer"></span><button class="btn primary" type="submit" value="close">Done</button>';
  if (focus) requestAnimationFrame(() => document.getElementById('cond-' + norm(focus))?.scrollIntoView({ block: 'start' }));
}

function renderEditor() {
  const c = cc.editing;
  $('#condTitle').textContent = c.updated ? `Edit ${c.name}` : 'Add a condition';
  $('#condBody').innerHTML = `
    <label class="f">Name<input class="field" id="cdName" value="${esc(c.name)}" placeholder="e.g. Bless"></label>
    <label class="f">Rules reminder (one point per line)<textarea class="field" id="cdDesc" rows="5" placeholder="Add 1d4 to attack rolls and saving throws.&#10;Concentration, up to 1 minute.">${esc(c.desc)}</textarea></label>
    <label class="chk"><input type="checkbox" id="cdShow" ${c.showPlayers !== false ? 'checked' : ''}> Show on the player view</label>`;
  $('#condFoot').innerHTML = `${c.updated ? '<button class="btn danger" type="button" data-cd="delete">Delete</button>' : ''}
    <span class="spacer"></span>
    <button class="btn" type="button" data-cd="cancel">Cancel</button>
    <button class="btn primary" type="button" data-cd="save">Save condition</button>`;
  $('#cdName').focus();
}

async function saveEditor() {
  const c = cc.editing;
  const name = $('#cdName').value.trim();
  if (!name) { ctx.toast('Give the condition a name.'); return; }
  const clash = STANDARD.includes(norm(name)) || ['concentrating', 'exhaustion'].includes(norm(name))
    || cc.list.some(x => x.id !== c.id && norm(x.name) === norm(name));
  if (clash) { ctx.toast(`There's already a condition called ${name}.`); return; }
  const oldName = c.updated ? c.name : null;
  Object.assign(c, { name, desc: $('#cdDesc').value.trim(), showPlayers: $('#cdShow').checked, updated: Date.now() });
  const i = cc.list.findIndex(x => x.id === c.id);
  if (i >= 0) cc.list[i] = c; else cc.list.push(c);
  await persist();
  if (oldName && norm(oldName) !== norm(name)) ctx.renameEverywhere(oldName, name);
  ctx.onChange();
  ctx.toast(`Saved ${name}`);
  renderList(name);
}

export function openConditions(focus) {
  renderList(focus);
  const dlg = $('#condDlg');
  if (!dlg.open) dlg.showModal();
}

export function initConditions(helpers) {
  ctx = helpers;
  const dlg = $('#condDlg');
  dlg.addEventListener('click', async e => {
    const b = e.target.closest('[data-cd]'); if (!b) return;
    switch (b.dataset.cd) {
      case 'new': cc.editing = { id: uid(), name: '', desc: '', showPlayers: true, updated: 0 }; return renderEditor();
      case 'edit': cc.editing = structuredClone(cc.list.find(x => x.id === b.dataset.id)); return renderEditor();
      case 'cancel': return renderList();
      case 'save': return saveEditor();
      case 'delete': {
        const c = cc.editing;
        if (!await ctx.confirmBox(`Delete ${c.name}?`, 'It is removed from your conditions and from anyone who has it in the current fight.', 'Delete')) return;
        cc.list = cc.list.filter(x => x.id !== c.id);
        cc.deleted = cc.deleted.filter(x => x.id !== c.id).concat({ id: c.id, at: Date.now() });
        await persist();
        ctx.renameEverywhere(c.name, null);
        ctx.onChange();
        return renderList();
      }
    }
  });
}
