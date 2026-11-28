/* LearnPulse OS - app.js (v8, static)
   Viswesh & Team, Dept of CSE
   100% browser app: accounts, plans, habits and chat live in localStorage.
   AI runs directly from the browser to Groq using the student's own key. */
(function () {
'use strict';

/* ======================= CONFIG ======================= */
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODELS_URL = 'https://api.groq.com/openai/v1/models';
const TEXT_MODELS = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];
const DEFAULT_VISION = 'meta-llama/llama-4-scout-17b-16e-instruct';
const HOUR_PX = 56;            // must match --hour in style.css
const DAY_START = 360;         // 6:00 AM
const DAY_END = 1380;          // 11:00 PM
const MAX_PLANS = 12;
const HABIT_HORIZON = 14;
const MAX_SCANS = 10;
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const BLOCK_TYPES = ['focus', 'task', 'habit', 'fixed'];
const K = {
  theme: 'lp_theme', session: 'lp_session', acct: 'lp_acct_', key: 'lp_key_',
};
const DEFAULT_SETTINGS = {
  study_start: '09:00', study_end: '21:00', buffer_min: 15, max_daily_hours: 6,
  weekly_goal_hours: 10, defense_mode: 'proactive', default_session: 50, vision_model: DEFAULT_VISION,
};
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HDOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TYPE_LABEL = { focus: 'Focus time', task: 'Task', habit: 'Habit', fixed: 'Fixed class' };
const VIEW_TITLE = { calendar: 'Calendar', habits: 'Habits', focus: 'Focus', analytics: 'Analytics', scan: 'Scan AI', pulsebot: 'PulseBot', settings: 'Settings' };

const $ = (id) => document.getElementById(id);

/* ======================= STATE ======================= */
const S = {
  uid: null, doc: null,
  view: 'calendar', days: 1, anchor: new Date(),
  preview: null, selBlock: null, notesBlock: null, editHabit: null,
  charts: { alloc: null, subjects: null },
  chatBusy: false, quiz: null, scanning: false,
  scan: { dataUrl: null, mode: 'steps', result: '' },
};

/* ======================= UTILS ======================= */
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseYmd = (s) => { const p = String(s).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const todayStr = () => ymd(new Date());
const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
const hm2m = (s) => { const p = String(s).split(':'); return (+p[0]) * 60 + (+p[1]); };
const m2hm = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));
const nowIso = () => new Date().toISOString();

function fmt12(v) {
  const m = typeof v === 'number' ? v : hm2m(v);
  const h = Math.floor(m / 60), mi = m % 60;
  return ((h % 12) === 0 ? 12 : h % 12) + ':' + pad(mi) + ' ' + (h >= 12 ? 'PM' : 'AM');
}
function hourLabel(h) { return ((h % 12) === 0 ? 12 : h % 12) + ' ' + (h >= 12 ? 'PM' : 'AM'); }
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function daysCount() { return window.innerWidth < 900 ? 1 : S.days; }
function dateLabel(s) { const d = parseYmd(s); return DOW[d.getDay()] + ', ' + d.getDate() + ' ' + MON[d.getMonth()]; }
function clamp(v, lo, hi, def) {
  v = Math.round(Number(v));
  if (!isFinite(v)) return def;
  return Math.max(lo, Math.min(hi, v));
}
function bad(msg) { throw new Error(msg); }
function newId(n) {
  const len = n || 12;
  let out = '';
  try {
    const a = new Uint8Array(len);
    (window.crypto || window.msCrypto).getRandomValues(a);
    a.forEach((x) => { out += (x % 16).toString(16); });
  } catch (e) {
    for (let i = 0; i < len; i++) out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}
function prioRank(p) { return { P1: 0, P2: 1, P3: 2, P4: 3 }[p] === undefined ? 2 : { P1: 0, P2: 1, P3: 2, P4: 3 }[p]; }
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) bad('Invalid date');
  const d = parseYmd(s);
  if (isNaN(d.getTime()) || ymd(d) !== s) bad('Invalid date');
  return s;
}
function validHm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || '').trim());
  if (!m || +m[1] > 23 || +m[2] > 59) bad('Invalid time');
  return +m[1] * 60 + +m[2];
}

let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 5500 : 3000);
}
function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
function hideErr(el) { el.textContent = ''; el.hidden = true; }

async function guard(fn, btn) {
  if (btn) btn.classList.add('loading');
  try { return await fn(); }
  catch (e) { toast((e && e.message) || 'Something went wrong', 'error'); }
  finally { if (btn) btn.classList.remove('loading'); }
}

/* ======================= STORAGE ======================= */
function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } }
function uidOf(name) { return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase(); }

function mkDoc(username, pinHash) {
  return {
    username, pin_hash: pinHash, created_at: nowIso(), fails: 0, locked_until: 0,
    streak: 0, last_done_date: null, activity: {}, plans: [], active_plan_id: null,
    habits: [], habit_skips: [], settings: Object.assign({}, DEFAULT_SETTINGS),
    focus_sessions: [], chat: [], weak_topics: [], scans: [],
  };
}

function normalize(doc) {
  const def = mkDoc(doc.username || '', doc.pin_hash || '');
  Object.keys(def).forEach((k) => {
    if (doc[k] === undefined || doc[k] === null) doc[k] = def[k];
    else if (Array.isArray(def[k]) && !Array.isArray(doc[k])) doc[k] = def[k];
    else if (k === 'activity' && (typeof doc[k] !== 'object' || Array.isArray(doc[k]))) doc[k] = {};
  });
  doc.settings = Object.assign({}, DEFAULT_SETTINGS, doc.settings || {});
  doc.plans = doc.plans.filter((p) => p && p.id && Array.isArray(p.blocks));
  doc.plans.forEach((p) => {
    p.blocks = p.blocks.filter((b) => b && b.id && b.date && b.start);
    p.blocks.forEach((b) => {
      if (b.subject === undefined) b.subject = '';
      if (b.topic === undefined) b.topic = '';
      if (PRIORITIES.indexOf(b.priority) < 0) b.priority = 'P3';
      if (b.locked === undefined) b.locked = false;
      if (!b.defense) b.defense = 'busy';
      if (b.done === undefined) b.done = false;
      if (b.notes === undefined) b.notes = '';
      if (BLOCK_TYPES.indexOf(b.type) < 0) b.type = 'task';
      b.duration = clamp(b.duration, 5, 480, 50);
    });
  });
  if (!doc.plans.some((p) => p.id === doc.active_plan_id)) doc.active_plan_id = doc.plans.length ? doc.plans[0].id : null;
  return doc;
}

function loadDoc(uid) {
  const raw = lsGet(K.acct + uid);
  if (raw === null) return null;
  let d;
  try { d = JSON.parse(raw); } catch (e) { bad('Saved data for this account looks damaged. Use another username or restore a backup.'); }
  if (!d || typeof d !== 'object') bad('Saved data for this account looks damaged.');
  return normalize(d);
}

let storageWarned = false;
function save() {
  if (!S.uid || !S.doc) return;
  const ok = lsSet(K.acct + S.uid, JSON.stringify(S.doc));
  if (!ok && !storageWarned) {
    storageWarned = true;
    toast('Browser storage is full. Export a backup and clear old scans.', 'error');
  } else if (ok) storageWarned = false;
}

function storageOk() {
  try {
    localStorage.setItem('lp_probe', '1');
    const ok = localStorage.getItem('lp_probe') === '1';
    localStorage.removeItem('lp_probe');
    return ok;
  } catch (e) { return false; }
}

function getKey() { return (lsGet(K.key + (S.uid || '')) || '').trim(); }
function setKey(v) { if (v) lsSet(K.key + S.uid, v.trim()); else lsDel(K.key + S.uid); }

