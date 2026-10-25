// Live link to your players' character sheets (the Character Sheets app on this same site).
//
// The Character Sheets app on your device publishes charsheet-party.json in your Drive: which sheet file
// belongs to which character. During combat this reads each linked sheet every few seconds for HP, temp HP,
// AC and the Interrupt Point, and writes damage and healing back to the sheet as adjustments, so a player
// healing on their tablet and you dealing damage here at the same moment both count.
import { driveApi, driveReady } from './sync.js';

const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const PARTY_FILE = 'charsheet-party.json';
const POLL_MS = 4000;

let M = null, R = null;        // the Character Sheets app's own HP and rules code, so both apps agree
const st = { list: [], partyModified: '', files: {}, timer: null, onUpdate: null, error: '' };

async function modules() {
  if (M && R) return true;
  // GitHub Pages addresses follow the repository name's capitals (yours is Character-Sheet); try both spellings
  for (const base of ['../Character-Sheet/js/', '../character-sheet/js/']) {
    try {
      [M, R] = await Promise.all([import(`${base}model.js`), import(`${base}rules.js`)]);
      return true;
    } catch { M = R = null; }
  }
  st.error = "Couldn't load the Character Sheets app from this site.";
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
  st.partyModified = f.modifiedTime;
  return true;
}

// Which sheet is this party member? A chosen link first, otherwise the same name.
export function sheetFor(p) {
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
  };
}

async function readSheet(fileId) {
  return (await driveApi(`${API}/${fileId}?alt=media`)).json();
}
async function writeSheet(fileId, data) {
  await driveApi(`${UPLOAD}/${fileId}?uploadType=media`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
}

// Pull every linked sheet that changed since the last look; returns { partyMemberId: stats }
export async function pull(party) {
  if (!driveReady() || !(await modules())) return {};
  await refreshParty().catch(() => {});
  const out = {};
  for (const p of party) {
    const s = sheetFor(p); if (!s) continue;
    try {
      const m = await (await driveApi(`${API}/${s.fileId}?fields=modifiedTime`)).json();
      const known = st.files[s.fileId];
      if (known && known.modified === m.modifiedTime) continue;
      const c = await readSheet(s.fileId);
      if (c?.app !== 'charsheet') continue;
      st.files[s.fileId] = { modified: m.modifiedTime };
      out[p.id] = statsOf(c);
    } catch (e) { if (e.auth) throw e; }
  }
  st.error = '';
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
    return statsOf(c);
  } catch (e) { st.error = e.auth ? 'Sign in to Google again to keep sheets in step.' : "Couldn't update a character sheet just now."; return null; }
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

// While a fight is running, keep looking for changes
export function startLive(getParty, onUpdate) {
  st.onUpdate = onUpdate;
  if (st.timer) return;
  const tick = async () => {
    try { const res = await pull(getParty()); if (Object.keys(res).length) st.onUpdate?.(res); } catch { /* signed out: the sync button shows it */ }
  };
  tick();
  st.timer = setInterval(tick, POLL_MS);
}
export function stopLive() { clearInterval(st.timer); st.timer = null; }
