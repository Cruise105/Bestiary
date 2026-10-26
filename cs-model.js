// A copy of the Character Sheets app's js/model.js, used when that file can't be loaded from its own folder.
// Character records: creation, field paths, edit stamps, and merging two copies of the same sheet.
//
// Every edit stamps its path with a time in c.edits. When two copies meet (this device and Drive),
// each path keeps whichever copy changed it last, so you and a player editing different parts
// of the same sheet never overwrite each other. A list (inventory rows, attacks) counts as one path.

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const ABIL = () => ({ base: 10, adj: [] });

export function newCharacter(name = '') {
  const now = Date.now();
  return {
    app: 'charsheet', v: 1, id: uid(), created: now, updated: now, edits: {},
    name, player: '', playerEmail: '', race: '', raceId: '', background: '', bgId: '', autoVals: {}, autoFlags: [], alignment: '', xp: '', nextLevel: '',
    classes: [{ name: '', sub: '', clsId: '', subId: '', level: 1, hd: 8, hdUsed: 0 }],
    abil: { str: ABIL(), dex: ABIL(), con: ABIL(), int: ABIL(), wis: ABIL(), cha: ABIL() },
    saves: {}, skills: {}, jack: false, profOverride: '', inspiration: false,
    ac: { mode: 'armor', armorName: '', base: 10, maxDex: '', str: '', stealthDis: false, unarmoredAbil: '', shield: 0, misc: 0, temp: 0 },
    init: { misc: 0 },
    hp: { max: 0, cur: 0, temp: 0 },
    death: { s: 0, f: 0 }, exhaustion: 0, vision: '', speed: '30 ft',
    attacks: [], ammo: [],
    spell: { abil: '' }, abilityDc: { abil: '', label: '' },
    limited: [],
    bgFeature: { name: '', text: '' }, racial: [], classFeat: [], feats: [], extraFeat: [],
    profs: { light: false, medium: false, heavy: false, shields: false, simple: false, martial: false, weaponsOther: '', tools: '' },
    languages: '',
    consumables: [], attuned: [], attuneMax: 3,
    desc: { age: '', height: '', weight: '', eyes: '', skin: '', hair: '', appearance: '', portrait: '' },
    faction: { name: '', notes: '', symbol: '' },
    personality: '', ideals: '', bonds: '', flaws: '', enemies: '',
    inv: { armor: [], weapons: [], tools: [], treasure: [], components: [], general: [] },
    coins: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }, powerful: false,
    defenses: [], options: [], journal: '', inkPages: [], creatures: [], compHp: {}, wildFav: [], infused: [], infAttuned: {},
    notes: '',
    theme: {
      preset: 'night', accent: '', head: 'alegreya', body: 'sans', frame: 'clean',
      bg: { img: '', fit: 'cover', blur: 0, dim: 35 }, panel: 88,
    },
  };
}

/* ---------- paths ---------- */
export function getPath(o, path) {
  return path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
}
export function setPath(o, path, val) {
  const ks = path.split('.');
  let x = o;
  for (let i = 0; i < ks.length - 1; i++) {
    const k = ks[i];
    if (x[k] == null || typeof x[k] !== 'object') x[k] = /^\d+$/.test(ks[i + 1]) ? [] : {};
    x = x[k];
  }
  x[ks[ks.length - 1]] = val;
}

export function stamp(c, path) {
  const t = Date.now();
  c.edits = c.edits || {};
  // A list's path covers everything inside it; drop finer stamps it now covers
  for (const k of Object.keys(c.edits)) if (k.startsWith(path + '.')) delete c.edits[k];
  c.edits[path] = t;
  c.updated = t;
}

// Fill in anything an older or partial record is missing, without touching what's there
export function upgrade(c) {
  const base = newCharacter();
  (function fill(dst, src) {
    for (const k of Object.keys(src)) {
      if (dst[k] === undefined) dst[k] = structuredClone(src[k]);
      else if (src[k] && typeof src[k] === 'object' && !Array.isArray(src[k]) && dst[k] && typeof dst[k] === 'object') fill(dst[k], src[k]);
    }
  })(c, base);
  return c;
}

