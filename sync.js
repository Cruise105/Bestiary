// Google Drive sync. Keeps one file in the app's private Drive folder (appDataFolder),
// which this app can see and nothing else of yours. Works offline; syncs when it can.
import { db } from './db.js';

const CLIENT_ID = '150155066546-k6e9l4c0fbmel2tdfkv4c4gs41bqd847.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const FILE_NAME = 'bestiary-sync.json';
const API = 'https://www.googleapis.com/drive/v3/files';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';

let ctx;
let tokenClient = null;
let syncing = false;
let status = 'off'; // off | ok | syncing | signin | offline | error
let lastError = '';
const ss = { connected: false, fileId: null, lastSync: 0, lastHash: '', remoteModified: '' };
const tok = { value: null, exp: 0 };

const $ = s => document.querySelector(s);

/* ---------- small helpers ---------- */
function hashOf(data) {
  const s = JSON.stringify({ ...data, exported: '' });
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

async function saveState() { await db.setMeta('sync', { ...ss }); }

function saveToken() {
  try { localStorage.setItem('bestiary-token', JSON.stringify(tok)); } catch { /* storage blocked: token lives in memory only */ }
}
function loadToken() {
  try { const t = JSON.parse(localStorage.getItem('bestiary-token') || 'null'); if (t && t.exp > Date.now()) Object.assign(tok, t); } catch { /* ignore */ }
}
const tokenValid = () => tok.value && tok.exp > Date.now() + 30000;

function ago(t) {
  if (!t) return 'never';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} minute${Math.round(s / 60) === 1 ? '' : 's'} ago`;
  if (s < 86400) return `${Math.round(s / 3600)} hour${Math.round(s / 3600) === 1 ? '' : 's'} ago`;
  return new Date(t).toLocaleDateString();
}

/* ---------- Google sign-in ---------- */
function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error("Couldn't reach Google. Check your connection and try again."));
    document.head.append(s);
  });
}

// Interactive sign-in needs a tap (browsers block the popup otherwise)
async function signIn() {
  await loadGis();
  return new Promise((resolve, reject) => {
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPE,
      callback: r => {
        if (r.error) return reject(new Error(r.error_description || r.error));
        tok.value = r.access_token;
        tok.exp = Date.now() + (Number(r.expires_in) || 3600) * 1000;
        saveToken();
        resolve();
      },
      error_callback: e => reject(new Error(e?.type === 'popup_closed' ? 'Sign-in was closed before it finished.' : (e?.message || 'Sign-in failed.'))),
    });
    tokenClient.requestAccessToken({ prompt: ss.connected ? '' : 'consent' });
  });
}

/* ---------- Drive calls ---------- */
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${tok.value}`, ...(opts.headers || {}) } });
  if (r.status === 401 || r.status === 403) {
    tok.value = null; saveToken();
    const err = new Error('auth'); err.auth = true; throw err;
  }
  if (!r.ok) throw new Error(`Google Drive answered with an error (${r.status}).`);
  return r;
}

async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const r = await api(`${API}?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)&pageSize=1`);
  return (await r.json()).files?.[0] || null;
}

async function download(id) {
  return (await api(`${API}/${id}?alt=media`)).json();
}

