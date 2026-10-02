// Turns pasted stat block text (often from a phone photo) into the app's monster format.
// It is forgiving on purpose: anything it can't place ends up in Notes so nothing is lost.

const SIZES = ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'];
const SECTION_RE = /^(actions|bonus actions|reactions|legendary actions|mythic actions|lair actions)\s*$/i;

export function blankMonster() {
  return {
    id: '', source: '', name: '', size: 'Medium', type: '', subtype: '', alignment: '',
    ac: '', hp: 0, hpFormula: '', speed: '30 ft.',
    str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10,
    saves: '', skills: '', vulnerabilities: '', resistances: '', immunities: '', conditionImmunities: '',
    senses: 'passive Perception 10', languages: '—', cr: '0', xp: 0, pb: 2,
    traits: [], actions: [], bonusActions: [], reactions: [],
    legendaryCount: 0, legendaryIntro: '', legendary: [], legendaryResistance: 0, lairIntro: '', lair: [],
    spellcasting: null, description: '', notes: '', tags: '',
  };
}

function clean(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[−–—](?=\d)/g, '-')   // minus/en dash before digits → hyphen-minus
    .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
    .replace(/(\w)-\n(\w)/g, '$1$2')               // re-join words hyphenated across lines
    .replace(/[ \t]+/g, ' ');
}

const FIELD_LINES = [
  ['ac', /^armou?r class\s*/i],
  ['hpLine', /^hit points\s*/i],
  ['speed', /^speed\s*/i],
  ['saves', /^saving throws\s*/i],
  ['skills', /^skills\s*/i],
  ['vulnerabilities', /^damage vulnerabilities\s*/i],
  ['resistances', /^damage resistances\s*/i],
  ['immunities', /^damage immunities\s*/i],
  ['conditionImmunities', /^condition immunities\s*/i],
  ['senses', /^senses\s*/i],
  ['languages', /^languages\s*/i],
  ['crLine', /^challenge\s*/i],
  ['pbLine', /^proficiency bonus\s*/i],
];

// "Name. Description" or "Name (Recharge 5–6). Description"
const ENTRY_RE = /^([A-Z][A-Za-z'’\- ,/]{0,48}?(?:\s*\([^)]{1,40}\))?)\.\s+(\S.*)$/;

export function parseStatBlock(raw, source = '') {
  const m = blankMonster();
  m.source = source;
  const leftovers = [];
  let lines = clean(raw).split('\n').map(l => l.trim()).filter(Boolean);
  if (!lines.length) return m;

  // Ability scores: find six "NN (+N)" pairs anywhere, then drop those lines.
  const joined = lines.join(' ');
  const scores = [...joined.matchAll(/\b(\d{1,2})\s*\(\s*([+-]?\d{1,2})\s*\)/g)].map(x => +x[1]);
  if (scores.length >= 6) [m.str, m.dex, m.con, m.int, m.wis, m.cha] = scores.slice(0, 6);
  lines = lines.filter(l => !/^(STR|DEX|CON|INT|WIS|CHA)(\s+(STR|DEX|CON|INT|WIS|CHA))*$/i.test(l)
    && !/^(\d{1,2}\s*\(\s*[+-]?\d{1,2}\s*\)\s*)+$/.test(l));

  // Name + size/type line
  m.name = titleCase(lines.shift());
  if (lines[0] && SIZES.some(s => lines[0].toLowerCase().startsWith(s.toLowerCase()))) {
    parseSizeLine(lines.shift(), m);
  }

  // Walk the rest
  let section = 'traits';
  let current = null;
  let lastField = null;
  const target = { traits: m.traits, actions: m.actions, 'bonus actions': m.bonusActions, reactions: m.reactions, 'legendary actions': m.legendary };

  for (const line of lines) {
    const sec = line.match(SECTION_RE);
    if (sec) {
      section = sec[1].toLowerCase();
      current = null; lastField = null;
      if (!target[section]) { leftovers.push(line); section = 'other'; }
      continue;
    }
    // Header fields only before the first entry
    if (section === 'traits' && !m.traits.length) {
      const f = FIELD_LINES.find(([, re]) => re.test(line));
      if (f) {
        lastField = f[0];
        setField(m, f[0], line.replace(f[1], '').trim());
        continue;
      }
      if (lastField && !ENTRY_RE.test(line)) { // wrapped header line
        setField(m, lastField, line, true);
        continue;
      }
    }
    const e = line.match(ENTRY_RE);
    const midSentence = current && !/[.!?:)]$/.test(current.desc);
    if (e && section !== 'other' && isEntryName(e[1]) && !midSentence) {
      current = { name: e[1].trim(), desc: e[2].trim() };
      target[section].push(current);
      lastField = null;
      continue;
    }
    if (section === 'legendary actions' && !m.legendary.length && !current) {
      m.legendaryIntro = (m.legendaryIntro ? m.legendaryIntro + ' ' : '') + line;
      continue;
    }
    if (current) { current.desc += (current.desc.endsWith('-') ? '' : ' ') + line; continue; }
    leftovers.push(line);
  }

  if (m.legendary.length) {
    const n = (m.legendaryIntro.match(/take (\d+) legendary actions/i) || [])[1];
    m.legendaryCount = n ? +n : 3;
  }
  const lr = m.traits.find(t => /^legendary resistance/i.test(t.name));
  if (lr) m.legendaryResistance = +((lr.name.match(/(\d+)\s*\/\s*day/i) || [])[1] || 3);
  m.spellcasting = detectSpellcasting(m.traits) || null;
  if (leftovers.length) m.notes = 'Unplaced text from import:\n' + leftovers.join('\n');
  return m;
}

const SMALL_WORDS = /^(of|the|and|or|in|a|an|on|with|to|from|by|for|at)$/;
function isEntryName(name) {
  const words = name.replace(/\([^)]*\)/g, '').trim().split(/\s+/);
  return words.every(w => /^[A-Z0-9]/.test(w) || SMALL_WORDS.test(w));
}

