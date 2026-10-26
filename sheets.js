// Live link to your players' character sheets (the Character Sheets app on this same site).
//
// The Character Sheets app on your device publishes charsheet-party.json in your Drive: which sheet file
// belongs to which character. During combat this reads each linked sheet every few seconds for HP, temp HP,
// AC and the Interrupt Point, and writes damage and healing back to the sheet as adjustments, so a player
// healing on their tablet and you dealing damage here at the same moment both count.
import { driveApi, driveReady, suite } from './sync.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const PARTY_FILE = 'charsheet-party.json';
const POLL_MS = 1500; // during a fight; one request covers every sheet, so this stays light

let M = null, R = null;        // the Character Sheets app's own HP and rules code, so both apps agree
const st = { list: [], partyModified: '', files: {}, timer: null, onUpdate: null, error: '', lastOk: 0, wrote: '', onStatus: null };
// What the link is doing, for the line on the Combat screen
export function linkStatus() {
  if (st.error) return { ok: false, text: st.error };
  if (!st.list.length) return { ok: true, text: '' };
  if (!st.lastOk) return { ok: true, text: 'Character sheets: checking…' };
  const s = Math.round((Date.now() - st.lastOk) / 1000);
  return { ok: true, text: `Character sheets: checked ${s < 5 ? 'just now' : `${s} s ago`}${st.wrote ? ` · ${st.wrote}` : ''}${st.via && st.via !== 'live' ? ` · using ${st.via}` : ''}` };
}
const why = (e, what) => `${what}: ${e.status ? `Google answered ${e.status}` : 'no answer'}${e.message && e.message !== 'auth' ? ` (${e.message})` : ''}.`;

async function modules() {
  if (M && R) return true;
  // The Character Sheets app's own HP and rules code first, so both apps always agree. GitHub Pages addresses follow
  // the repository name exactly (yours is Char-Sheet; it was Character-Sheet before). If the browser won't load
  // them (an ad blocker, a slow connection), the Bestiary's own copy (cs-model.js, cs-rules.js) is used instead.
  const why = [];
  for (const base of ['../Char-Sheet/js/', '../Character-Sheet/js/']) {
    try {
      [M, R] = await Promise.all([import(`${base}model.js`), import(`${base}rules.js`)]);
      st.via = 'live'; return true;
    } catch (e) { M = R = null; why.push(e?.message || String(e)); }
  }
  try {
    [M, R] = await Promise.all([import('./cs-model.js'), import('./cs-rules.js')]);
    st.via = `the Bestiary's own copy (couldn't load the Character Sheets app's: ${why[0] || 'no reason given'})`;
    return true;
  } catch (e) { M = R = null; }
  st.error = `Couldn't load the Character Sheets app from this site (${why[0] || 'no reason given'}).`;
  return false;
}

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
const first = s => norm(s).split(' ')[0];

// The sheets the DM's Character Sheets app knows about: [{ id, fileId, name, ... }]
export const sheetList = () => st.list;
export const liveError = () => st.error;