/* ---------- hit points as a list of adjustments ---------- */
// Every HP change (damage, healing, temp HP, typing a number) is saved as its own entry. When two devices change
// HP at the same moment, both entries survive the merge and the totals are worked out from them in time order.
// Very old entries are folded into a starting point so the list stays short.
const FOLD_AFTER = 6 * 3600 * 1000;
// A form (Wild Shape, Polymorph) is part of the same log: 'form' starts one with its own HP, damage
// goes to it first, and at 0 the character reverts and the leftover damage carries over. 'revert' ends it.
function replayHp(c) {
  const base = c.hpBase || { cur: Number(c.hp?.cur) || 0, temp: Number(c.hp?.temp) || 0, t: 0 };
  let cur = Number(base.cur) || 0, temp = Number(base.temp) || 0;
  let form = base.form ? { ...base.form } : null, ended = null;
  const max = Number(c.hp?.max) || 0;
  for (const o of [...(c.hpOps || [])].sort((a, b) => a.t - b.t || String(a.id).localeCompare(String(b.id)))) {
    const n = Math.max(0, Number(o.n) || 0);
    if (o.k === 'dmg') {
      const ft = Math.min(temp, n); temp -= ft;
      let rest = n - ft;
      if (form) {
        const took = Math.min(form.cur, rest); form.cur -= took; rest -= took;
        if (form.cur <= 0) { ended = { name: form.name, t: o.t, over: rest }; form = null; }
      }
      cur = Math.max(0, cur - rest);
    }
    else if (o.k === 'heal') { if (form) form.cur = Math.min(form.max, form.cur + n); else cur = max ? Math.min(max, cur + n) : cur + n; }
    else if (o.k === 'form') { form = { name: o.name || 'Form', cid: o.cid || '', max: n, cur: n, ac: o.ac ?? null, t: o.t }; ended = null; }
    else if (o.k === 'revert') { if (form) ended = { name: form.name, t: o.t, over: 0, chose: true }; form = null; }
    else if (o.k === 'fset') { if (form && o.cur != null) form.cur = Math.max(0, Math.min(form.max, Number(o.cur) || 0)); }
    else if (o.k === 'gain') cur += n; // level up: max and current both rise
    else if (o.k === 'temp') temp = Math.max(temp, n);
    else if (o.k === 'set') { if (o.cur != null) cur = Math.max(0, Number(o.cur) || 0); if (o.temp != null) temp = Math.max(0, Number(o.temp) || 0); }
  }
  c.hp = c.hp || {};
  c.hp.cur = cur; c.hp.temp = temp;
  c.hp.form = form; c.hp.formEnded = ended;
}
export function hpOp(c, op) {
  if (!c.hpBase) c.hpBase = { cur: Number(c.hp?.cur) || 0, temp: Number(c.hp?.temp) || 0, t: 0 };
  // always later than the last change, so two changes in the same millisecond keep their order
  const t = Math.max(Date.now(), ...(c.hpOps || []).map(o => o.t + 1), (c.hpBase.t || 0) + 1);
  c.hpOps = [...(c.hpOps || []), { id: uid(), t, ...op }];
  // fold entries older than a few hours into the starting point
  if (c.hpOps.length > 80) {
    const cut = t - FOLD_AFTER, old = c.hpOps.filter(o => o.t < cut);
    if (old.length) {
      const tmp = { hp: { max: c.hp.max }, hpBase: c.hpBase, hpOps: old };
      replayHp(tmp);
      c.hpBase = { cur: tmp.hp.cur, temp: tmp.hp.temp, form: tmp.hp.form || null, t: Math.max(...old.map(o => o.t)) };
      c.hpOps = c.hpOps.filter(o => o.t >= cut);
    }
  }
  replayHp(c);
  c.edits = c.edits || {}; c.edits.hpOps = t; c.updated = t;
  return c.hp;
}
export { replayHp };
function mergeHp(out, local, remote) {
  if (!remote.hpOps && !remote.hpBase) return false;
  const lb = local.hpBase, rb = remote.hpBase;
  const base = (rb && (!lb || (rb.t || 0) > (lb.t || 0))) ? rb : (lb || rb);
  const byId = new Map();
  for (const o of [...(local.hpOps || []), ...(remote.hpOps || [])]) byId.set(o.id, o);
  const ops = [...byId.values()].filter(o => o.t > (base?.t || 0));
  const changed = ops.length !== (local.hpOps || []).length || base !== lb;
  out.hpBase = structuredClone(base); out.hpOps = structuredClone(ops);
  replayHp(out);
  return changed;
}

/* ---------- merging two copies ---------- */
// Returns { merged, changed } where changed means the remote copy brought something new.
export function merge(local, remote) {
  if (!local) return { merged: upgrade(structuredClone(remote)), changed: true };
  const out = structuredClone(local);
  const le = local.edits || {}, re = remote.edits || {};
  let changed = false;
  const paths = Object.keys(re).sort((a, b) => a.length - b.length); // parents before children
  const hpSpecial = !!(remote.hpOps || local.hpOps);
  for (const p of paths) {
    if (hpSpecial && (p === 'hpOps' || p === 'hpBase' || p === 'hp.cur' || p === 'hp.temp' || p === 'hp')) continue;
    const rt = re[p];
    // a newer stamp on a parent path in local beats this one
    const covered = Object.keys(le).some(k => (p === k || p.startsWith(k + '.')) && le[k] >= rt);
    if (covered) continue;
    setPath(out, p, structuredClone(getPath(remote, p)));
    for (const k of Object.keys(out.edits)) if (k.startsWith(p + '.')) delete out.edits[k];
    out.edits[p] = rt;
    changed = true;
  }
  if (mergeHp(out, local, remote)) changed = true;
  out.updated = Math.max(local.updated || 0, remote.updated || 0);
  return { merged: upgrade(out), changed };
}

// A short fingerprint of a record, to tell whether it changed since the last upload
export function hashOf(data) {
  const s = JSON.stringify(data);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