function parseSizeLine(line, m) {
  const mm = line.match(/^(\w+)\s+([^,(]+?)\s*(?:\(([^)]*)\))?\s*,\s*(.*)$/);
  if (mm) {
    m.size = titleCase(mm[1]); m.type = mm[2].trim().toLowerCase();
    m.subtype = (mm[3] || '').trim(); m.alignment = mm[4].trim();
  } else {
    const parts = line.split(/\s+/);
    m.size = titleCase(parts.shift()); m.type = parts.join(' ').toLowerCase();
  }
}

function setField(m, key, val, append = false) {
  if (key === 'hpLine') {
    const h = val.match(/(\d+)\s*(?:\(([^)]*)\))?/);
    if (h) { m.hp = +h[1]; if (h[2]) m.hpFormula = h[2].replace(/\s+/g, ''); }
    return;
  }
  if (key === 'crLine') {
    const c = val.match(/^(\d+\/\d+|\d+)\s*(?:\(([\d,]+)\s*XP\))?/i);
    if (c) { m.cr = c[1]; if (c[2]) m.xp = +c[2].replace(/,/g, ''); m.pb = pbForCr(c[1]); }
    return;
  }
  if (key === 'pbLine') { const p = val.match(/[+-]?\d+/); if (p) m.pb = Math.abs(+p[0]); return; }
  m[key] = append && m[key] ? `${m[key]} ${val}` : val;
}

export function detectSpellcasting(traits) {
  const t = traits.find(x => /spellcasting/i.test(x.name) && !/innate/i.test(x.name))
    || traits.find(x => /spellcasting/i.test(x.name));
  if (!t) return null;
  const d = t.desc;
  const sc = { ability: '', dc: null, attack: null, level: null, slots: {} };
  const lvl = d.match(/(\d+)(?:st|nd|rd|th)-level spellcaster/i); if (lvl) sc.level = +lvl[1];
  const ab = d.match(/spellcasting ability is (\w+)/i); if (ab) sc.ability = ab[1].slice(0, 3).toUpperCase();
  const dc = d.match(/save DC (\d+)/i); if (dc) sc.dc = +dc[1];
  const atk = d.match(/([+-]\d+) to hit with spell/i); if (atk) sc.attack = +atk[1];
  for (const s of d.matchAll(/(\d)(?:st|nd|rd|th) level \((\d+) slots?\)/gi)) sc.slots[s[1]] = +s[2];
  return sc;
}

export function pbForCr(cr) {
  const n = crNum(cr);
  if (n < 5) return 2; if (n < 9) return 3; if (n < 13) return 4; if (n < 17) return 5;
  if (n < 21) return 6; if (n < 25) return 7; if (n < 29) return 8; return 9;
}

export const XP_BY_CR = { '0': 10, '1/8': 25, '1/4': 50, '1/2': 100, '1': 200, '2': 450, '3': 700, '4': 1100, '5': 1800, '6': 2300, '7': 2900, '8': 3900, '9': 5000, '10': 5900, '11': 7200, '12': 8400, '13': 10000, '14': 11500, '15': 13000, '16': 15000, '17': 18000, '18': 20000, '19': 22000, '20': 25000, '21': 33000, '22': 41000, '23': 50000, '24': 62000, '25': 75000, '26': 90000, '27': 105000, '28': 120000, '29': 135000, '30': 155000 };

export function crNum(cr) {
  if (typeof cr === 'number') return cr;
  if (!cr) return 0;
  if (cr.includes('/')) { const [a, b] = cr.split('/'); return +a / +b; }
  return +cr || 0;
}

function titleCase(s = '') {
  if (s !== s.toUpperCase()) return s.trim();
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase()).trim();
}

// 2014 DMG "Monster Statistics by Challenge Rating" hit point ranges
export const HP_BY_CR = {
  '0': [1, 6], '1/8': [7, 35], '1/4': [36, 49], '1/2': [50, 70], '1': [71, 85], '2': [86, 100], '3': [101, 115],
  '4': [116, 130], '5': [131, 145], '6': [146, 160], '7': [161, 175], '8': [176, 190], '9': [191, 205], '10': [206, 220],
  '11': [221, 235], '12': [236, 250], '13': [251, 265], '14': [266, 280], '15': [281, 295], '16': [296, 310],
  '17': [311, 325], '18': [326, 340], '19': [341, 355], '20': [356, 400], '21': [401, 445], '22': [446, 490],
  '23': [491, 535], '24': [536, 580], '25': [581, 625], '26': [626, 670], '27': [671, 715], '28': [716, 760],
  '29': [761, 805], '30': [806, 850],
};