async function upload(data) {
  const body = JSON.stringify(data);
  if (ss.fileId) {
    const r = await api(`${UPLOAD}/${ss.fileId}?uploadType=media&fields=id,modifiedTime`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body,
    });
    return r.json();
  }
  const boundary = 'bestiary' + Math.random().toString(36).slice(2);
  const meta = JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'], mimeType: 'application/json' });
  const multipart = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${boundary}--`;
  const r = await api(`${UPLOAD}?uploadType=multipart&fields=id,modifiedTime`, {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
  });
  return r.json();
}

/* ---------- the sync itself ---------- */
// interactive: the person tapped something, so a sign-in popup is allowed
export async function syncNow({ interactive = false, quiet = false } = {}) {
  if (!ss.connected && !interactive) return;
  if (syncing) return;
  if (!navigator.onLine) { setStatus('offline'); if (interactive) ctx.toast("You're offline. Changes will sync when you're back online."); return; }
  syncing = true;
  try {
    if (!tokenValid()) {
      if (!interactive) { setStatus('signin'); return; }
      setStatus('syncing');
      await signIn();
    }
    setStatus('syncing');
    const file = await findFile();
    let summary = null;
    if (file) {
      ss.fileId = file.id;
      if (file.modifiedTime !== ss.remoteModified) {
        const remote = await download(file.id);
        if (remote?.app === 'bestiary' && Array.isArray(remote.monsters)) summary = await ctx.merge(remote);
        ss.remoteModified = file.modifiedTime;
      }
    } else {
      ss.fileId = null;
    }
    const local = await ctx.build();
    const h = hashOf(local);
    if (!file || h !== ss.lastHash) {
      const res = await upload(local);
      ss.fileId = res.id; ss.remoteModified = res.modifiedTime; ss.lastHash = h;
    }
    const firstTime = !ss.connected;
    ss.connected = true; ss.lastSync = Date.now();
    await saveState();
    setStatus('ok');
    if (firstTime) { ctx.toast('Google Drive connected. This device now syncs automatically.'); startAuto(); }
    else if (summary?.changed && !quiet) ctx.toast(`Synced from your other device: ${summary.parts.join(', ')}`);
    else if (summary?.changed) ctx.toast(`Synced: ${summary.parts.join(', ')}`);
    else if (interactive) ctx.toast('Everything is in sync.');
  } catch (err) {
    if (err.auth) { setStatus('signin'); if (interactive) ctx.toast('Google sign-in expired. Tap Sign in to sync again.'); }
    else { lastError = err.message || String(err); setStatus('error'); if (interactive) ctx.toast(lastError); }
  } finally {
    syncing = false;
  }
}

async function disconnect() {
  if (tok.value && window.google?.accounts?.oauth2) { try { google.accounts.oauth2.revoke(tok.value, () => {}); } catch { /* ignore */ } }
  tok.value = null; tok.exp = 0; saveToken();
  Object.assign(ss, { connected: false, fileId: null, lastSync: 0, lastHash: '', remoteModified: '' });
  await saveState();
  setStatus('off');
  ctx.toast('Disconnected. Your data on this device is untouched, and the copy in Drive stays there.');
}

/* ---------- status display ---------- */
function setStatus(s) { status = s; renderStatus(); }

function renderStatus() {
  const btn = $('#syncBtn');
  if (btn) {
    btn.hidden = !ss.connected && status !== 'syncing';
    btn.dataset.state = status;
    const label = { ok: `Synced ${ago(ss.lastSync)}. Tap to sync now.`, syncing: 'Syncing…', signin: 'Sign in to sync', offline: 'Offline. Will sync when back online.', error: `Sync problem: ${lastError}`, off: 'Sync' }[status];
    btn.title = label; btn.setAttribute('aria-label', label);
    btn.querySelector('.syncword').textContent = status === 'signin' ? 'Sign in' : status === 'syncing' ? 'Syncing' : status === 'offline' ? 'Offline' : status === 'error' ? 'Sync issue' : 'Synced';
  }
  const box = $('#syncInfo');
  if (!box) return;
  if (!ss.connected) {
    box.innerHTML = `<p>Keep your PC and tablet in step automatically through your Google Drive. The app only sees its own private sync file, not the rest of your Drive.</p>
      <div class="row" style="justify-content:flex-start"><button class="btn primary" type="button" data-sync="connect">${status === 'syncing' ? 'Connecting…' : 'Connect Google Drive'}</button></div>`;
    return;
  }
  const line = { ok: `Last synced ${ago(ss.lastSync)}.`, syncing: 'Syncing now…', signin: 'Google needs you to sign in again before the next sync.', offline: "You're offline. Changes will sync when you're back online.", error: `The last sync didn't finish: ${lastError}` }[status] || `Last synced ${ago(ss.lastSync)}.`;
  box.innerHTML = `<p>${line} Syncs when the app opens, when you switch away from it, and a few seconds after changes.</p>
    <div class="row" style="justify-content:flex-start">
      <button class="btn primary" type="button" data-sync="now">${status === 'signin' ? 'Sign in and sync' : 'Sync now'}</button>
      <button class="btn" type="button" data-sync="disconnect">Disconnect</button>
    </div>`;
}

/* ---------- start-up + triggers ---------- */
export async function initSync(helpers) {
  ctx = helpers;
  const saved = await db.getMeta('sync');
  if (saved) Object.assign(ss, saved);
  loadToken();
  status = ss.connected ? (tokenValid() ? 'ok' : 'signin') : 'off';
  renderStatus();

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-sync]');
    if (b?.dataset.sync === 'connect' || b?.dataset.sync === 'now') syncNow({ interactive: true });
    if (b?.dataset.sync === 'disconnect') disconnect();
    if (e.target.closest('#syncBtn')) syncNow({ interactive: true });
  });
  $('#settingsBtn').addEventListener('click', renderStatus);

  if (!ss.connected) return;
  syncNow({ quiet: true });
  startAuto();
}

let autoStarted = false;
function startAuto() {
  if (autoStarted) return;
  autoStarted = true;
  // Push local changes a few seconds after they happen; check for the other device's changes now and then
  let lastLocal = '';
  let ticks = 0;
  setInterval(async () => {
    if (!ss.connected || syncing || !navigator.onLine || !tokenValid()) { renderStatus(); return; }
    ticks++;
    const h = hashOf(await ctx.build());
    if ((h !== ss.lastHash && h === lastLocal) || ticks % 12 === 0) syncNow({ quiet: true }); // changes settled, or ~1 min passed
    lastLocal = h;
    renderStatus();
  }, 5000);
  document.addEventListener('visibilitychange', () => syncNow({ quiet: document.visibilityState === 'hidden' }));
  window.addEventListener('online', () => syncNow({ quiet: true }));
  window.addEventListener('offline', () => setStatus('offline'));
}
