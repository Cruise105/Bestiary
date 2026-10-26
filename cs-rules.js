// A copy of the Character Sheets app's js/rules.js, used when that file can't be loaded from its own folder.
// D&D 5e (2014) math for the sheet. Everything here is pure: give it a character, get numbers back.

export const ABILS = [
  ['str', 'Strength'], ['dex', 'Dexterity'], ['con', 'Constitution'],
  ['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma'],
];
export const ABIL_SHORT = { str: 'Str', dex: 'Dex', con: 'Con', int: 'Int', wis: 'Wis', cha: 'Cha' };

export const SKILLS = [
  ['acrobatics', 'Acrobatics', 'dex'], ['animal', 'Animal Handling', 'wis'], ['arcana', 'Arcana', 'int'],
  ['athletics', 'Athletics', 'str'], ['deception', 'Deception', 'cha'], ['history', 'History', 'int'],
  ['insight', 'Insight', 'wis'], ['intimidation', 'Intimidation', 'cha'], ['investigation', 'Investigation', 'int'],
  ['medicine', 'Medicine', 'wis'], ['nature', 'Nature', 'int'], ['perception', 'Perception', 'wis'],
  ['performance', 'Performance', 'cha'], ['persuasion', 'Persuasion', 'cha'], ['religion', 'Religion', 'int'],
  ['sleight', 'Sleight of Hand', 'dex'], ['stealth', 'Stealth', 'dex'], ['survival', 'Survival', 'wis'],
];

// Inventory Tracker categories, in the order of the paper tracker
export const INV_CATS = [
  ['armor', 'Armor & Clothing'], ['weapons', 'Weapons'], ['tools', 'Tools & Kits'],
  ['treasure', 'Treasure & Trinkets'], ['components', 'Spell Components'], ['general', 'General Items'],
];
export const COINS = [['cp', 'Copper'], ['sp', 'Silver'], ['ep', 'Electrum'], ['gp', 'Gold'], ['pp', 'Platinum']];
const COIN_CP = { cp: 1, sp: 10, ep: 50, gp: 100, pp: 1000 };

export const DEFENSE_KINDS = [
  ['res', 'Resistances'], ['imm', 'Immunities'], ['vuln', 'Vulnerabilities'], ['cond', 'Condition immunities'],
];

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
export const mod = score => Math.floor((num(score) - 10) / 2);
export const sign = n => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);

export function score(c, a) {
  const ab = c.abil?.[a] || {};
  return num(ab.base) + (ab.adj || []).reduce((t, x) => t + num(x.v), 0);
}
export const amod = (c, a) => (a && ABIL_SHORT[a] ? mod(score(c, a)) : 0);

export function totalLevel(c) {
  const t = (c.classes || []).reduce((s, k) => s + num(k.level), 0);
  return Math.max(1, Math.min(20, t || 1));
}
export function prof(c) {
  if (c.profOverride !== '' && c.profOverride != null && Number.isFinite(Number(c.profOverride))) return Number(c.profOverride);
  return Math.ceil(totalLevel(c) / 4) + 1;
}

export const save = (c, a) => amod(c, a) + (c.saves?.[a] ? prof(c) : 0);

export function skill(c, key) {
  const def = SKILLS.find(s => s[0] === key);
  const rank = num(c.skills?.[key]);
  const p = prof(c);
  let bonus = rank === 2 ? p * 2 : rank === 1 ? p : (c.jack ? Math.floor(p / 2) : 0);
  return amod(c, def[2]) + bonus;
}
export const passivePerception = c => 10 + skill(c, 'perception');
export const initiative = c => amod(c, 'dex') + num(c.init?.misc) + (c.jack ? Math.floor(prof(c) / 2) : 0);

export function armorClass(c) {
  const a = c.ac || {};
  const dex = amod(c, 'dex');
  let base;
  if (a.mode === 'unarmored') base = 10 + dex + (a.unarmoredAbil ? amod(c, a.unarmoredAbil) : 0);
  else {
    const cap = a.maxDex === '' || a.maxDex == null ? Infinity : num(a.maxDex);
    base = num(a.base || 10) + Math.min(dex, cap);
  }
  // a shield counts only while it's in hand (the sheet's Shield switch; on unless turned off)
  const shield = num(a.shield), on = shield !== 0 && a.shieldOff !== true;
  const total = base + (on ? shield : 0) + num(a.misc);
  return { total, withTemp: total + num(a.temp), shield, shieldOn: on, other: shield ? total + num(a.temp) + (on ? -shield : shield) : null };
}

export const saveDc = (c, a) => (a ? 8 + prof(c) + amod(c, a) : null);
export const spellAttack = (c, a) => (a ? prof(c) + amod(c, a) : null);

// Attacks: ability can be str, dex, finesse (better of the two), spell (the spellcasting ability), or none
export function attackAbil(c, atk) {
  if (atk.abil === 'finesse') return amod(c, 'str') >= amod(c, 'dex') ? 'str' : 'dex';
  if (atk.abil === 'spell') return c.spell?.abil || '';
  return atk.abil || '';
}
export function attackBonus(c, atk) {
  return amod(c, attackAbil(c, atk)) + (atk.prof ? prof(c) : 0) + num(atk.bonus);
}
export function damageText(c, atk) {
  const dice = (atk.dmg || '').trim();
  const m = atk.addMod ? amod(c, attackAbil(c, atk)) : 0;
  const parts = [];
  if (dice) parts.push(m ? `${dice} ${m > 0 ? '+' : '−'} ${Math.abs(m)}` : dice);
  else if (atk.addMod) parts.push(String(m));
  if (atk.type) parts.push(atk.type);
  return parts.join(' ');
}

/* ---------- carrying ---------- */
export const coinCount = c => COINS.reduce((t, [k]) => t + num(c.coins?.[k]), 0);
export const coinWeight = c => coinCount(c) / 100; // the table's tracker: 100 coins = 1 lb
export function rowWeight(r) { return num(r.wt) * (r.qty === '' || r.qty == null ? 1 : num(r.qty)); }
export function carried(c) {
  let w = coinWeight(c);
  for (const [k] of INV_CATS) for (const r of c.inv?.[k] || []) w += rowWeight(r);
  for (const m of c.magicItems || []) w += Number(m.weight) || 0; // items the DM's magic item app gave this character
  // infused items that are new objects (Replicate Magic Item): the artificer's own, and ones others gave them
  for (const i of c.infused || []) if (!i.holder || i.holder === c.id) w += Number(i.weight) || 0;
  for (const i of c.infusedHeld || []) w += Number(i.weight) || 0;
  return Math.round(w * 100) / 100;
}
export const capacity = c => score(c, 'str') * 15 * (c.powerful ? 2 : 1);

// Turn copper, silver, electrum and gold into the fewest gold/silver/copper coins. Platinum is left alone.
export function consolidateCoins(coins) {
  const cp = ['cp', 'sp', 'ep', 'gp'].reduce((t, k) => t + num(coins[k]) * COIN_CP[k], 0);
  return { ...coins, gp: Math.floor(cp / 100), sp: Math.floor((cp % 100) / 10), ep: 0, cp: cp % 10 };
}

// XP needed to reach each level (index = current level): XP_TABLE[1] is what level 2 needs
export const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000, null];
export const hitDiceTotal = c => (c.classes || []).map(k => ({ die: num(k.hd) || 8, total: num(k.level), used: num(k.hdUsed), name: k.name }));