/* ======================= PIN HASHING ======================= */
function fallbackHash(str) {
  function cyrb(seed) {
    let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return ((h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0'));
  }
  return cyrb(1) + cyrb(7) + cyrb(13);
}
function hasSubtle() { return !!(window.crypto && window.crypto.subtle && window.TextEncoder); }
async function hashPin(uid, pin, method) {
  const str = 'learnpulse:' + uid + ':' + pin;
  if (method === 'fb1' || !hasSubtle()) {
    if (method === 'sha256') bad('Secure hashing is unavailable in this browser. Open the site over https.');
    return 'fb1:' + fallbackHash(str);
  }
  const buf = await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ======================= MODALS ======================= */
let confirmResolve = null;
let keyResolve = null;
function syncBodyLock() {
  document.body.style.overflow = document.querySelectorAll('.modal:not([hidden])').length ? 'hidden' : '';
}
function openModal(id) { $(id).hidden = false; syncBodyLock(); }
function closeModal(id) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (id === 'confirmModal' && confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
  if (id === 'keyModal' && keyResolve) { const r = keyResolve; keyResolve = null; r(false); }
  syncBodyLock();
}
function closeAllModals() { document.querySelectorAll('.modal').forEach((m) => closeModal(m.id)); }
function confirmBox(title, text, okLabel) {
  return new Promise((res) => {
    if (confirmResolve) confirmResolve(false);
    confirmResolve = res;
    $('confirmTitle').textContent = title;
    $('confirmText').textContent = text;
    $('confirmOk').textContent = okLabel || 'Confirm';
    openModal('confirmModal');
  });
}
function ensureKey() {
  if (getKey()) return Promise.resolve(true);
  return new Promise((res) => {
    if (keyResolve) keyResolve(false);
    keyResolve = res;
    $('keyInput').value = '';
    hideErr($('keyError'));
    openModal('keyModal');
    setTimeout(() => { try { $('keyInput').focus(); } catch (e) { /* ignore */ } }, 60);
  });
}
function saveKeyFromModal() {
  const v = $('keyInput').value.trim();
  if (v.length < 20) { showErr($('keyError'), 'That does not look like a full Groq key. Keys start with gsk_ and are long.'); return; }
  setKey(v);
  const r = keyResolve; keyResolve = null;
  closeModal('keyModal');
  $('keyInput').value = '';
  if (S.view === 'settings') fillAiSettings();
  toast('Key saved on this device', 'ok');
  if (r) r(true);
}

/* ======================= MARKDOWN (XSS-safe) ======================= */
function mdInline(s) {
  const codes = [];
  s = String(s).replace(/`([^`\n]+)`/g, (m, c) => { codes.push(c); return '\u0001' + (codes.length - 1) + '\u0001'; });
  s = esc(s);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/\*([^*\n]+)\*/g, (m, t) => (/^\s|\s$/.test(t) ? m : '<em>' + t + '</em>'));
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/\u0001(\d+)\u0001/g, (m, i) => '<code>' + esc(codes[+i]) + '</code>');
  return s;
}
function md(src) {
  src = String(src || '').replace(/\r/g, '');
  const blocks = [];
  src = src.replace(/```[a-zA-Z0-9_+-]*\n([\s\S]*?)```/g, (m, c) => {
    blocks.push('<pre><code>' + esc(c.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000B' + (blocks.length - 1) + '\u0000';
  });
  const lines = src.split('\n');
  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + para.map(mdInline).join('<br>') + '</p>'); para = []; } };
  const flushList = () => {
    if (list) { out.push('<' + list.t + '>' + list.items.map((x) => '<li>' + mdInline(x) + '</li>').join('') + '</' + list.t + '>'); list = null; }
  };
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if ((m = line.match(/^\u0000B(\d+)\u0000$/))) { flushPara(); flushList(); out.push(blocks[+m[1]]); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const lv = Math.min(4, m[1].length + 1);
      out.push('<h' + lv + '>' + mdInline(m[2]) + '</h' + lv + '>'); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      flushPara(); flushList();
      const head = cells(line);
      let j = i + 2; const rows = [];
      while (j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j])) { rows.push(cells(lines[j])); j++; }
      out.push('<table><thead><tr>' + head.map((h) => '<th>' + mdInline(h) + '</th>').join('') + '</tr></thead><tbody>' +
        rows.map((r) => '<tr>' + r.map((c) => '<td>' + mdInline(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>');
      i = j - 1; continue;
    }
    if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
      flushPara(); if (list && list.t !== 'ul') flushList();
      if (!list) list = { t: 'ul', items: [] }; list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara(); if (list && list.t !== 'ol') flushList();
      if (!list) list = { t: 'ol', items: [] }; list.items.push(m[1]); continue;
    }
    if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); out.push('<blockquote>' + mdInline(m[1]) + '</blockquote>'); continue; }
    if (/^\s*$/.test(line)) { flushPara(); flushList(); continue; }
    flushList(); para.push(line);
  }
  flushPara(); flushList();
  return out.join('');
}

/* ======================= THEME ======================= */
function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  lsSet(K.theme, t);
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  if (S.view === 'analytics' && S.doc) loadAnalytics();
}
function initTheme() {
  const t = lsGet(K.theme) === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
}

/* ======================= STREAK / ACTIVITY ======================= */
function bumpStreak(todayS) {
  const d = S.doc;
  if (d.last_done_date === todayS) return;
  if (d.last_done_date) {
    const diff = Math.round((parseYmd(todayS) - parseYmd(d.last_done_date)) / 86400000);
    d.streak = diff === 1 ? (d.streak || 0) + 1 : 1;
  } else d.streak = 1;
  d.last_done_date = todayS;
}
function streakNow() {
  const d = S.doc;
  if (!d || !d.last_done_date) return 0;
  const diff = Math.round((parseYmd(todayStr()) - parseYmd(d.last_done_date)) / 86400000);
  return diff <= 1 ? (d.streak || 0) : 0;
}
function logMinutes(dateS, minutes, kind) {
  const act = S.doc.activity;
  const day = act[dateS] || { study: 0, focus: 0 };
  day[kind] = Math.max(0, (day[kind] || 0) + minutes);
  act[dateS] = day;
  const keys = Object.keys(act).sort();
  if (keys.length > 400) keys.slice(0, keys.length - 400).forEach((k) => { delete act[k]; });
}
function weekMinutes(kind) {
  const ws = weekStart(new Date());
  let total = 0;
  for (let i = 0; i < 7; i++) {
    const a = S.doc.activity[ymd(addDays(ws, i))];
    if (a) total += kind ? (a[kind] || 0) : (a.study || 0) + (a.focus || 0);
  }
  return total;
}
function refreshStreakPill() { $('streakNum').textContent = String(streakNow()); }

/* ======================= SCHEDULING ENGINE ======================= */
function activePlan() { return S.doc.plans.find((p) => p.id === S.doc.active_plan_id) || null; }
function getPlan(pid) { const p = S.doc.plans.find((x) => x.id === pid); if (!p) bad('Plan not found'); return p; }
function findBlock(plan, bid) { const b = plan.blocks.find((x) => x.id === bid); if (!b) bad('Block not found'); return b; }

function defaultDefense(st, btype) {
  if (btype === 'fixed' || btype === 'focus' || st.defense_mode === 'proactive') return 'busy';
  return 'free';
}
function makeBlock(o, st) {
  return {
    id: o.id || newId(12), title: String(o.title).slice(0, 120), type: o.type,
    subject: String(o.subject || '').slice(0, 60), topic: String(o.topic || '').slice(0, 120),
    priority: PRIORITIES.indexOf(o.priority) >= 0 ? o.priority : 'P3',
    date: o.date, start: m2hm(o.startMin), duration: Math.round(o.duration),
    locked: o.locked === undefined || o.locked === null ? o.type === 'fixed' : !!o.locked,
    defense: o.defense || defaultDefense(st, o.type), done: false,
    habit_id: o.habit_id || null, notes: '', manual: false,
  };
}
function computeBuffers(blocks, buf) {
  if (buf <= 0) return [];
  const byDay = {};
  blocks.forEach((b) => { (byDay[b.date] = byDay[b.date] || []).push(b); });
  const out = [];
  Object.keys(byDay).forEach((ds) => {
    const items = byDay[ds].slice().sort((a, b) => hm2m(a.start) - hm2m(b.start));
    for (let i = 0; i < items.length - 1; i++) {
      const cur = items[i], nxt = items[i + 1];
      const end = hm2m(cur.start) + cur.duration;
      const gap = hm2m(nxt.start) - end;
      if (gap >= buf && gap <= buf * 2) {
        out.push({ id: 'buf_' + cur.id, type: 'buffer', title: 'Buffer', date: ds, start: m2hm(end), duration: buf });
      }
    }
  });
  return out;
}
function conflicts(t, dur, occ, buf) { return occ.some((o) => t < o[1] + buf && t + dur + buf > o[0]); }
function findSlot(occ, dur, earliest, latest, buf) {
  let cur = earliest;
  const sorted = occ.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i][0], e = sorted[i][1];
    if (e + buf <= cur) continue;
    if (cur + dur + buf <= s) break;
    cur = Math.max(cur, e + buf);
  }
  return cur + dur <= latest ? cur : null;
}
function schedule(items, kept, base, numDays, st, capMin, nowM, wrap) {
  const buf = +st.buffer_min;
  const ws = Math.max(DAY_START, hm2m(st.study_start));
  const we = Math.min(DAY_END, hm2m(st.study_end));
  const occ = {}, load = {};
  kept.forEach((b) => {
    const s = hm2m(b.start);
    (occ[b.date] = occ[b.date] || []).push([s, s + b.duration]);
    if (b.type === 'task' || b.type === 'focus') load[b.date] = (load[b.date] || 0) + b.duration;
  });
  const placed = [], unplaced = [];
  items.forEach((it) => {
    const dur = Math.round(it.duration);
    const pref = Math.max(0, Math.min(numDays - 1, Math.round(it.pref || 0)));
    let order = [];
    for (let i = pref; i < numDays; i++) order.push(i);
    if (wrap) for (let i = 0; i < pref; i++) order.push(i);
    let ok = false;
    for (let k = 0; k < order.length && !ok; k++) {
      const off = order[k];
      const ds = ymd(addDays(base, off));
      if ((load[ds] || 0) > 0 && (load[ds] || 0) + dur > capMin) continue;
      let earliest = ws;
      if (off === 0 && nowM !== null && nowM !== undefined) earliest = Math.max(ws, Math.floor((nowM + 14) / 15) * 15);
      occ[ds] = occ[ds] || [];
      const t = findSlot(occ[ds], dur, earliest, we, buf);
      if (t === null) continue;
      occ[ds].push([t, t + dur]);
      load[ds] = (load[ds] || 0) + dur;
      placed.push({ it, ds, t });
      ok = true;
    }
    if (!ok) unplaced.push(it);
  });
  return { placed, unplaced };
}
function isMovable(b) { return (b.type === 'task' || b.type === 'focus') && !b.locked && !b.done; }

function computeRebalance(plan, st, todayS, nowM) {
  const today = parseYmd(todayS);
  const blocks = plan.blocks;
  const movable = blocks.filter(isMovable);
  const mids = new Set(movable.map((b) => b.id));
  const kept = blocks.filter((b) => !mids.has(b.id));
  let last = today;
  blocks.forEach((b) => { const d = parseYmd(b.date); if (d > last) last = d; });
  const numDays = Math.min(60, Math.max(14, Math.round((last - today) / 86400000) + 8));
  const items = movable.map((b) => {
    const pref = Math.max(0, Math.round((parseYmd(b.date) - today) / 86400000));
    return { id: b.id, duration: b.duration, pref, rank: prioRank(b.priority), date: b.date, start: b.start };
  });
  items.sort((a, b) => a.pref - b.pref || a.rank - b.rank || (a.date + a.start).localeCompare(b.date + b.start));
  const r = schedule(items, kept, today, numDays, st, Math.round(+st.max_daily_hours * 60), nowM, false);
  const pos = {};
  r.placed.forEach((p) => { pos[p.it.id] = { date: p.ds, start: m2hm(p.t) }; });
  const changed = [], outBlocks = [];
  blocks.forEach((b) => {
    const nb = Object.assign({}, b);
    if (pos[b.id]) {
      nb.date = pos[b.id].date; nb.start = pos[b.id].start;
      if (nb.date !== b.date || nb.start !== b.start) changed.push(b.id);
    }
    outBlocks.push(nb);
  });
  outBlocks.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  return {
    blocks: outBlocks, buffers: computeBuffers(outBlocks, +st.buffer_min), changed,
    moves: changed.map((id) => ({ id, date: pos[id].date, start: pos[id].start })),
    unplaced: r.unplaced.map((u) => u.id),
  };
}

/* ======================= HABITS ENGINE ======================= */
function cleanHabit(h, hid) {
  const name = String(h.name || '').trim();
  if (!name) bad('Habit name is required');
  const dur = clamp(h.duration, 5, 240, 30);
  const e = validHm(h.earliest), l = validHm(h.latest);
  let i = validHm(h.ideal);
  if (e < DAY_START || l > DAY_END) bad('Habit window must be between 6:00 AM and 11:00 PM');
  if (l - e < dur) bad('Habit window is shorter than its duration');
  i = Math.max(e, Math.min(i, l - dur));
  const days = Array.from(new Set((h.days || []).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort();
  if (!days.length) bad('Pick at least one day');
  if (h.defense !== 'busy' && h.defense !== 'free') bad('Defense must be Busy or Free');
  return { id: hid || newId(10), name: name.slice(0, 60), duration: dur, earliest: m2hm(e), ideal: m2hm(i), latest: m2hm(l), days, defense: h.defense };
}
function placeHabit(h, occ, buf) {
  const e = hm2m(h.earliest), l = hm2m(h.latest), ideal = hm2m(h.ideal), dur = h.duration;
  let best = null;
  for (let t = e; t + dur <= l; t += 5) {
    if (!conflicts(t, dur, occ, buf) && (best === null || Math.abs(t - ideal) < Math.abs(best - ideal))) best = t;
  }
  return best;
}
function syncPlanHabits(plan, todayDate, horizon) {
  const hz = horizon || HABIT_HORIZON;
  const todayS = ymd(todayDate);
  const st = S.doc.settings, buf = +st.buffer_min;
  const skips = new Set(S.doc.habit_skips);
  const keep = plan.blocks.filter((b) => !(b.type === 'habit' && b.date >= todayS && !(b.done || b.locked || b.manual)));
  const existing = new Set(keep.map((b) => b.id));
  const occ = {};
  keep.forEach((b) => { const s = hm2m(b.start); (occ[b.date] = occ[b.date] || []).push([s, s + b.duration]); });
  S.doc.habits.forEach((h) => {
    for (let i = 0; i < hz; i++) {
      const d = addDays(todayDate, i);
      const wd = (d.getDay() + 6) % 7;
      if (h.days.indexOf(wd) < 0) continue;
      const ds = ymd(d);
      const bid = 'h_' + h.id + '_' + ds;
      if (existing.has(bid) || skips.has(bid)) continue;
      occ[ds] = occ[ds] || [];
      const t = placeHabit(h, occ[ds], buf);
      if (t === null) continue;
      keep.push(makeBlock({ id: bid, title: h.name, type: 'habit', date: ds, startMin: t, duration: h.duration, habit_id: h.id, defense: h.defense, priority: 'P3' }, st));
      occ[ds].push([t, t + h.duration]);
    }
  });
  plan.blocks = keep;
}
function syncAllHabits(todayDate, horizon) { S.doc.plans.forEach((p) => syncPlanHabits(p, todayDate, horizon)); }

/* ======================= GROQ (browser -> Groq direct) ======================= */
async function groqFetch(body, key, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 70000);
  let res;
  try {
    res = await fetch(GROQ_URL, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify(body),
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e && e.name === 'AbortError' ? 'The AI took too long to answer. Please try again.' : 'Cannot reach Groq. Check your internet connection.');
    err.fatal = true; throw err;
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch (e) { /* ignore */ }
  if (!res.ok) {
    const apiMsg = data && data.error && data.error.message ? String(data.error.message) : '';
    const err = new Error(apiMsg || ('Groq error ' + res.status));
    err.status = res.status; err.apiMsg = apiMsg;
    if (res.status === 401 || res.status === 403) { err.message = 'Groq rejected your key. Check it in Settings → AI connection.'; err.fatal = true; }
    else if (res.status === 429) { err.message = 'Groq rate limit reached. Wait a minute and try again.'; err.fatal = true; }
    throw err;
  }
  return data;
}

async function llm(messages, opts) {
  opts = opts || {};
  const key = getKey();
  if (!key) bad('Add your Groq key in Settings first.');
  const models = opts.models || TEXT_MODELS;
  let last = null;
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    const gptOss = model.indexOf('openai/gpt-oss') === 0;
    const variants = [];
    if (gptOss) variants.push({ effort: true, json: !!opts.json });
    variants.push({ effort: false, json: !!opts.json });
    if (opts.json) variants.push({ effort: false, json: false });
    for (let vi = 0; vi < variants.length; vi++) {
      const v = variants[vi];
      const body = { model, messages, temperature: opts.temperature === undefined ? 0.4 : opts.temperature, max_tokens: opts.max_tokens || 4096 };
      if (v.json) body.response_format = { type: 'json_object' };
      if (v.effort) body.reasoning_effort = 'low';
      try {
        const data = await groqFetch(body, key, opts.timeout);
        const txt = ((data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '').trim();
        if (txt) return txt;
        last = new Error('The AI returned an empty answer.');
      } catch (e) {
        if (e.fatal) throw e;
        last = e;
      }
    }
  }
  const msg = last && last.message ? last.message : 'AI is unavailable right now.';
  const err = new Error(opts.vision
    ? 'The vision model could not read this image (' + msg.slice(0, 140) + '). Check the model name in Settings, or try a clearer, smaller photo.'
    : 'AI is unavailable right now: ' + msg.slice(0, 160));
  throw err;
}

function parseJson(txt) {
  txt = String(txt || '').trim().replace(/^```(?:json)?/gm, '').replace(/```$/gm, '').trim();
  try { return JSON.parse(txt); } catch (e) { /* try extract */ }
  const m = txt.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* ignore */ } }
  return null;
}

/* ======================= AUTH / SCREENS ======================= */
function showScreen(which) {
  $('loginScreen').hidden = which !== 'login';
  $('appShell').hidden = which !== 'app';
}

function resetUiState() {
  stopTimer(true);
  clearPreview(true);
  closeAllModals();
  if (S.charts.alloc) { S.charts.alloc.destroy(); S.charts.alloc = null; }
  if (S.charts.subjects) { S.charts.subjects.destroy(); S.charts.subjects = null; }
  S.uid = null; S.doc = null; S.selBlock = null; S.view = 'calendar'; S.chatBusy = false;
  S.scan = { dataUrl: null, mode: 'steps', result: '' };
  S.quiz = null; S.notesBlock = null; S.editHabit = null;
  ['calGrid', 'calHead', 'chatLog', 'habitList', 'scanResult', 'scanHistory', 'notesBody', 'quizBody'].forEach((id) => { $(id).innerHTML = ''; });
  $('scanResultCard').hidden = true;
  clearScanImage();
  $('focusSubject').value = ''; $('scanSubject').value = ''; $('scanNote').value = '';
  $('setGroqKey').value = '';
}

function goToLogin(message, keepName) {
  lsDel(K.session);
  resetUiState();
  $('loginForm').reset();
  $('loginUser').value = keepName || '';
  $('loginPin').value = '';
  $('loginBtn').classList.remove('loading');
  if (message) showErr($('loginError'), message); else hideErr($('loginError'));
  showScreen('login');
  window.scrollTo(0, 0);
}

function logout() { goToLogin(); }

async function doLogin(username, pin) {
  const name = String(username).trim().replace(/\s+/g, ' ');
  if (!/^[A-Za-z0-9_. \-]{2,24}$/.test(name)) bad('Username must be 2–24 characters: letters, numbers, space, . _ -');
  if (!/^\d{4}$/.test(pin)) bad('PIN must be exactly 4 digits.');
  const uid = uidOf(name);
  let doc = loadDoc(uid);
  let isNew = false;
  if (!doc) {
    doc = mkDoc(name, await hashPin(uid, pin));
    isNew = true;
  } else {
    if (Date.now() < (doc.locked_until || 0)) {
      bad('Too many wrong PINs. Try again in ' + (Math.floor(((doc.locked_until || 0) - Date.now()) / 60000) + 1) + ' min.');
    }
    const method = String(doc.pin_hash).split(':')[0];
    const h = await hashPin(uid, pin, method);
    if (h !== doc.pin_hash) {
      doc.fails = (doc.fails || 0) + 1;
      if (doc.fails >= 5) { doc.fails = 0; doc.locked_until = Date.now() + 300000; }
      lsSet(K.acct + uid, JSON.stringify(doc));
      bad('Wrong PIN for this username.');
    }
    doc.fails = 0; doc.locked_until = 0;
  }
  S.uid = uid; S.doc = doc;
  save();
  lsSet(K.session, uid);
  return isNew;
}

function bootApp() {
  const d = S.doc;
  S.anchor = new Date();
  S.preview = null;
  $('userName').textContent = d.username;
  if (d.plans.length && d.habits.length) { syncAllHabits(new Date()); save(); }
  refreshStreakPill();
  showScreen('app');
  setView('calendar');
  scrollToNow();
}

function init() {
  initTheme();
  const uid = lsGet(K.session);
  if (uid) {
    try {
      const doc = loadDoc(uid);
      if (doc) { S.uid = uid; S.doc = doc; bootApp(); return; }
    } catch (e) {
      goToLogin(e.message);
      return;
    }
  }
  lsDel(K.session);
  showScreen('login');
}

/* ======================= NAVIGATION ======================= */
function setView(name) {
  S.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('viewTitle').textContent = VIEW_TITLE[name] || '';
  window.scrollTo(0, 0);
  if (name === 'calendar') renderCalendar();
  else if (name === 'habits') renderHabits();
  else if (name === 'focus') { renderTimer(); updateFocusStats(); }
  else if (name === 'analytics') loadAnalytics();
  else if (name === 'scan') renderScanHistory();
  else if (name === 'pulsebot') loadChat();
  else if (name === 'settings') { fillSettings(); fillAiSettings(); }
}

/* ======================= CALENDAR RENDER ======================= */
function curBlocks() { const p = activePlan(); return p ? p.blocks : []; }
function visibleDates() {
  const n = daysCount();
  if (n === 7) { const ws = weekStart(S.anchor); return Array.from({ length: 7 }, (_, i) => addDays(ws, i)); }
  return Array.from({ length: n }, (_, i) => addDays(S.anchor, i));
}
function rangeLabel(ds) {
  const a = ds[0], b = ds[ds.length - 1];
  if (ds.length === 1) return DOW[a.getDay()] + ', ' + a.getDate() + ' ' + MON[a.getMonth()] + ' ' + a.getFullYear();
  if (a.getMonth() === b.getMonth()) return a.getDate() + ' – ' + b.getDate() + ' ' + MON[b.getMonth()] + ' ' + b.getFullYear();
  return a.getDate() + ' ' + MON[a.getMonth()] + ' – ' + b.getDate() + ' ' + MON[b.getMonth()] + ' ' + b.getFullYear();
}
function renderPlanSelect() {
  const sel = $('planSelect');
  const plans = S.doc.plans;
  if (!plans.length) { sel.innerHTML = '<option value="">No plans yet</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  sel.innerHTML = plans.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  sel.value = S.doc.active_plan_id;
}
function updateActionStates() {
  const has = !!activePlan();
  ['addBlockBtn', 'rebalanceBtn', 'exportIcsBtn', 'printBtn', 'deletePlanBtn'].forEach((id) => { $(id).disabled = !has; });
}
function layoutLanes(items) {
  let cluster = [], clusterEnd = -1;
  const flush = () => {
    if (!cluster.length) return;
    const lanes = [];
    cluster.forEach((it) => {
      let l = 0;
      while (lanes[l] !== undefined && lanes[l] > it.s) l++;
      lanes[l] = it.e; it.lane = l;
    });
    cluster.forEach((it) => { it.lanes = lanes.length; });
    cluster = [];
  };
  items.forEach((it) => {
    if (cluster.length && it.s >= clusterEnd) { flush(); clusterEnd = -1; }
    cluster.push(it); clusterEnd = Math.max(clusterEnd, it.e);
  });
  flush();
}
function blockHtml(b, moved, lane, lanes) {
  const s = hm2m(b.start);
  const top = Math.max(0, (s - DAY_START) / 60 * HOUR_PX);
  const hgt = Math.max(b.type === 'buffer' ? 12 : 18, b.duration / 60 * HOUR_PX - 2);
  const cls = ['blk', 't-' + b.type];
  if (b.type !== 'buffer') cls.push((b.priority || 'P3').toLowerCase());
  if (b.done) cls.push('done');
  if (moved) cls.push('moved');
  if (hgt < 38) cls.push('short');
  let style = 'top:' + top + 'px;height:' + hgt + 'px;';
  if (b.type !== 'buffer' && lanes > 1) {
    style += 'right:auto;left:calc(' + (lane * 100 / lanes) + '% + 3px);width:calc(' + (100 / lanes) + '% - 6px);';
  }
  if (b.type === 'buffer') return '<div class="' + cls.join(' ') + '" style="' + style + '">Buffer</div>';
  const icons = (b.locked ? '🔒' : '') + (b.defense === 'busy' ? '🛡️' : '') + (b.done ? '✅' : '');
  return '<div class="' + cls.join(' ') + '" data-id="' + esc(b.id) + '" style="' + style + '">' +
    '<span class="blk-title">' + esc(b.title) + '</span>' +
    '<span class="blk-time">' + fmt12(s) + ' – ' + fmt12(s + b.duration) + '</span>' +
    (icons && hgt >= 38 ? '<span class="blk-icons">' + icons + '</span>' : '') + '</div>';
}
function renderCalendar() {
  const plan = activePlan();
  const has = !!plan;
  $('calWrap').hidden = !has;
  $('calEmpty').hidden = has;
  renderPlanSelect();
  updateActionStates();
  const ds = visibleDates();
  $('calLabel').textContent = rangeLabel(ds);
  document.querySelectorAll('#viewSeg button').forEach((b) => b.classList.toggle('active', +b.dataset.days === daysCount()));
  if (!has) return;

  const todayS = todayStr();
  let head = '<div class="ch-gutter"></div>';
  ds.forEach((d) => {
    head += '<div class="ch-day' + (ymd(d) === todayS ? ' today' : '') + '"><div class="ch-dow">' + DOW[d.getDay()] +
      '</div><div class="ch-num">' + d.getDate() + '</div></div>';
  });
  $('calHead').innerHTML = head;

  const blocks = S.preview ? S.preview.blocks : plan.blocks;
  const buffers = S.preview ? S.preview.buffers : computeBuffers(plan.blocks, +S.doc.settings.buffer_min);
  const changed = S.preview ? new Set(S.preview.changed) : new Set();
  const colH = (DAY_END - DAY_START) / 60 * HOUR_PX;

  let g = '<div class="time-col">';
  for (let h = DAY_START / 60; h < DAY_END / 60; h++) g += '<div class="time-label"><span>' + hourLabel(h) + '</span></div>';
  g += '</div>';
  ds.forEach((d) => {
    const dstr = ymd(d);
    const items = blocks.filter((b) => b.date === dstr)
      .map((b) => ({ b, s: hm2m(b.start), e: hm2m(b.start) + b.duration, lane: 0, lanes: 1 }))
      .sort((x, y) => x.s - y.s || x.e - y.e);
    layoutLanes(items);
    let inner = '';
    buffers.filter((b) => b.date === dstr).forEach((b) => { inner += blockHtml(b, false, 0, 1); });
    items.forEach((it) => { inner += blockHtml(it.b, changed.has(it.b.id), it.lane, it.lanes); });
    g += '<div class="day-col' + (dstr === todayS ? ' today' : '') + '" data-date="' + dstr + '" style="height:' + colH + 'px">' + inner + '</div>';
  });
  const grid = $('calGrid');
  grid.innerHTML = g;
  grid.classList.toggle('previewing', !!S.preview);
  updateNowLine();
}
function updateNowLine() {
  document.querySelectorAll('.now-line').forEach((n) => n.remove());
  if (!S.doc || !activePlan()) return;
  const m = nowMin();
  if (m < DAY_START || m > DAY_END) return;
  const col = document.querySelector('.day-col[data-date="' + todayStr() + '"]');
  if (!col) return;
  const line = document.createElement('div');
  line.className = 'now-line';
  line.style.top = ((m - DAY_START) / 60 * HOUR_PX) + 'px';
  col.appendChild(line);
}
function scrollToNow() {
  if (S.view !== 'calendar' || !activePlan()) return;
  const grid = $('calGrid');
  let mins = 480;
  const ds = visibleDates().map(ymd);
  if (ds.indexOf(todayStr()) >= 0) mins = nowMin();
  else {
    const first = curBlocks().filter((b) => ds.indexOf(b.date) >= 0).map((b) => hm2m(b.start)).sort((a, b) => a - b)[0];
    if (first !== undefined) mins = first;
  }
  const y = Math.max(0, (Math.max(DAY_START, mins) - DAY_START) / 60 * HOUR_PX - 90);
  window.scrollTo(0, Math.max(0, grid.getBoundingClientRect().top + window.scrollY + y - 150));
}
function shiftCalendar(dir) {
  S.anchor = addDays(S.anchor, dir * daysCount());
  renderCalendar();
}

/* ======================= PREVIEW / REBALANCE ======================= */
function syncBannerHeight() {
  if (S.preview) {
    const h = $('previewBanner').offsetHeight || 60;
    document.body.style.setProperty('--banner-h', (h + 10) + 'px');
  } else document.body.style.removeProperty('--banner-h');
}
function clearPreview(silent) {
  S.preview = null;
  document.body.classList.remove('previewing');
  document.body.style.removeProperty('--banner-h');
  $('previewBanner').hidden = true;
  if (!silent && S.doc && S.view === 'calendar') renderCalendar();
}
function startRebalance() {
  const plan = activePlan();
  if (!plan || S.preview) return;
  const r = computeRebalance(plan, S.doc.settings, todayStr(), nowMin());
  if (!r.changed.length) {
    toast(r.unplaced.length ? 'No room to move ' + r.unplaced.length + ' task(s). Try a longer study window.' : 'Your schedule is already balanced ✓', 'ok');
    return;
  }
  S.preview = r;
  document.body.classList.add('previewing');
  $('previewInfo').textContent = r.changed.length + ' block' + (r.changed.length > 1 ? 's' : '') + ' will move' +
    (r.unplaced.length ? ', ' + r.unplaced.length + ' could not fit.' : '. Nothing is saved yet.');
  $('previewBanner').hidden = false;
  const vis = visibleDates().map(ymd);
  const dates = r.blocks.filter((b) => r.changed.indexOf(b.id) >= 0).map((b) => b.date).sort();
  if (dates.length && dates.every((d) => vis.indexOf(d) < 0)) S.anchor = parseYmd(dates[0]);
  renderCalendar();
  syncBannerHeight();
  window.scrollTo(0, 0);
}
function applyPreview() {
  const plan = activePlan();
  if (!S.preview || !plan) return;
  let n = 0;
  S.preview.moves.forEach((m) => {
    const b = plan.blocks.find((x) => x.id === m.id);
    if (b && isMovable(b)) { b.date = m.date; b.start = m.start; n++; }
  });
  clearPreview(true);
  save();
  renderCalendar();
  toast('Schedule applied (' + n + ' blocks moved)', 'ok');
}

/* ======================= BLOCK OPERATIONS ======================= */
function checkFit(startMin, dur) {
  if (startMin < DAY_START) bad('Blocks cannot start before 6:00 AM');
  if (startMin + dur > DAY_END) bad('Blocks must end by 11:00 PM');
}
function curBlock() { const p = activePlan(); return p ? (p.blocks.find((b) => b.id === S.selBlock) || null) : null; }

function patchBlockData(b, p) {
  const nb = Object.assign({}, b);
  if (p.title !== undefined) { const t = String(p.title).trim(); if (!t) bad('Title cannot be empty'); nb.title = t.slice(0, 120); }
  if (p.subject !== undefined) nb.subject = String(p.subject).trim().slice(0, 60);
  if (p.topic !== undefined) nb.topic = String(p.topic).trim().slice(0, 120);
  if (p.priority !== undefined) { if (PRIORITIES.indexOf(p.priority) < 0) bad('Priority must be P1-P4'); nb.priority = p.priority; }
  if (p.defense !== undefined) { if (p.defense !== 'busy' && p.defense !== 'free') bad('Defense must be Busy or Free'); nb.defense = p.defense; }
  if (p.locked !== undefined) nb.locked = !!p.locked;
  let timing = false;
  if (p.date !== undefined) { nb.date = validDate(p.date); timing = true; }
  if (p.start !== undefined) { nb.start = m2hm(validHm(p.start)); timing = true; }
  if (p.duration !== undefined) { nb.duration = clamp(p.duration, 5, 480, b.duration); timing = true; }
  if (timing) {
    checkFit(hm2m(nb.start), nb.duration);
    if (nb.type === 'habit') nb.manual = true;
  }
  Object.assign(b, nb);
}

function openInspector(id) {
  if (S.preview) { toast('Apply or discard the preview first'); return; }
  const plan = activePlan();
  const b = plan && plan.blocks.find((x) => x.id === id);
  if (!b) return;
  S.selBlock = id;
  fillInspector(b);
  openModal('inspectorModal');
}
function fillInspector(b) {
  $('inspHeading').textContent = b.title;
  const s = hm2m(b.start);
  let meta = '<span class="tag ' + esc(b.type) + '">' + esc(TYPE_LABEL[b.type] || b.type) + '</span>' +
    '<span class="tag">' + esc(dateLabel(b.date)) + '</span>' +
    '<span class="tag">' + fmt12(s) + ' – ' + fmt12(s + b.duration) + '</span>';
  if (b.type === 'task') meta += '<span class="tag">' + esc(b.priority) + '</span>';
  if (b.done) meta += '<span class="tag">✅ Done</span>';
  $('inspMeta').innerHTML = meta;
  $('inspDone').textContent = b.done ? '↩ Mark not done' : '✅ Mark done';
  $('inspDone').classList.toggle('on', !!b.done);
  $('inspLock').textContent = b.locked ? '🔒 Locked' : '🔓 Unlocked';
  $('inspLock').classList.toggle('on', !!b.locked);
  $('inspDefense').textContent = b.defense === 'busy' ? '🛡️ Busy' : '🔓 Free';
  $('inspDefense').classList.toggle('on', b.defense === 'busy');
  $('inspTitle').value = b.title;
  $('inspSubject').value = b.subject || '';
  $('inspTopic').value = b.topic || '';
  $('inspDate').value = b.date;
  $('inspStart').value = b.start;
  $('inspDuration').value = b.duration;
  $('inspPriority').value = b.priority || 'P3';
}
function patchSelected(patch, okMsg) {
  const b = curBlock();
  if (!b) return;
  patchBlockData(b, patch);
  save();
  fillInspector(b);
  renderCalendar();
  if (okMsg) toast(okMsg, 'ok');
}
function toggleDone() {
  const b = curBlock();
  if (!b) return;
  const todayS = todayStr();
  if (!b.done) {
    b.done = true; b.done_date = todayS;
    logMinutes(todayS, b.duration, 'study');
    bumpStreak(todayS);
  } else {
    b.done = false;
    logMinutes(b.done_date || todayS, -b.duration, 'study');
    delete b.done_date;
  }
  save();
  refreshStreakPill();
  fillInspector(b);
  renderCalendar();
  toast(b.done ? 'Nice work! Logged ' + b.duration + ' min 🔥' : 'Marked as not done', 'ok');
}
async function deleteSelected() {
  const b = curBlock(), plan = activePlan();
  if (!b || !plan) return;
  const ok = await confirmBox('Delete block?', '“' + b.title + '” will be removed from your calendar.', 'Delete');
  if (!ok) return;
  if (b.type === 'habit' && S.doc.habit_skips.indexOf(b.id) < 0) S.doc.habit_skips = S.doc.habit_skips.concat([b.id]).slice(-400);
  plan.blocks = plan.blocks.filter((x) => x.id !== b.id);
  save();
  closeModal('inspectorModal');
  renderCalendar();
  toast('Block deleted', 'ok');
}

/* ======================= AI NOTES / QUIZ ======================= */
function blockTopic(b) { return (b.topic && b.topic.trim()) || b.title; }

async function openNotes(b, refresh) {
  if (!refresh && b.notes) {
    S.notesBlock = b;
    $('notesTitle').textContent = '📝 ' + blockTopic(b);
    $('notesBody').innerHTML = md(b.notes);
    openModal('notesModal');
    return;
  }
  if (!(await ensureKey())) return;
  S.notesBlock = b;
  $('notesTitle').textContent = '📝 ' + blockTopic(b);
  $('notesBody').innerHTML = '<div class="typing"><i></i><i></i><i></i></div> <span class="muted small">Writing notes…</span>';
  openModal('notesModal');
  try {
    const txt = await llm([
      { role: 'system', content: 'You are a concise, accurate study tutor. Write clear Markdown study notes: a short overview, key concepts as bullets, one worked example, common mistakes, and a 3-line quick recap. Use fenced code blocks for code. Plain-text math only (no LaTeX). Keep under 450 words.' },
      { role: 'user', content: 'Subject: ' + (b.subject || 'General') + '\nTopic: ' + blockTopic(b) + '\nWrite revision notes for a student.' },
    ], { temperature: 0.4 });
    b.notes = txt.slice(0, 6000);
    save();
    if (S.notesBlock === b) $('notesBody').innerHTML = md(b.notes);
  } catch (e) {
    $('notesBody').innerHTML = '<div class="form-error">' + esc(e.message) + '</div>';
  }
}

async function openQuiz(b) {
  if (!(await ensureKey())) return;
  const topic = blockTopic(b), subject = b.subject || '';
  S.quiz = { topic, subject, qs: [], i: 0, score: 0, answered: false };
  $('quizTitle').textContent = '❓ Quiz: ' + topic;
  $('quizBody').innerHTML = '<div class="typing"><i></i><i></i><i></i></div> <span class="muted small">Building your quiz…</span>';
  openModal('quizModal');
  try {
    const txt = await llm([
      { role: 'system', content: 'You write quiz questions. Reply with ONE JSON object only, no prose.' },
      { role: 'user', content: 'Subject: ' + (subject || 'General') + '\nTopic: ' + topic + '\nWrite exactly 3 multiple-choice questions of increasing difficulty. Each has exactly 4 options and one correct answer.\nJSON shape: {"questions": [{"q": "...", "options": ["A","B","C","D"], "answer": 0, "explanation": "one or two sentences"}]} where answer is the 0-based index of the correct option.' },
    ], { json: true, temperature: 0.5 });
    const data = parseJson(txt);
    const raw = data && Array.isArray(data.questions) ? data.questions : (Array.isArray(data) ? data : []);
    const qs = [];
    raw.forEach((q) => {
      if (!q || !Array.isArray(q.options) || q.options.length !== 4) return;
      let ans = q.answer;
      if (typeof ans === 'string') { const i = 'ABCD'.indexOf(ans.trim().toUpperCase().charAt(0)); ans = i; }
      if (!Number.isInteger(ans) || ans < 0 || ans > 3) return;
      const text = String(q.q || '').trim();
      if (!text) return;
      qs.push({ q: text.slice(0, 400), options: q.options.map((o) => String(o).slice(0, 200)), answer: ans, explanation: String(q.explanation || '').slice(0, 400) });
    });
    if (qs.length < 3) bad('AI could not build a full quiz. Please try again.');
    S.quiz.qs = qs.slice(0, 3);
    renderQuizQ();
  } catch (e) {
    $('quizBody').innerHTML = '<div class="form-error">' + esc(e.message) + '</div><button class="btn" id="quizRetry" type="button">Try again</button>';
    $('quizRetry').addEventListener('click', () => openQuiz(b));
  }
}
function renderQuizQ() {
  const q = S.quiz;
  if (!q || !q.qs.length) return;
  if (q.i >= q.qs.length) { renderQuizResult(); return; }
  const cur = q.qs[q.i];
  q.answered = false;
  let h = '<div class="quiz-prog">Question ' + (q.i + 1) + ' of ' + q.qs.length + '</div><div class="quiz-q">' + esc(cur.q) + '</div>';
  cur.options.forEach((o, idx) => { h += '<button type="button" class="quiz-opt" data-idx="' + idx + '">' + 'ABCD'[idx] + '. ' + esc(o) + '</button>'; });
  h += '<div id="quizFeedback"></div>';
  $('quizBody').innerHTML = h;
}
function answerQuiz(idx) {
  const q = S.quiz;
  if (!q || q.answered) return;
  q.answered = true;
  const cur = q.qs[q.i];
  $('quizBody').querySelectorAll('.quiz-opt').forEach((el, i) => {
    el.classList.add('disabled');
    if (i === cur.answer) el.classList.add('correct'); else if (i === idx) el.classList.add('wrong');
  });
  if (idx === cur.answer) q.score++;
  const last = q.i === q.qs.length - 1;
  $('quizFeedback').innerHTML = '<div class="quiz-expl"><b>' + (idx === cur.answer ? '✅ Correct.' : '❌ Not quite.') + '</b> ' + esc(cur.explanation) + '</div>' +
    '<button class="btn primary" id="quizNext" type="button">' + (last ? 'See results' : 'Next question') + '</button>';
  $('quizNext').addEventListener('click', () => { q.i++; renderQuizQ(); });
}
function renderQuizResult() {
  const q = S.quiz, total = q.qs.length;
  const msg = q.score === total ? 'Perfect! You have this topic locked in. 🎉' : q.score >= 2 ? 'Good job. A quick revision will make it solid.' : 'This topic needs more work. PulseBot has flagged it as a weak topic.';
  $('quizBody').innerHTML = '<div class="quiz-score"><b>' + q.score + ' / ' + total + '</b><span class="muted">' + esc(msg) + '</span></div>' +
    '<div class="modal-actions"><button class="btn primary" id="quizAgain" type="button">New quiz</button><button class="btn" id="quizDone" type="button">Close</button></div>';
  $('quizAgain').addEventListener('click', () => openQuiz({ topic: q.topic, title: q.topic, subject: q.subject }));
  $('quizDone').addEventListener('click', () => closeModal('quizModal'));
  const topic = q.topic.slice(0, 120);
  S.doc.weak_topics = S.doc.weak_topics.filter((w) => String(w.topic).toLowerCase() !== topic.toLowerCase());
  if (q.score < total) S.doc.weak_topics.push({ topic, subject: q.subject.slice(0, 60), last_score: q.score + '/' + total, updated: nowIso() });
  S.doc.weak_topics = S.doc.weak_topics.slice(-30);
  save();
}

/* ======================= ADD BLOCK / PLAN CREATION ======================= */
function openAddBlock() {
  if (!activePlan()) { toast('Create a plan first'); openPlanModal(); return; }
  $('abTitle').value = ''; $('abSubject').value = '';
  $('abType').value = 'task'; $('abPriority').value = 'P3';
  $('abDate').value = ymd(S.anchor);
  $('abStart').value = '09:00';
  $('abDuration').value = S.doc.settings.default_session || 50;
  $('abRepeat').value = 0;
  openModal('addBlockModal');
}
function addBlockFromForm() {
  const plan = activePlan();
  if (!plan) return;
  const title = $('abTitle').value.trim();
  if (!title) bad('Enter a title');
  if (!$('abDate').value || !$('abStart').value) bad('Pick a date and start time');
  const type = $('abType').value;
  const d0 = parseYmd(validDate($('abDate').value));
  const s = validHm($('abStart').value);
  const dur = parseInt($('abDuration').value, 10);
  if (!(dur >= 5 && dur <= 480)) bad('Duration must be 5–480 minutes');
  checkFit(s, dur);
  const reps = clamp($('abRepeat').value, 0, 15, 0);
  for (let i = 0; i <= reps; i++) {
    plan.blocks.push(makeBlock({ title, type, subject: $('abSubject').value.trim(), priority: $('abPriority').value, date: ymd(addDays(d0, 7 * i)), startMin: s, duration: dur }, S.doc.settings));
  }
  save();
  S.anchor = d0;
  closeModal('addBlockModal');
  renderCalendar();
  toast('Block added', 'ok');
}

function addSubjectRow(name, level) {
  const row = document.createElement('div');
  row.className = 'subj-row';
  row.innerHTML = '<input type="text" maxlength="60" placeholder="Subject name" class="sr-name">' +
    '<select class="sr-level"><option value="weak">Weak</option><option value="medium">Medium</option><option value="strong">Strong</option></select>' +
    '<button type="button" class="icon-btn sr-del" aria-label="Remove subject">✕</button>';
  row.querySelector('.sr-name').value = name || '';
  row.querySelector('.sr-level').value = level || 'medium';
  row.querySelector('.sr-del').addEventListener('click', () => {
    if ($('subjectList').children.length > 1) row.remove(); else row.querySelector('.sr-name').value = '';
  });
  $('subjectList').appendChild(row);
}
function openPlanModal() {
  $('planForm').reset();
  hideErr($('planError'));
  $('plName').value = ''; $('plGoal').value = '';
  $('plStart').value = todayStr(); $('plExam').value = '';
  $('plDays').value = 7; $('plHours').value = 3;
  $('plSession').value = S.doc.settings.default_session || 50;
  $('subjectList').innerHTML = '';
  addSubjectRow('', 'medium');
  $('planAiNote').textContent = getKey()
    ? 'AI key found: topics will be written by AI, then placed around your calendar.'
    : 'No Groq key yet: a standard plan will be built instantly. Add a key in Settings for AI-written topics.';
  openModal('planModal');
}

async function aiPlanTasks(o, subjects) {
  const totalMin = Math.round(o.days * o.hours * 60);
  const approx = Math.max(4, Math.min(80, Math.floor(totalMin / Math.max(20, o.session - 10))));
  const weak = S.doc.weak_topics.slice(0, 8).map((w) => w.topic).join(', ') || 'none';
  const txt = await llm([
    { role: 'system', content: 'You are an expert study-planning engine. Reply with ONE JSON object only, no prose, no markdown fences.' },
    { role: 'user', content: 'Create study tasks for a student.\nSubjects (with strength): ' + subjects.map((s) => s.name + ' (' + s.level + ')').join('; ') +
      '\nGoal: ' + (o.goal || 'general mastery') + '\nExam date: ' + (o.exam || 'not set') +
      '\nPlan length: ' + o.days + ' days, about ' + o.hours + ' study hours per day.\nKnown weak topics to revisit: ' + weak +
      '\nGive about ' + approx + ' tasks. Weak subjects get more and earlier tasks. Mix deep "focus" sessions (~' + o.session + ' min) with shorter "task" items (practice problems, revision, mock tests, flashcards, 20-45 min).' +
      '\nJSON shape: {"plan_name": "short name", "tasks": [{"title": "specific action", "subject": "subject name", "topic": "specific topic", "kind": "focus" or "task", "duration": minutes multiple of 5 between 20 and 90, "priority": "P1".."P4" (P1 most urgent), "day": day number 1-' + o.days + '}]}' },
  ], { json: true, temperature: 0.5 });
  const data = parseJson(txt);
  const raw = data && Array.isArray(data.tasks) ? data.tasks : (Array.isArray(data) ? data : []);
  const tasks = [];
  raw.slice(0, 80).forEach((t) => {
    if (!t) return;
    const title = String(t.title || t.topic || '').trim();
    if (!title) return;
    const pr = String(t.priority || 'P2').toUpperCase();
    tasks.push({
      title: title.slice(0, 100), subject: String(t.subject || '').slice(0, 60), topic: String(t.topic || '').slice(0, 120),
      type: String(t.kind || 'task').toLowerCase() === 'focus' ? 'focus' : 'task',
      duration: clamp(Math.round((Number(t.duration) || 45) / 5) * 5, 15, 120, 45),
      priority: PRIORITIES.indexOf(pr) >= 0 ? pr : 'P2', pref: clamp(t.day, 1, o.days, 1) - 1,
    });
  });
  const name = data && !Array.isArray(data) && data.plan_name ? String(data.plan_name).slice(0, 60) : '';
  return { tasks: tasks.length >= 3 ? tasks : [], name };
}
function fallbackTasks(o, subjects) {
  const total = Math.round(o.days * o.hours * 60);
  const order = subjects.slice().sort((a, b) => ({ weak: 0, medium: 1, strong: 2 }[a.level] - { weak: 0, medium: 1, strong: 2 }[b.level]));
  const pr = { weak: 'P1', medium: 'P2', strong: 'P3' };
  const patterns = [['Deep study', 'focus', o.session], ['Practice problems', 'task', 30], ['Quick revision', 'task', 25]];
  const items = [];
  let minutes = 0, rnd = 0;
  while (minutes < total && items.length < 80) {
    for (let i = 0; i < order.length; i++) {
      const s = order[i], p = patterns[rnd % patterns.length];
      items.push({ title: p[0] + ': ' + s.name, subject: s.name, topic: '', type: p[1], duration: p[2], priority: pr[s.level] || 'P2' });
      minutes += p[2];
      if (minutes >= total || items.length >= 80) break;
    }
    rnd++;
  }
  items.forEach((it, i) => { it.pref = Math.min(o.days - 1, Math.floor((i * o.days) / Math.max(1, items.length))); });
  return items;
}

async function generatePlan() {
  hideErr($('planError'));
  if (S.doc.plans.length >= MAX_PLANS) { showErr($('planError'), 'You have ' + MAX_PLANS + ' plans. Delete an old one first.'); return; }
  const subjects = [];
  $('subjectList').querySelectorAll('.subj-row').forEach((r) => {
    const n = r.querySelector('.sr-name').value.trim();
    if (n) subjects.push({ name: n.slice(0, 60), level: r.querySelector('.sr-level').value });
  });
  if (!subjects.length) { showErr($('planError'), 'Add at least one subject.'); return; }
  const start = $('plStart').value;
  if (!start) { showErr($('planError'), 'Pick a start date.'); return; }
  const days = parseInt($('plDays').value, 10), hours = parseFloat($('plHours').value), session = parseInt($('plSession').value, 10);
  if (!(days >= 1 && days <= 21)) { showErr($('planError'), 'Days must be between 1 and 21.'); return; }
  if (!(hours >= 0.5 && hours <= 10)) { showErr($('planError'), 'Hours per day must be between 0.5 and 10.'); return; }
  if (!(session >= 20 && session <= 120)) { showErr($('planError'), 'Session length must be between 20 and 120 minutes.'); return; }
  const o = { days, hours, session, goal: $('plGoal').value.trim(), exam: $('plExam').value || null };
  const btn = $('planGenBtn'), label = btn.textContent;
  btn.classList.add('loading');
  let tasks = [], warning = '', aiName = '', aiUsed = false;
  try {
    if (getKey()) {
      btn.textContent = 'Generating… (about 20s)';
      try {
        const r = await aiPlanTasks(o, subjects.slice(0, 10));
        tasks = r.tasks; aiName = r.name; aiUsed = tasks.length > 0;
        if (!aiUsed) warning = 'AI returned an unusable plan, so a standard plan was created.';
      } catch (e) { warning = 'AI unavailable (' + String(e.message).slice(0, 90) + '). A standard plan was created.'; }
    }
    if (!tasks.length) tasks = fallbackTasks(o, subjects.slice(0, 10));
    const startD = parseYmd(start);
    const plan = {
      id: newId(10), name: ($('plName').value.trim() || aiName || 'Plan from ' + start).slice(0, 60),
      goal: o.goal.slice(0, 200), created_at: nowIso(), blocks: [],
    };
    S.doc.plans.push(plan);
    S.doc.active_plan_id = plan.id;
    syncPlanHabits(plan, startD, Math.max(HABIT_HORIZON, days + 1));
    const r = schedule(tasks, plan.blocks, startD, days, S.doc.settings, Math.round(hours * 60), start === todayStr() ? nowMin() : null, true);
    r.placed.forEach((p) => {
      plan.blocks.push(makeBlock({ title: p.it.title, type: p.it.type, subject: p.it.subject, topic: p.it.topic, priority: p.it.priority, date: p.ds, startMin: p.t, duration: p.it.duration }, S.doc.settings));
    });
    save();
    clearPreview(true);
    S.anchor = startD;
    closeModal('planModal');
    if (S.view !== 'calendar') setView('calendar'); else renderCalendar();
    scrollToNow();
    toast(warning || (aiUsed ? 'AI plan created ✨' : 'Plan created ✨'), warning ? '' : 'ok');
    if (r.unplaced.length) toast(r.unplaced.length + ' task(s) did not fit. Try more hours per day.');
  } catch (e) {
    showErr($('planError'), e.message);
  } finally {
    btn.textContent = label;
    btn.classList.remove('loading');
  }
}
function blankPlan() {
  if (S.doc.plans.length >= MAX_PLANS) bad('You have ' + MAX_PLANS + ' plans. Delete an old one first.');
  const plan = { id: newId(10), name: ($('plName').value.trim() || 'My Study Plan').slice(0, 60), goal: '', created_at: nowIso(), blocks: [] };
  S.doc.plans.push(plan);
  S.doc.active_plan_id = plan.id;
  syncPlanHabits(plan, new Date());
  save();
  clearPreview(true);
  closeModal('planModal');
  if (S.view !== 'calendar') setView('calendar'); else renderCalendar();
  toast('Blank plan created. Add blocks with ＋ Block.', 'ok');
}
async function deletePlan() {
  const plan = activePlan();
  if (!plan) return;
  const ok = await confirmBox('Delete plan?', '“' + plan.name + '” and all its blocks will be permanently deleted.', 'Delete plan');
  if (!ok) return;
  S.doc.plans = S.doc.plans.filter((p) => p.id !== plan.id);
  S.doc.active_plan_id = S.doc.plans.length ? S.doc.plans[0].id : null;
  clearPreview(true);
  save();
  renderCalendar();
  toast('Plan deleted', 'ok');
}
function switchPlan(id) {
  if (!id || id === S.doc.active_plan_id) return;
  clearPreview(true);
  S.doc.active_plan_id = id;
  save();
  renderCalendar();
  scrollToNow();
}

/* ======================= EXPORT ICS / PRINT ======================= */
function icsEsc(s) { return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }
function icsFold(line) {
  const chars = Array.from(line);
  if (chars.length <= 60) return line;
  const parts = [];
  for (let i = 0; i < chars.length; i += 60) parts.push(chars.slice(i, i + 60).join(''));
  return parts.join('\r\n ');
}
function downloadFile(name, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}
function exportIcs() {
  const plan = activePlan();
  if (!plan) return;
  const blocks = plan.blocks.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!blocks.length) { toast('Nothing to export yet'); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LearnPulse OS//Viswesh & Team Dept of CSE//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc('LearnPulse: ' + plan.name)];
  blocks.forEach((b) => {
    const s = hm2m(b.start), e = s + b.duration, d = b.date.replace(/-/g, '');
    const desc = [TYPE_LABEL[b.type] || b.type, b.subject ? 'Subject: ' + b.subject : '', b.topic ? 'Topic: ' + b.topic : '', b.type === 'task' ? 'Priority: ' + b.priority : '', 'Planned with LearnPulse OS'].filter(Boolean).join(' | ');
    L.push('BEGIN:VEVENT', 'UID:' + b.id + '@learnpulse-os', 'DTSTAMP:' + stamp,
      'DTSTART:' + d + 'T' + pad(Math.floor(s / 60)) + pad(s % 60) + '00', 'DTEND:' + d + 'T' + pad(Math.floor(e / 60)) + pad(e % 60) + '00',
      'SUMMARY:' + icsEsc((b.done ? '✓ ' : '') + b.title), 'DESCRIPTION:' + icsEsc(desc), 'TRANSP:' + (b.defense === 'busy' ? 'OPAQUE' : 'TRANSPARENT'), 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  downloadFile('learnpulse-' + (plan.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.ics', L.map(icsFold).join('\r\n') + '\r\n', 'text/calendar;charset=utf-8');
  toast('Calendar file ready. Import it in Google Calendar → Settings → Import.', 'ok');
}
function printSchedule() {
  const plan = activePlan();
  if (!plan) return;
  const blocks = plan.blocks.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const byDate = {};
  blocks.forEach((b) => { (byDate[b.date] = byDate[b.date] || []).push(b); });
  let h = '<div class="pr-head"><h1>LearnPulse OS · Study Plan</h1><p>' + esc(plan.name) + ' · Student: ' + esc(S.doc.username) + ' · Printed ' + esc(dateLabel(todayStr())) + ' ' + new Date().getFullYear() + '</p></div>';
  Object.keys(byDate).sort().forEach((d) => {
    h += '<div class="pr-day"><h2>' + esc(dateLabel(d)) + ' ' + d.slice(0, 4) + '</h2><table class="pr-table"><thead><tr><th>Time</th><th>Activity</th><th>Type</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead><tbody>';
    byDate[d].forEach((b) => {
      const s = hm2m(b.start);
      h += '<tr><td>' + fmt12(s) + ' – ' + fmt12(s + b.duration) + '</td><td>' + esc(b.title) + (b.locked ? ' 🔒' : '') + '</td><td>' + esc(TYPE_LABEL[b.type] || b.type) + '</td><td>' + esc(b.subject || '') + '</td><td>' + (b.type === 'task' ? esc(b.priority) : '') + '</td><td>' + (b.done ? 'Done' : '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  });
  if (!blocks.length) h += '<p>No blocks scheduled.</p>';
  h += '<div class="pr-foot">LearnPulse OS — Viswesh &amp; Team, Dept of CSE</div>';
  $('printArea').innerHTML = h;
  setTimeout(() => window.print(), 100);
}

/* ======================= HABITS UI ======================= */
function renderHabits() {
  const el = $('habitList');
  const habits = S.doc.habits;
  if (!habits.length) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">🔁</div><h3>No habits yet</h3><p>Add a routine like “Morning revision” and LearnPulse will fit it into your calendar every day.</p></div>';
    return;
  }
  el.innerHTML = habits.map((h) => {
    const days = HDOW.map((d, i) => '<span class="hc-day' + (h.days.indexOf(i) >= 0 ? ' on' : '') + '">' + d + '</span>').join('');
    return '<div class="habit-card" data-id="' + esc(h.id) + '"><div class="hc-name">' + esc(h.name) + '</div>' +
      '<div class="hc-meta"><span>⏱ ' + h.duration + ' min</span><span>🕒 ' + fmt12(h.earliest) + ' – ' + fmt12(h.latest) + '</span><span>⭐ ideal ' + fmt12(h.ideal) + '</span><span>' + (h.defense === 'busy' ? '🛡️ Busy' : '🔓 Free') + '</span></div>' +
      '<div class="hc-days">' + days + '</div>' +
      '<div class="hc-actions"><button class="btn sm hc-edit" type="button">Edit</button><button class="btn sm danger-ghost hc-del" type="button">Delete</button></div></div>';
  }).join('');
}
function openHabitModal(h) {
  S.editHabit = h ? h.id : null;
  hideErr($('habitError'));
  $('habitHeading').textContent = h ? 'Edit habit' : 'New habit';
  $('hbName').value = h ? h.name : '';
  $('hbDuration').value = h ? h.duration : 30;
  $('hbDefense').value = h ? h.defense : 'busy';
  $('hbEarliest').value = h ? h.earliest : '07:00';
  $('hbIdeal').value = h ? h.ideal : '08:00';
  $('hbLatest').value = h ? h.latest : '10:00';
  $('hbDays').querySelectorAll('input').forEach((c) => { c.checked = h ? h.days.indexOf(+c.value) >= 0 : true; });
  openModal('habitModal');
}
function saveHabit() {
  hideErr($('habitError'));
  const days = [];
  $('hbDays').querySelectorAll('input').forEach((c) => { if (c.checked) days.push(+c.value); });
  if (!$('hbEarliest').value || !$('hbIdeal').value || !$('hbLatest').value) { showErr($('habitError'), 'Fill in all three times.'); return; }
  try {
    const h = cleanHabit({
      name: $('hbName').value, duration: parseInt($('hbDuration').value, 10) || 30, earliest: $('hbEarliest').value,
      ideal: $('hbIdeal').value, latest: $('hbLatest').value, days, defense: $('hbDefense').value,
    }, S.editHabit);
    if (S.editHabit) {
      const i = S.doc.habits.findIndex((x) => x.id === S.editHabit);
      if (i < 0) bad('Habit not found');
      S.doc.habits[i] = h;
    } else {
      if (S.doc.habits.length >= 15) bad('Maximum 15 habits');
      S.doc.habits.push(h);
    }
    syncAllHabits(new Date());
    save();
    closeModal('habitModal');
    renderHabits();
    toast('Habit saved', 'ok');
  } catch (e) { showErr($('habitError'), e.message); }
}
async function deleteHabit(h) {
  const ok = await confirmBox('Delete habit?', '“' + h.name + '” and its upcoming calendar blocks will be removed.', 'Delete');
  if (!ok) return;
  S.doc.habits = S.doc.habits.filter((x) => x.id !== h.id);
  syncAllHabits(new Date());
  save();
  renderHabits();
  toast('Habit deleted', 'ok');
}

/* ======================= FOCUS TIMER ======================= */
const T = { minutes: 50, total: 3000, remaining: 3000, running: false, endAt: 0, iv: null };
const RING_C = 339.292;

function focusToday() { const a = S.doc && S.doc.activity[todayStr()]; return a ? (a.focus || 0) : 0; }
function updateFocusStats() {
  if (!S.doc) return;
  $('focusToday').textContent = String(focusToday());
  $('focusWeek').textContent = String(weekMinutes('focus'));
}
function renderTimer() {
  const m = Math.floor(T.remaining / 60), s = T.remaining % 60;
  $('timerDisplay').textContent = pad(m) + ':' + pad(s);
  $('timerRing').style.strokeDashoffset = String(RING_C * (1 - T.remaining / T.total));
  const started = T.remaining < T.total;
  $('timerStart').hidden = T.running;
  $('timerStart').textContent = started ? '▶ Resume' : '▶ Start';
  $('timerPause').hidden = !T.running;
  $('timerFinish').hidden = !started;
}
function stopTimer(reset) {
  T.running = false;
  if (T.iv) { clearInterval(T.iv); T.iv = null; }
  if (reset) T.remaining = T.total;
  renderTimer();
}
function setTimerMinutes(min) {
  T.minutes = min; T.total = min * 60; T.remaining = T.total;
  document.querySelectorAll('#focusChips .chip').forEach((c) => c.classList.toggle('active', +c.dataset.min === min));
  renderTimer();
}
function beep() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ctx = new AC();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 880; g.gain.value = 0.15; o.start();
    setTimeout(() => { o.stop(); ctx.close(); }, 600);
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  } catch (e) { /* ignore */ }
}
function startTimer() {
  if (T.remaining <= 0) T.remaining = T.total;
  T.running = true;
  T.endAt = Date.now() + T.remaining * 1000;
  if (T.iv) clearInterval(T.iv);
  T.iv = setInterval(tickTimer, 250);
  renderTimer();
}
function tickTimer() {
  T.remaining = Math.max(0, Math.round((T.endAt - Date.now()) / 1000));
  renderTimer();
  if (T.remaining <= 0) completeTimer();
}
function logFocus(minutes) {
  const todayS = todayStr();
  logMinutes(todayS, minutes, 'focus');
  bumpStreak(todayS);
  S.doc.focus_sessions.push({ date: todayS, minutes, subject: $('focusSubject').value.trim().slice(0, 60), at: nowIso() });
  S.doc.focus_sessions = S.doc.focus_sessions.slice(-200);
  save();
  refreshStreakPill();
  updateFocusStats();
}
function completeTimer() {
  const mins = T.minutes;
  stopTimer(true);
  beep();
  logFocus(mins);
  toast('Session complete! ' + mins + ' min logged 🎯', 'ok');
}
function finishTimer() {
  const mins = Math.floor((T.total - T.remaining) / 60);
  if (mins < 1) { toast('Focus for at least 1 minute to log a session'); return; }
  stopTimer(true);
  logFocus(mins);
  toast(mins + ' min logged 🎯', 'ok');
}

/* ======================= ANALYTICS ======================= */
function computeAnalytics() {
  const st = S.doc.settings, plan = activePlan(), blocks = plan ? plan.blocks : [];
  const ws = weekStart(new Date());
  const wk = new Set(Array.from({ length: 7 }, (_, i) => ymd(addDays(ws, i))));
  const defended = blocks.filter((b) => wk.has(b.date) && b.defense === 'busy').reduce((a, b) => a + b.duration, 0);
  const cat = { Focus: 0, Tasks: 0, Habits: 0, Classes: 0 };
  const key = { focus: 'Focus', task: 'Tasks', habit: 'Habits', fixed: 'Classes' };
  const subj = {};
  blocks.forEach((b) => {
    cat[key[b.type] || 'Tasks'] += b.duration;
    if (b.type === 'task' || b.type === 'focus') {
      const s = b.subject || 'General';
      subj[s] = subj[s] || [0, 0];
      subj[s][0]++; if (b.done) subj[s][1]++;
    }
  });
  cat.Buffers = computeBuffers(blocks, +st.buffer_min).reduce((a, x) => a + x.duration, 0);
  const labels = Object.keys(cat);
  const subjects = Object.keys(subj).sort((a, b) => subj[b][0] - subj[a][0]).slice(0, 8)
    .map((k) => ({ subject: k, total: subj[k][0], done: subj[k][1], pct: Math.round(100 * subj[k][1] / subj[k][0]) }));
  const goalMin = Math.round(+st.weekly_goal_hours * 60), logged = weekMinutes();
  const studyBlocks = blocks.filter((b) => b.type === 'task' || b.type === 'focus');
  return {
    goalHours: st.weekly_goal_hours, logged, pct: goalMin ? Math.min(100, Math.round(100 * logged / goalMin)) : 0,
    defendedHours: Math.round(defended / 6) / 10, labels, hours: labels.map((l) => Math.round(cat[l] / 6) / 10), subjects,
    done: studyBlocks.filter((b) => b.done).length, total: studyBlocks.length,
  };
}
function loadAnalytics() {
  const a = computeAnalytics();
  $('goalLabel').textContent = (a.logged / 60).toFixed(1) + ' / ' + a.goalHours + ' h';
  $('goalBar').style.width = a.pct + '%';
  $('goalPct').textContent = a.pct + '% of weekly goal';
  $('kpiStreak').textContent = String(streakNow());
  $('kpiDefended').textContent = a.defendedHours + ' h';
  $('kpiTasks').textContent = a.done + '/' + a.total;
  drawCharts(a);
}
function drawCharts(a) {
  if (typeof Chart === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const text = cs.getPropertyValue('--text').trim() || '#0f172a';
  const muted = cs.getPropertyValue('--muted').trim() || '#64748b';
  const grid = cs.getPropertyValue('--border').trim() || '#e2e8f0';
  const surface = cs.getPropertyValue('--surface').trim() || '#fff';
  Chart.defaults.color = muted;
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  if (S.charts.alloc) S.charts.alloc.destroy();
  if (S.charts.subjects) S.charts.subjects.destroy();
  S.charts.alloc = new Chart($('chartAlloc'), {
    type: 'doughnut',
    data: { labels: a.labels, datasets: [{ data: a.hours, backgroundColor: ['#14b8a6', '#3b82f6', '#8b5cf6', '#64748b', '#94a3b8'], borderColor: surface, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: { legend: { position: 'bottom', labels: { color: text, boxWidth: 12, padding: 12 } }, tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + c.parsed + ' h' } } },
    },
  });
  S.charts.subjects = new Chart($('chartSubjects'), {
    type: 'bar',
    data: { labels: a.subjects.map((s) => s.subject), datasets: [{ data: a.subjects.map((s) => s.pct), backgroundColor: '#14b8a6', borderRadius: 6, maxBarThickness: 26 }] },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: { x: { min: 0, max: 100, grid: { color: grid }, ticks: { color: muted, callback: (v) => v + '%' } }, y: { grid: { display: false }, ticks: { color: text } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ' ' + c.parsed.x + '% (' + a.subjects[c.dataIndex].done + '/' + a.subjects[c.dataIndex].total + ')' } } },
    },
  });
}

/* ======================= SETTINGS ======================= */
function fillSettings() {
  const s = S.doc.settings;
  $('setStart').value = s.study_start; $('setEnd').value = s.study_end;
  $('setBuffer').value = s.buffer_min; $('setMaxDaily').value = s.max_daily_hours;
  $('setWeeklyGoal').value = s.weekly_goal_hours; $('setDefense').value = s.defense_mode;
  $('setSession').value = s.default_session;
}
function saveSettings() {
  const s = Object.assign({}, S.doc.settings);
  const st = validHm($('setStart').value), en = validHm($('setEnd').value);
  s.study_start = m2hm(Math.max(DAY_START, Math.min(DAY_END, st)));
  s.study_end = m2hm(Math.max(DAY_START, Math.min(DAY_END, en)));
  if (hm2m(s.study_end) - hm2m(s.study_start) < 60) bad('Study end must be at least 1 hour after study start');
  s.buffer_min = clamp($('setBuffer').value, 0, 60, 15);
  const md_ = parseFloat($('setMaxDaily').value), wg = parseFloat($('setWeeklyGoal').value);
  if (!isFinite(md_) || !isFinite(wg)) bad('Enter valid numbers for hours');
  s.max_daily_hours = Math.max(1, Math.min(14, md_));
  s.weekly_goal_hours = Math.max(1, Math.min(100, wg));
  s.defense_mode = $('setDefense').value === 'reactive' ? 'reactive' : 'proactive';
  s.default_session = clamp($('setSession').value, 15, 120, 50);
  S.doc.settings = s;
  save();
  fillSettings();
  toast('Scheduling saved', 'ok');
}
function fillAiSettings() {
  $('setGroqKey').value = getKey();
  $('setGroqKey').type = 'password';
  $('keyToggle').textContent = 'Show';
  $('setVisionModel').value = S.doc.settings.vision_model || DEFAULT_VISION;
  setAiStatus(getKey() ? 'A key is saved on this device.' : 'No key saved. AI features are off until you add one.', '');
}
function setAiStatus(msg, cls) { const el = $('aiStatus'); el.textContent = msg; el.className = 'muted small status-line' + (cls ? ' ' + cls : ''); }
function saveAiSettings() {
  const k = $('setGroqKey').value.trim();
  if (k && k.length < 20) bad('That does not look like a full Groq key.');
  setKey(k);
  S.doc.settings.vision_model = $('setVisionModel').value.trim() || DEFAULT_VISION;
  save();
  fillAiSettings();
  toast('AI settings saved', 'ok');
}
async function testKey() {
  const k = $('setGroqKey').value.trim() || getKey();
  if (!k) { setAiStatus('Enter a key first.', 'err'); return; }
  setAiStatus('Testing…', '');
  try {
    const res = await fetch(GROQ_MODELS_URL, { headers: { Authorization: 'Bearer ' + k } });
    if (res.ok) setAiStatus('✓ Connected to Groq. Your key works.', 'ok');
    else if (res.status === 401 || res.status === 403) setAiStatus('✗ Groq rejected this key.', 'err');
    else setAiStatus('✗ Groq answered with error ' + res.status + '.', 'err');
  } catch (e) { setAiStatus('✗ Cannot reach Groq. Check your internet connection.', 'err'); }
}
async function removeKey() {
  if (!getKey()) { toast('No key saved'); return; }
  const ok = await confirmBox('Remove key?', 'The Groq key will be deleted from this device. AI features stop until you add one again.', 'Remove');
  if (!ok) return;
  setKey('');
  fillAiSettings();
  toast('Key removed', 'ok');
}

/* ======================= BACKUP ======================= */
function exportBackup() {
  const data = JSON.parse(JSON.stringify(S.doc));
  delete data.pin_hash; delete data.fails; delete data.locked_until;
  const payload = { app: 'LearnPulse OS', version: 8, exported_at: nowIso(), username: S.doc.username, data };
  downloadFile('learnpulse-backup-' + S.uid.replace(/[^a-z0-9]+/g, '-') + '-' + todayStr() + '.json', JSON.stringify(payload, null, 2), 'application/json');
  toast('Backup downloaded. Your Groq key is not included.', 'ok');
}
async function importBackup(file) {
  let text;
  try { text = await file.text(); } catch (e) { bad('Could not read that file.'); }
  let p;
  try { p = JSON.parse(text); } catch (e) { bad('That file is not valid JSON.'); }
  if (!p || p.app !== 'LearnPulse OS' || !p.data || typeof p.data !== 'object') bad('That is not a LearnPulse OS backup file.');
  const incoming = p.data;
  ['plans', 'habits', 'chat', 'weak_topics', 'scans', 'focus_sessions', 'habit_skips'].forEach((k) => {
    if (incoming[k] !== undefined && !Array.isArray(incoming[k])) bad('Backup file is damaged (' + k + ').');
  });
  const when = p.exported_at ? new Date(p.exported_at).toLocaleDateString() : 'unknown date';
  const ok = await confirmBox('Replace your data?', 'All plans, habits and history in this account will be replaced with the backup from “' + (p.username || 'unknown') + '” (' + when + '). This cannot be undone.', 'Replace data');
  if (!ok) return;
  const keep = { username: S.doc.username, pin_hash: S.doc.pin_hash, fails: 0, locked_until: 0 };
  const merged = normalize(Object.assign({}, incoming, keep));
  clearPreview(true);
  S.doc = merged;
  save();
  syncAllHabits(new Date());
  save();
  S.anchor = new Date();
  refreshStreakPill();
  fillSettings(); fillAiSettings();
  toast('Backup imported ✓', 'ok');
}

/* ======================= PULSEBOT ======================= */
function buildContext() {
  const d = S.doc, st = d.settings, t = todayStr(), plan = activePlan();
  const lines = [
    'Student: ' + d.username, 'Today: ' + t + ' ' + m2hm(nowMin()), 'Streak: ' + streakNow() + ' days',
    'Weekly focus goal: ' + st.weekly_goal_hours + ' h, logged so far: ' + (weekMinutes() / 60).toFixed(1) + ' h',
    'Study window: ' + st.study_start + '-' + st.study_end + ', buffer ' + st.buffer_min + ' min, defense mode: ' + st.defense_mode,
  ];
  if (plan) {
    lines.push('Active plan: ' + plan.name);
    const tb = plan.blocks.filter((b) => b.date === t).sort((a, b) => a.start.localeCompare(b.start));
    if (tb.length) {
      lines.push("Today's schedule:");
      tb.slice(0, 15).forEach((b) => {
        const flags = [b.type, b.priority]; if (b.locked) flags.push('locked'); if (b.done) flags.push('done');
        lines.push('- ' + b.start + '-' + m2hm(hm2m(b.start) + b.duration) + ' ' + b.title + ' [' + flags.join(', ') + ']');
      });
    } else lines.push('Nothing scheduled today.');
    const wkEnd = ymd(addDays(new Date(), 7));
    const pending = plan.blocks.filter((b) => (b.type === 'task' || b.type === 'focus') && !b.done && b.date >= t && b.date <= wkEnd);
    lines.push('Pending study blocks in next 7 days: ' + pending.length);
    const locked = plan.blocks.filter((b) => b.locked && b.date >= t).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start)).slice(0, 8);
    if (locked.length) lines.push('Upcoming locked blocks: ' + locked.map((b) => b.date + ' ' + b.start + ' ' + b.title).join('; '));
  } else lines.push('No study plan yet.');
  if (d.weak_topics.length) lines.push('Weak topics: ' + d.weak_topics.slice(-8).map((w) => w.topic + ' (' + (w.last_score || '') + ')').join(', '));
  if (d.habits.length) lines.push('Habits: ' + d.habits.map((h) => h.name).join(', '));
  return lines.join('\n');
}
function chatScroll() { const l = $('chatLog'); l.scrollTop = l.scrollHeight; }
function addBubble(role, content, isTyping) {
  const m = document.createElement('div');
  m.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  const b = document.createElement('div');
  b.className = 'bubble';
  if (isTyping) b.innerHTML = '<div class="typing"><i></i><i></i><i></i></div>';
  else if (role === 'user') { b.style.whiteSpace = 'pre-wrap'; b.textContent = content; }
  else { b.className = 'bubble md'; b.innerHTML = md(content); }
  m.appendChild(b);
  $('chatLog').appendChild(m);
  chatScroll();
  return m;
}
function renderChat() {
  const log = $('chatLog');
  log.innerHTML = '';
  const msgs = S.doc.chat;
  if (!msgs.length) {
    log.innerHTML = '<div class="chat-empty">👋 Hi ' + esc(S.doc.username) + '! I’m PulseBot, your study coach. Ask me what to study next, how to fix a weak topic, or how to organise your week.' +
      (getKey() ? '' : '<br><br>Add your free Groq key in Settings (or when asked) to chat.') + '</div>';
    return;
  }
  msgs.forEach((m) => addBubble(m.role, m.content));
}
function loadChat() { renderChat(); }
async function sendChat(text) {
  text = (text || '').trim().slice(0, 2000);
  if (!text || S.chatBusy) return;
  if (!(await ensureKey())) return;
  S.chatBusy = true;
  $('chatSend').classList.add('loading');
  const empty = $('chatLog').querySelector('.chat-empty');
  if (empty) empty.remove();
  addBubble('user', text);
  const typing = addBubble('bot', '', true);
  try {
    const system = 'You are PulseBot, the exclusive AI study coach inside LearnPulse OS, built by Viswesh & Team, Dept of CSE. Be warm, concise and practical. Format with Markdown (short lists, **bold**, fenced code blocks for code). Use plain-text math (no LaTeX). Ground your advice in the student context below. You cannot edit the calendar yourself; when a schedule change is needed, tell the student to tap the block (inspector) or use Rebalance. If you do not know something, say so.\n\n--- STUDENT CONTEXT ---\n' + buildContext();
    const history = S.doc.chat.slice(-12).map((m) => ({ role: m.role, content: m.content }));
    const reply = await llm([{ role: 'system', content: system }].concat(history, [{ role: 'user', content: text }]), { temperature: 0.6 });
    S.doc.chat.push({ role: 'user', content: text, ts: nowIso() });
    S.doc.chat.push({ role: 'assistant', content: reply, ts: nowIso() });
    S.doc.chat = S.doc.chat.slice(-60);
    save();
    typing.remove();
    addBubble('bot', reply);
  } catch (e) {
    typing.remove();
    addBubble('bot', '⚠️ ' + e.message);
  } finally {
    S.chatBusy = false;
    $('chatSend').classList.remove('loading');
  }
}

/* ======================= AI QUESTION SCANNER ======================= */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not read that image. Try a JPG or PNG photo.'));
    img.src = src;
  });
}
async function compressTo(src, maxDim, quality) {
  const img = await loadImage(src);
  let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
  if (!w || !h) bad('Could not read that image.');
  const sc = Math.min(1, maxDim / Math.max(w, h));
  w = Math.max(1, Math.round(w * sc)); h = Math.max(1, Math.round(h * sc));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  return c.toDataURL('image/jpeg', quality);
}
async function handleScanFile(file) {
  if (!file) return;
  if (file.type && file.type.indexOf('image/') !== 0) bad('Please choose an image file.');
  const url = URL.createObjectURL(file);
  try {
    S.scan.dataUrl = await compressTo(url, 1200, 0.82);
  } finally { URL.revokeObjectURL(url); }
  $('scanPreview').src = S.scan.dataUrl;
  $('scanPreviewWrap').hidden = false;
}
function clearScanImage() {
  S.scan.dataUrl = null;
  $('scanPreview').removeAttribute('src');
  $('scanPreviewWrap').hidden = true;
  $('scanCamInput').value = ''; $('scanGalInput').value = '';
}
const SCAN_MODES = {
  steps: 'Solve it step by step, explaining each step briefly.',
  short: 'Give a concise exam-style answer: what to write in an exam, with only the essential working.',
  concept: 'First explain the key concept(s) involved in a few lines, then solve it step by step.',
};
async function solveScan() {
  if (S.scanning) return;
  if (!S.scan.dataUrl) { toast('Take a photo or upload an image first'); return; }
  if (!(await ensureKey())) return;
  S.scanning = true;
  const btn = $('scanBtn'), label = btn.textContent;
  btn.textContent = 'Reading question…';
  btn.classList.add('loading');
  try {
    const subject = $('scanSubject').value.trim(), note = $('scanNote').value.trim();
    const model = (S.doc.settings.vision_model || DEFAULT_VISION).trim() || DEFAULT_VISION;
    const prompt = SCAN_MODES[S.scan.mode] + (subject ? '\nSubject: ' + subject : '') + (note ? '\nStudent note: ' + note : '');
    const txt = await llm([
      { role: 'system', content: 'You are an expert tutor. The image contains a student\'s question. Reply in Markdown with exactly these sections: "## Question Detected" (transcribe the question), "## Solution", "## Final Answer". If the image is unreadable or has no question, say so under Question Detected and ask for a clearer photo. Use plain-text math such as x^2 and sqrt(x), no LaTeX.' },
      { role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: S.scan.dataUrl } }] },
    ], { models: [model], temperature: 0.3, max_tokens: 3000, vision: true, timeout: 90000 });
    S.scan.result = txt;
    showScanResult(txt);
    let thumb = '';
    try { thumb = await compressTo(S.scan.dataUrl, 96, 0.6); } catch (e) { /* ignore */ }
    const m = txt.match(/##\s*Question Detected\s*\n+([\s\S]*?)(?:\n##|$)/i);
    const title = (m ? m[1] : txt).replace(/[#*`>\n]+/g, ' ').trim().slice(0, 90) || 'Scanned question';
    S.doc.scans.unshift({ id: newId(8), ts: nowIso(), subject: subject.slice(0, 60), mode: S.scan.mode, title, thumb, result: txt.slice(0, 8000) });
    S.doc.scans = S.doc.scans.slice(0, MAX_SCANS);
    save();
    renderScanHistory();
  } catch (e) {
    toast(e.message, 'error');
  } finally {
    S.scanning = false;
    btn.textContent = label;
    btn.classList.remove('loading');
  }
}
function showScanResult(txt) {
  S.scan.result = txt;
  $('scanResult').innerHTML = md(txt);
  $('scanResultCard').hidden = false;
  try { $('scanResultCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* ignore */ }
}
function renderScanHistory() {
  const el = $('scanHistory');
  const list = S.doc.scans;
  if (!list.length) { el.innerHTML = '<div class="sh-empty">No scans yet. Your last ' + MAX_SCANS + ' solutions appear here.</div>'; return; }
  el.innerHTML = list.map((s) =>
    '<button type="button" class="sh-item" data-id="' + esc(s.id) + '">' +
    (s.thumb ? '<img class="sh-thumb" alt="" src="' + esc(s.thumb) + '">' : '<span class="sh-thumb"></span>') +
    '<span class="sh-body"><span class="sh-title" style="display:block">' + esc(s.title) + '</span>' +
    '<span class="sh-meta">' + esc(new Date(s.ts).toLocaleString()) + (s.subject ? ' · ' + esc(s.subject) : '') + '</span></span></button>').join('');
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

/* ======================= EVENT WIRING ======================= */
function wire() {
  /* ----- login ----- */
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideErr($('loginError'));
    const btn = $('loginBtn');
    btn.classList.add('loading');
    try {
      if (!storageOk()) bad('Your browser is blocking storage, so accounts cannot be saved. Turn off private/incognito mode or "block all cookies", or open the site in Chrome/Safari directly (not inside another app).');
      const isNew = await doLogin($('loginUser').value, $('loginPin').value.trim());
      if (lsGet(K.acct + S.uid) === null) bad('Could not save your account in this browser. Check storage settings and try again.');
      $('loginPin').value = '';
      bootApp();
      if (isNew) toast('Welcome to LearnPulse OS! Create your first plan with ✨ AI Plan.', 'ok');
    } catch (err) {
      showErr($('loginError'), err.message || 'Could not sign in.');
    } finally { btn.classList.remove('loading'); }
  });
  $('loginPin').addEventListener('input', () => { $('loginPin').value = $('loginPin').value.replace(/\D/g, '').slice(0, 4); });
  $('logoutBtn').addEventListener('click', logout);
  $('themeBtn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  /* ----- nav + modals ----- */
  $('nav').addEventListener('click', (e) => { const b = e.target.closest('.nav-btn'); if (b) setView(b.dataset.view); });
  document.addEventListener('click', (e) => {
    const c = e.target.closest('[data-close]');
    if (c) { const m = c.closest('.modal'); if (m) closeModal(m.id); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const open = document.querySelectorAll('.modal:not([hidden])');
      if (open.length) closeModal(open[open.length - 1].id);
    }
  });
  $('confirmOk').addEventListener('click', () => {
    const r = confirmResolve; confirmResolve = null;
    closeModal('confirmModal');
    if (r) r(true);
  });
  $('keySave').addEventListener('click', saveKeyFromModal);
  $('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveKeyFromModal(); } });

  /* ----- calendar toolbar ----- */
  $('calPrev').addEventListener('click', () => shiftCalendar(-1));
  $('calNext').addEventListener('click', () => shiftCalendar(1));
  $('calToday').addEventListener('click', () => { S.anchor = new Date(); renderCalendar(); scrollToNow(); });
  $('viewSeg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-days]');
    if (!b) return;
    S.days = +b.dataset.days;
    renderCalendar(); scrollToNow();
  });
  $('planSelect').addEventListener('change', (e) => switchPlan(e.target.value));
  $('newPlanBtn').addEventListener('click', openPlanModal);
  $('emptyCreateBtn').addEventListener('click', openPlanModal);
  $('addBlockBtn').addEventListener('click', openAddBlock);
  $('rebalanceBtn').addEventListener('click', () => guard(startRebalance));
  $('exportIcsBtn').addEventListener('click', exportIcs);
  $('printBtn').addEventListener('click', printSchedule);
  $('deletePlanBtn').addEventListener('click', () => guard(deletePlan));
  $('applyPreviewBtn').addEventListener('click', () => guard(applyPreview));
  $('discardPreviewBtn').addEventListener('click', () => { clearPreview(); toast('Preview discarded'); });
  $('calGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.blk');
    if (b && b.dataset.id) openInspector(b.dataset.id);
  });

  /* ----- inspector ----- */
  $('inspDone').addEventListener('click', () => guard(toggleDone));
  $('inspLock').addEventListener('click', () => guard(() => { const b = curBlock(); if (b) patchSelected({ locked: !b.locked }, b.locked ? 'Unlocked. Rebalance may move it.' : 'Locked. Rebalance will not move it.'); }));
  $('inspDefense').addEventListener('click', () => guard(() => { const b = curBlock(); if (b) patchSelected({ defense: b.defense === 'busy' ? 'free' : 'busy' }, b.defense === 'busy' ? 'Time is now Free' : 'Time defended 🛡️'); }));
  $('inspForm').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(() => {
      const dur = parseInt($('inspDuration').value, 10);
      if (!(dur >= 5 && dur <= 480)) bad('Duration must be 5–480 minutes');
      if (!$('inspStart').value || !$('inspDate').value) bad('Pick a date and start time');
      patchSelected({
        title: $('inspTitle').value, subject: $('inspSubject').value, topic: $('inspTopic').value,
        date: $('inspDate').value, start: $('inspStart').value, duration: dur, priority: $('inspPriority').value,
      }, 'Saved');
      closeModal('inspectorModal');
    });
  });
  $('inspDelete').addEventListener('click', () => guard(deleteSelected));
  $('inspNotes').addEventListener('click', () => { const b = curBlock(); if (b) guard(() => openNotes(b, false)); });
  $('inspQuiz').addEventListener('click', () => { const b = curBlock(); if (b) guard(() => openQuiz(b)); });
  $('inspAsk').addEventListener('click', () => {
    const b = curBlock(); if (!b) return;
    closeModal('inspectorModal');
    setView('pulsebot');
    sendChat('Help me study "' + blockTopic(b) + '"' + (b.subject ? ' (' + b.subject + ')' : '') + '. I have a ' + b.duration + ' minute session scheduled.');
  });
  $('notesRefresh').addEventListener('click', () => { if (S.notesBlock) guard(() => openNotes(S.notesBlock, true)); });
  $('quizBody').addEventListener('click', (e) => { const o = e.target.closest('.quiz-opt'); if (o) answerQuiz(+o.dataset.idx); });

  /* ----- add block / plan ----- */
  $('addBlockForm').addEventListener('submit', (e) => { e.preventDefault(); guard(addBlockFromForm); });
  $('addSubjectBtn').addEventListener('click', () => { if ($('subjectList').children.length < 10) addSubjectRow('', 'medium'); });
  $('planForm').addEventListener('submit', (e) => { e.preventDefault(); generatePlan(); });
  $('blankPlanBtn').addEventListener('click', () => guard(blankPlan));

  /* ----- habits ----- */
  $('addHabitBtn').addEventListener('click', () => openHabitModal(null));
  $('habitList').addEventListener('click', (e) => {
    const card = e.target.closest('.habit-card'); if (!card) return;
    const h = S.doc.habits.find((x) => x.id === card.dataset.id); if (!h) return;
    if (e.target.closest('.hc-edit')) openHabitModal(h);
    else if (e.target.closest('.hc-del')) guard(() => deleteHabit(h));
  });
  $('habitForm').addEventListener('submit', (e) => { e.preventDefault(); saveHabit(); });

  /* ----- focus ----- */
  $('focusChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    if (T.running || T.remaining < T.total) { toast('Reset the timer to change its length'); return; }
    setTimerMinutes(+c.dataset.min);
  });
  $('timerStart').addEventListener('click', startTimer);
  $('timerPause').addEventListener('click', () => stopTimer(false));
  $('timerReset').addEventListener('click', () => stopTimer(true));
  $('timerFinish').addEventListener('click', () => { stopTimer(false); finishTimer(); });

  /* ----- scan ----- */
  $('scanCamBtn').addEventListener('click', () => $('scanCamInput').click());
  $('scanGalBtn').addEventListener('click', () => $('scanGalInput').click());
  const onFile = (e) => { const f = e.target.files && e.target.files[0]; guard(() => handleScanFile(f)); };
  $('scanCamInput').addEventListener('change', onFile);
  $('scanGalInput').addEventListener('change', onFile);
  $('scanClearImg').addEventListener('click', clearScanImage);
  $('scanModeChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (!c) return;
    S.scan.mode = c.dataset.mode;
    document.querySelectorAll('#scanModeChips .chip').forEach((x) => x.classList.toggle('active', x === c));
  });
  $('scanBtn').addEventListener('click', solveScan);
  $('scanCopy').addEventListener('click', () => { copyText(S.scan.result || '').then((ok) => toast(ok ? 'Solution copied' : 'Could not copy. Select the text manually.', ok ? 'ok' : 'error')); });
  $('scanAsk').addEventListener('click', () => {
    if (!S.scan.result) return;
    setView('pulsebot');
    sendChat('I scanned this question. Please explain it more simply and give me a similar practice question:\n\n' + S.scan.result.slice(0, 1500));
  });
  $('scanHistory').addEventListener('click', (e) => {
    const it = e.target.closest('.sh-item'); if (!it) return;
    const s = S.doc.scans.find((x) => x.id === it.dataset.id);
    if (s) showScanResult(s.result);
  });
  $('scanClearHistory').addEventListener('click', () => guard(async () => {
    if (!S.doc.scans.length) { toast('History is already empty'); return; }
    const ok = await confirmBox('Clear scan history?', 'Your saved scans will be deleted from this device.', 'Clear');
    if (!ok) return;
    S.doc.scans = [];
    save();
    renderScanHistory();
    $('scanResultCard').hidden = true;
  }));

  /* ----- settings ----- */
  $('settingsForm').addEventListener('submit', (e) => { e.preventDefault(); guard(saveSettings); });
  $('aiForm').addEventListener('submit', (e) => { e.preventDefault(); guard(saveAiSettings); });
  $('keyToggle').addEventListener('click', () => {
    const i = $('setGroqKey'), show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('keyToggle').textContent = show ? 'Hide' : 'Show';
  });
  $('testKeyBtn').addEventListener('click', () => guard(testKey, $('testKeyBtn')));
  $('removeKeyBtn').addEventListener('click', () => guard(removeKey));
  $('exportBackupBtn').addEventListener('click', () => guard(exportBackup));
  $('importBackupBtn').addEventListener('click', () => $('importFile').click());
  $('importFile').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (f) guard(() => importBackup(f));
  });

  /* ----- chat ----- */
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('chatInput').value;
    if (!t.trim()) return;
    $('chatInput').value = ''; $('chatInput').style.height = 'auto';
    sendChat(t);
  });
  $('chatInput').addEventListener('input', () => { const el = $('chatInput'); el.style.height = 'auto'; el.style.height = Math.min(120, el.scrollHeight) + 'px'; });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 900) { e.preventDefault(); $('chatForm').requestSubmit(); }
  });
  $('chatChips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) sendChat(c.dataset.prompt); });
  $('chatClear').addEventListener('click', () => guard(async () => {
    const ok = await confirmBox('Clear chat?', 'Your saved PulseBot conversation will be deleted from this device.', 'Clear');
    if (!ok) re