export async function refreshParty() {
  if (!driveReady()) return false;
  const q = encodeURIComponent(`name='${PARTY_FILE}'`);
  const f = (await (await driveApi(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=1`)).json()).files?.[0];
  if (!f || f.modifiedTime === st.partyModified) return false;
  const data = await (await driveApi(`${API}/${f.id}?alt=media`)).json();
  if (data?.app !== 'charsheet-party') return false;
  st.list = (data.chars || []).filter(c => c.fileId);
  st.folderId = data.folderId || '';
  st.partyModified = f.modifiedTime;
  return true;
}

// Which sheet is this party member? Its character's permanent id (the suite's way), then an older chosen link,
// then the same name (only for members not yet linked to a character).
export function sheetFor(p) {
  if (p.charId) return st.list.find(s => s.id === p.charId) || null;
  if (p.sheetId === 'none') return null;
  if (p.sheetId) return st.list.find(s => s.id === p.sheetId) || null;
  const n = norm(p.name), f = first(p.name);
  return st.list.find(s => norm(s.name) === n) || (f ? st.list.find(s => first(s.name) === f) : null) || null;
}

// Numbers the tracker shows for a sheet
function statsOf(c) {
  M.replayHp(c);
  // Wild Shape or another form: the tracker shows the form's HP and AC; damage still goes to the sheet, which works out the carryover
  const f = c.hp?.form;
  return {
    hp: f ? f.cur : Number(c.hp?.cur) || 0, temp: Number(c.hp?.temp) || 0, maxHp: f ? f.max : Number(c.hp?.max) || 0,
    ac: f && f.ac != null ? f.ac : R.armorClass(c).withTemp, passive: R.passivePerception(c), ip: c.ip || 'ready', exh: Number(c.exhaustion) || 0,
    form: f ? f.name : '',
    req: c.combatReq || null, // a turn the player started, ended or interrupted from their sheet
  };
}

async function readSheet(fileId) {
  return (await driveApi(`${API}/${fileId}?alt=media`)).json();
}
async function writeSheet(fileId, data) {
  await driveApi(`${UPLOAD}/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

// Pull every linked sheet that changed since the last look; returns { partyMemberId: stats }
// Every sheet's last-changed time in one request (they all live in the DM's Character Sheets folder)
async function folderTimes() {
  if (!st.folderId) return null;
  const q = encodeURIComponent(`'${st.folderId}' in parents and trashed=false`);
  const r = await (await driveApi(`${API}?q=${q}&fields=files(id,modifiedTime)&pageSize=200`)).json();
  return new Map((r.files || []).map(f => [f.id, f.modifiedTime]));
}
let pulling = false;
export async function pull(party) {
  if (!driveReady() || !(await modules())) return {};
  if (pulling) return {};
  pulling = true;
  try { return await pullAll(party); } finally { pulling = false; }
}
let partyTick = 0;
async function pullAll(party) {
  // the party file changes rarely: look at it every 10th check
  if (partyTick++ % 10 === 0 || !st.list.length) await refreshParty().catch(() => {});
  let times = null;
  try { times = await folderTimes(); } catch (e) { if (e.auth) throw e; times = null; }
  const out = {};
  for (const p of party) {
    const s = sheetFor(p); if (!s) continue;
    try {
      const m = times?.has(s.fileId) ? { modifiedTime: times.get(s.fileId) } : await (await driveApi(`${API}/${s.fileId}?fields=modifiedTime`)).json();
      const known = st.files[s.fileId];
      if (known && known.modified === m.modifiedTime) continue;
      const c = await readSheet(s.fileId);
      if (c?.app !== 'charsheet') continue;
      st.files[s.fileId] = { modified: m.modifiedTime };
      out[p.id] = statsOf(c);
    } catch (e) { st.error = why(e, `Couldn't read ${p.name}'s sheet`); st.onStatus?.(); if (e.auth) throw e; return out; }
  }
  st.error = ''; st.lastOk = Date.now(); st.onStatus?.();
  return out;
}

// Change one sheet: read the latest copy, apply the change, write it back
async function change(p, fn) {
  if (!driveReady() || !(await modules())) return null;
  const s = sheetFor(p); if (!s) return null;
  try {
    const c = await readSheet(s.fileId);
    if (c?.app !== 'charsheet') return null;
    fn(c);
    await writeSheet(s.fileId, c);
    delete st.files[s.fileId]; // re-read on the next poll
    st.error = ''; st.wrote = `sent to ${p.name}'s sheet ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`; st.onStatus?.();
    return statsOf(c);
  } catch (e) { st.error = e.auth && !e.status ? 'Sign in to Google again to keep sheets in step.' : why(e, `Couldn't write to ${p.name}'s sheet`); st.onStatus?.(); return null; }
}

// Damage, healing or temp HP from the tracker. Damage that gets past temp HP recharges a spent Interrupt Point.
export function hp(p, kind, n) {
  const k = { damage: 'dmg', heal: 'heal', temp: 'temp' }[kind]; if (!k) return null;
  return change(p, c => {
    const before = Number(c.hp?.temp) || 0;
    M.hpOp(c, { k, n, by: 'bestiary' });
    if (k === 'dmg' && n > before && c.ip === 'spent') { c.ip = 'recharging'; M.stamp(c, 'ip'); }
  });
}
// Interrupt Points (Active Initiative): ready at the start, recharging ones come back at a new round, all reset at the end
export function interrupts(party, when) {
  return Promise.all(party.map(p => change(p, c => {
    const was = c.ip || 'ready';
    const next = when === 'round' ? (was === 'recharging' ? 'ready' : was) : 'ready';
    if (next !== was) { c.ip = next; M.stamp(c, 'ip'); }
  })));
}

// The characters in the suite's current campaign (every character, if the campaign isn't known yet)
export function campaignSheets() {
  const cur = suite()?.currentCampaign?.()?.id || '';
  return st.list.filter(s => !cur || !s.campaignId || s.campaignId === cur);
}
// A character from another campaign: their member sits out until that campaign is current again
export function inOtherCampaign(charId) {
  const cur = suite()?.currentCampaign?.()?.id || '';
  const s = charId && st.list.find(x => x.id === charId);
  return !!(cur && s && s.campaignId && s.campaignId !== cur);
}

// The player spent their Interrupt Point to interrupt
export function spendIp(p) {
  return change(p, c => { if (c.ip !== 'spent') { c.ip = 'spent'; M.stamp(c, 'ip'); } });
}
// Where the fight stands for this player (whose turn, what they may do), so their sheet can show it
export function combatState(p, view) {
  return change(p, c => {
    if (JSON.stringify(c.combat || null) === JSON.stringify(view)) return;
    c.combat = view; M.stamp(c, 'combat');
  });
}

// Conditions from the tracker, onto the player's sheet with what each one does (only ones the players may see)
export function conditions(p, list) {
  return change(p, c => {
    if (JSON.stringify(c.conditions || []) === JSON.stringify(list)) return;
    c.conditions = list; M.stamp(c, 'conditions');
  });
}

// While a fight is running, keep looking for changes
export function startLive(getParty, onUpdate, onStatus) {
  st.onUpdate = onUpdate; if (onStatus) st.onStatus = onStatus;
  if (st.timer) return;
  const tick = async () => {
    try { const res = await pull(getParty()); if (Object.keys(res).length) st.onUpdate?.(res); }
    catch (e) { if (!st.error) st.error = why(e, "Couldn't reach the character sheets"); }
    if (!driveReady()) st.error = 'Not signed in to Google here, so character sheets can\'t be read. Tap the sync button to sign in.';
    st.onStatus?.();
  };
  tick();
  st.timer = setInterval(tick, POLL_MS);
}
export function stopLive() { clearInterval(st.timer); st.timer = null; }
