/* LearnPulse OS - app.js (v6)
   Viswesh & Team, Dept of CSE
   Vanilla JS. Talks to the FastAPI backend on Render. */
(function () {
'use strict';

/* ======================= CONFIG ======================= */
const API_BASE = 'https://ai-study-planner-api-6agl.onrender.com';
const HOUR_PX = 56;          // must match --hour in style.css
const DAY_START = 360;       // 6:00 AM in minutes
const DAY_END = 1380;        // 11:00 PM in minutes
const LS = { user: 'lp_user', token: 'lp_token', theme: 'lp_theme', focus: 'lp_focus' };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const HDOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TYPE_LABEL = { focus: 'Focus time', task: 'Task', habit: 'Habit', fixed: 'Fixed class' };
const VIEW_TITLE = { calendar: 'Calendar', habits: 'Habits', focus: 'Focus', analytics: 'Analytics', pulsebot: 'PulseBot', settings: 'Settings' };

const $ = (id) => document.getElementById(id);

/* ======================= STATE ======================= */
const S = {
  user: null, token: null, settings: null, habits: [],
  plans: [], activePlanId: null, plan: null, blocks: [], buffers: [],
  view: 'calendar', days: 1, anchor: new Date(),
  preview: null, selBlock: null, weeklyMinutes: 0, streak: 0,
  charts: { alloc: null, subjects: null },
  chatBusy: false, quiz: null, notesBlock: null, editHabit: null,
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

let toastTimer = null;
function toast(msg, type) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (type ? ' ' + type : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'error' ? 5000 : 3000);
}

function showErr(el, msg) { el.textContent = msg; el.hidden = false; }
function hideErr(el) { el.textContent = ''; el.hidden = true; }

/* ======================= API ======================= */
function detailMsg(data, status) {
  if (data && typeof data.detail === 'string') return data.detail;
  if (data && Array.isArray(data.detail) && data.detail.length) {
    const d = data.detail[0];
    const loc = Array.isArray(d.loc) ? d.loc.filter((x) => x !== 'body').join('.') : '';
    return (loc ? loc + ': ' : '') + (d.msg || 'Invalid input');
  }
  return 'Request failed (' + status + ')';
}

async function api(path, opts) {
  opts = opts || {};
  const method = opts.method || 'GET';
  const auth = opts.auth !== false;
  const headers = { 'Content-Type': 'application/json' };
  if (auth) { headers['X-Username'] = S.user || ''; headers['X-Token'] = S.token || ''; }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeout || 90000);
  let res;
  try {
    res = await fetch(API_BASE + path, {
      method, headers, signal: ctrl.signal,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e && e.name === 'AbortError'
      ? 'The server took too long to respond. It may be waking up, so please try again.'
      : 'Cannot reach the server. Check your internet connection.');
  }
  clearTimeout(timer);
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    if (res.status === 401 && auth && S.token) {
      resetToLogin('Session expired. Please sign in again.');
      const err = new Error('Session expired'); err.silent = true; throw err;
    }
    throw new Error(detailMsg(data, res.status));
  }
  return data;
}

async function guard(fn, btn) {
  if (btn) btn.classList.add('loading');
  try { return await fn(); }
  catch (e) { if (!e.silent) toast(e.message || 'Something went wrong', 'error'); }
  finally { if (btn) btn.classList.remove('loading'); }
}

/* ======================= MODALS ======================= */
let confirmResolve = null;
function syncBodyLock() {
  document.body.style.overflow = document.querySelectorAll('.modal:not([hidden])').length ? 'hidden' : '';
}
function openModal(id) { $(id).hidden = false; syncBodyLock(); }
function closeModal(id) {
  const el = $(id);
  if (!el || el.hidden) return;
  el.hidden = true;
  if (id === 'confirmModal' && confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
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

/* ======================= MARKDOWN ======================= */
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
  try { localStorage.setItem(LS.theme, t); } catch (e) { /* ignore */ }
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
  if (S.view === 'analytics' && !$('appShell').hidden) loadAnalytics();
}
function initTheme() {
  let t = 'light';
  try { t = localStorage.getItem(LS.theme) || 'light'; } catch (e) { /* ignore */ }
  document.documentElement.setAttribute('data-theme', t);
  $('themeBtn').textContent = t === 'dark' ? '☀️' : '🌙';
}

/* ======================= SCREENS / AUTH ======================= */
function showScreen(which) {
  $('splash').hidden = which !== 'splash';
  $('loginScreen').hidden = which !== 'login';
  $('appShell').hidden = which !== 'app';
}

function resetToLogin(message) {
  stopTimer(true);
  clearPreview(true);
  closeAllModals();
  try {
    Object.keys(localStorage).filter((k) => k.indexOf('lp_') === 0 && k !== LS.theme)
      .forEach((k) => localStorage.removeItem(k));
  } catch (e) { /* ignore */ }
  if (S.charts.alloc) { S.charts.alloc.destroy(); S.charts.alloc = null; }
  if (S.charts.subjects) { S.charts.subjects.destroy(); S.charts.subjects = null; }
  S.user = null; S.token = null; S.settings = null; S.habits = []; S.plans = [];
  S.activePlanId = null; S.plan = null; S.blocks = []; S.buffers = []; S.selBlock = null;
  S.weeklyMinutes = 0; S.streak = 0; S.view = 'calendar'; S.chatBusy = false;
  $('calGrid').innerHTML = ''; $('calHead').innerHTML = '';
  $('chatLog').innerHTML = ''; $('habitList').innerHTML = '';
  $('loginForm').reset();
  $('loginUser').value = ''; $('loginPin').value = '';
  $('loginBtn').classList.remove('loading');
  if (message) showErr($('loginError'), message); else hideErr($('loginError'));
  showScreen('login');
  window.scrollTo(0, 0);
}

async function logout() {
  const u = S.user, t = S.token;
  resetToLogin();
  if (u && t) {
    try {
      fetch(API_BASE + '/api/logout', { method: 'POST', headers: { 'X-Username': u, 'X-Token': t } }).catch(() => {});
    } catch (e) { /* ignore */ }
  }
}

async function bootApp() {
  const me = await api('/api/me?today=' + todayStr(), { timeout: 90000 });
  S.user = me.username || S.user;
  S.settings = me.settings;
  S.habits = me.habits || [];
  S.plans = me.plans || [];
  S.activePlanId = me.active_plan_id;
  S.weeklyMinutes = me.weekly_minutes || 0;
  try { localStorage.setItem(LS.user, S.user); } catch (e) { /* ignore */ }
  $('userName').textContent = S.user;
  setStreak(me.streak || 0);
  S.anchor = new Date();
  S.plan = null; S.blocks = []; S.buffers = [];
  try {
    if (S.plans.length && S.habits.length) {
      const p = await api('/api/habits/sync', { method: 'POST', body: { today: todayStr() } });
      if (p && p.plan) setPlanPayload(p);
    } else if (S.activePlanId) {
      const p = await api('/api/plans/' + S.activePlanId);
      setPlanPayload(p);
    }
  } catch (e) { if (e.silent) throw e; toast(e.message, 'error'); }
  showScreen('app');
  setView('calendar');
  scrollToNow();
}

async function init() {
  initTheme();
  let u = null, t = null;
  try { u = localStorage.getItem(LS.user); t = localStorage.getItem(LS.token); } catch (e) { /* ignore */ }
  if (u && t) {
    S.user = u; S.token = t;
    showScreen('splash');
    $('splashText').textContent = 'Signing you in…';
    const slow = setTimeout(() => { $('splashText').textContent = 'Waking up the server… this can take up to a minute on the free plan.'; }, 5000);
    try {
      await bootApp();
    } catch (e) {
      if (!e.silent) {
        const keep = S.user;
        resetToLogin(e.message);
        if (keep) $('loginUser').value = keep;
      }
    } finally { clearTimeout(slow); }
  } else {
    showScreen('login');
  }
}

function setStreak(n) { S.streak = n; $('streakNum').textContent = String(n); }

/* ======================= NAVIGATION ======================= */
function setView(name) {
  S.view = name;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('viewTitle').textContent = VIEW_TITLE[name] || '';
  window.scrollTo(0, 0);
  if (name === 'calendar') renderCalendar();
  else if (name === 'habits') loadHabits();
  else if (name === 'focus') { renderTimer(); updateFocusStats(); }
  else if (name === 'analytics') loadAnalytics();
  else if (name === 'pulsebot') loadChat();
  else if (name === 'settings') fillSettings();
}

/* ======================= PLANS / CALENDAR DATA ======================= */
function setPlanPayload(p) {
  if (!p || !p.plan) return;
  S.plan = p.plan;
  S.blocks = p.blocks || [];
  S.buffers = p.buffers || [];
  S.activePlanId = p.plan.id;
}

async function refreshPlans() {
  const r = await api('/api/plans');
  S.plans = r.plans || [];
  S.activePlanId = r.active_plan_id;
}

function clearPlanLocal() { S.plan = null; S.blocks = []; S.buffers = []; S.activePlanId = null; }

/* ======================= CALENDAR RENDER ======================= */
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
  if (!S.plans.length) { sel.innerHTML = '<option value="">No plans yet</option>'; sel.disabled = true; return; }
  sel.disabled = false;
  sel.innerHTML = S.plans.map((p) => '<option value="' + esc(p.id) + '">' + esc(p.name) + '</option>').join('');
  sel.value = S.activePlanId || S.plans[0].id;
}
function updateActionStates() {
  const has = !!S.plan;
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
  if (b.type === 'buffer') {
    return '<div class="' + cls.join(' ') + '" style="' + style + '">Buffer</div>';
  }
  const icons = (b.locked ? '🔒' : '') + (b.defense === 'busy' ? '🛡️' : '') + (b.done ? '✅' : '');
  return '<div class="' + cls.join(' ') + '" data-id="' + esc(b.id) + '" style="' + style + '">' +
    '<span class="blk-title">' + esc(b.title) + '</span>' +
    '<span class="blk-time">' + fmt12(s) + ' – ' + fmt12(s + b.duration) + '</span>' +
    (icons && hgt >= 38 ? '<span class="blk-icons">' + icons + '</span>' : '') + '</div>';
}

function renderCalendar() {
  const has = !!S.plan;
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

  const blocks = S.preview ? S.preview.blocks : S.blocks;
  const buffers = S.preview ? S.preview.buffers : S.buffers;
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
  if (!S.plan) return;
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
  if (S.view !== 'calendar' || !S.plan) return;
  const grid = $('calGrid');
  if (!grid) return;
  let mins = 480;
  const ds = visibleDates().map(ymd);
  if (ds.indexOf(todayStr()) >= 0) mins = nowMin();
  else {
    const first = S.blocks.filter((b) => ds.indexOf(b.date) >= 0).map((b) => hm2m(b.start)).sort((a, b) => a - b)[0];
    if (first !== undefined) mins = first;
  }
  const y = Math.max(0, (Math.max(DAY_START, mins) - DAY_START) / 60 * HOUR_PX - 90);
  const top = grid.getBoundingClientRect().top + window.scrollY + y - 150;
  window.scrollTo(0, Math.max(0, top));
}

function shiftCalendar(dir) {
  const step = daysCount() === 7 ? 7 : daysCount();
  S.anchor = addDays(S.anchor, dir * step);
  renderCalendar();
}

/* ======================= PREVIEW / REBALANCE ======================= */
function clearPreview(silent) {
  S.preview = null;
  document.body.classList.remove('previewing');
  $('previewBanner').hidden = true;
  if (!silent && S.view === 'calendar') renderCalendar();
}

async function startRebalance() {
  if (!S.plan) return;
  if (S.preview) return;
  const r = await api('/api/plans/' + S.plan.id + '/rebalance/preview', {
    method: 'POST', body: { today: todayStr(), now_min: nowMin() },
  });
  if (!r.changed || !r.changed.length) {
    toast(r.unplaced && r.unplaced.length ? 'No room to move ' + r.unplaced.length + ' task(s). Try a longer study window.' : 'Your schedule is already balanced ✓', 'ok');
    return;
  }
  S.preview = r;
  document.body.classList.add('previewing');
  $('previewInfo').textContent = r.changed.length + ' block' + (r.changed.length > 1 ? 's' : '') + ' will move' +
    (r.unplaced && r.unplaced.length ? ', ' + r.unplaced.length + ' could not fit.' : '. Nothing is saved yet.');
  $('previewBanner').hidden = false;
  const vis = visibleDates().map(ymd);
  const dates = r.blocks.filter((b) => r.changed.indexOf(b.id) >= 0).map((b) => b.date).sort();
  if (dates.length && dates.every((d) => vis.indexOf(d) < 0)) S.anchor = parseYmd(dates[0]);
  renderCalendar();
  window.scrollTo(0, 0);
}

async function applyPreview() {
  if (!S.preview || !S.plan) return;
  const moves = S.preview.moves || [];
  const p = await api('/api/plans/' + S.plan.id + '/rebalance/apply', { method: 'POST', body: { moves } });
  clearPreview(true);
  setPlanPayload(p);
  renderCalendar();
  toast('Schedule applied (' + (p.applied || 0) + ' blocks moved)', 'ok');
}

/* ======================= INSPECTOR ======================= */
function curBlock() { return S.blocks.find((b) => b.id === S.selBlock) || null; }

function openInspector(id) {
  if (S.preview) { toast('Apply or discard the preview first'); return; }
  const b = S.blocks.find((x) => x.id === id);
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

async function patchBlock(patch, okMsg) {
  const b = curBlock();
  if (!b || !S.plan) return;
  const p = await api('/api/plans/' + S.plan.id + '/blocks/' + b.id, { method: 'PUT', body: patch });
  setPlanPayload(p);
  const nb = curBlock();
  if (nb) fillInspector(nb);
  renderCalendar();
  if (okMsg) toast(okMsg, 'ok');
}

/* ======================= AI NOTES / QUIZ ======================= */
function blockTopic(b) { return (b.topic && b.topic.trim()) || b.title; }

async function openNotes(b, refresh) {
  S.notesBlock = b;
  $('notesTitle').textContent = '📝 ' + blockTopic(b);
  $('notesBody').innerHTML = '<div class="typing"><i></i><i></i><i></i></div> <span class="muted small">Writing notes…</span>';
  openModal('notesModal');
  try {
    const r = await api('/api/ai/notes', {
      method: 'POST',
      body: { topic: blockTopic(b), subject: b.subject || '', plan_id: S.plan ? S.plan.id : null, block_id: b.id, refresh: !!refresh },
    });
    $('notesBody').innerHTML = md(r.notes);
    const local = S.blocks.find((x) => x.id === b.id);
    if (local) local.notes = r.notes;
  } catch (e) {
    if (!e.silent) $('notesBody').innerHTML = '<div class="form-error">' + esc(e.message) + '</div>';
  }
}

async function openQuiz(b) {
  const topic = blockTopic(b);
  S.quiz = { topic, subject: b.subject || '', qs: [], i: 0, score: 0, answered: false };
  $('quizTitle').textContent = '❓ Quiz: ' + topic;
  $('quizBody').innerHTML = '<div class="typing"><i></i><i></i><i></i></div> <span class="muted small">Building your quiz…</span>';
  openModal('quizModal');
  try {
    const r = await api('/api/ai/quiz', { method: 'POST', body: { topic, subject: S.quiz.subject } });
    S.quiz.qs = r.questions || [];
    renderQuizQ();
  } catch (e) {
    if (!e.silent) $('quizBody').innerHTML = '<div class="form-error">' + esc(e.message) + '</div>' +
      '<button class="btn" id="quizRetry" type="button">Try again</button>';
    const rb = $('quizRetry');
    if (rb) rb.addEventListener('click', () => openQuiz(b));
  }
}

function renderQuizQ() {
  const q = S.quiz;
  if (!q || !q.qs.length) return;
  if (q.i >= q.qs.length) { renderQuizResult(); return; }
  const cur = q.qs[q.i];
  q.answered = false;
  let h = '<div class="quiz-prog">Question ' + (q.i + 1) + ' of ' + q.qs.length + '</div>' +
    '<div class="quiz-q">' + esc(cur.q) + '</div>';
  cur.options.forEach((o, idx) => {
    h += '<button type="button" class="quiz-opt" data-idx="' + idx + '">' + 'ABCD'[idx] + '. ' + esc(o) + '</button>';
  });
  h += '<div id="quizFeedback"></div>';
  $('quizBody').innerHTML = h;
}

function answerQuiz(idx) {
  const q = S.quiz;
  if (!q || q.answered) return;
  q.answered = true;
  const cur = q.qs[q.i];
  const opts = $('quizBody').querySelectorAll('.quiz-opt');
  opts.forEach((el, i) => {
    el.classList.add('disabled');
    if (i === cur.answer) el.classList.add('correct');
    else if (i === idx) el.classList.add('wrong');
  });
  if (idx === cur.answer) q.score++;
  const last = q.i === q.qs.length - 1;
  $('quizFeedback').innerHTML =
    '<div class="quiz-expl"><b>' + (idx === cur.answer ? '✅ Correct.' : '❌ Not quite.') + '</b> ' + esc(cur.explanation || '') + '</div>' +
    '<button class="btn primary" id="quizNext" type="button">' + (last ? 'See results' : 'Next question') + '</button>';
  $('quizNext').addEventListener('click', () => { q.i++; renderQuizQ(); });
}

function renderQuizResult() {
  const q = S.quiz;
  const total = q.qs.length;
  const msg = q.score === total ? 'Perfect! You have this topic locked in. 🎉'
    : q.score >= 2 ? 'Good job. A quick revision will make it solid.'
      : 'This topic needs more work. PulseBot has flagged it as a weak topic.';
  $('quizBody').innerHTML = '<div class="quiz-score"><b>' + q.score + ' / ' + total + '</b><span class="muted">' + esc(msg) + '</span></div>' +
    '<div class="modal-actions"><button class="btn primary" id="quizAgain" type="button">New quiz</button>' +
    '<button class="btn" id="quizDone" type="button">Close</button></div>';
  $('quizAgain').addEventListener('click', () => {
    const fake = { topic: q.topic, title: q.topic, subject: q.subject };
    openQuiz(fake);
  });
  $('quizDone').addEventListener('click', () => closeModal('quizModal'));
  api('/api/quiz/result', { method: 'POST', body: { topic: q.topic, subject: q.subject, score: q.score, total } }).catch(() => {});
}

/* ======================= ADD BLOCK / PLAN CREATION ======================= */
function openAddBlock() {
  if (!S.plan) { toast('Create a plan first'); openPlanModal(); return; }
  $('abTitle').value = '';
  $('abSubject').value = '';
  $('abType').value = 'task';
  $('abPriority').value = 'P3';
  $('abDate').value = ymd(S.anchor);
  $('abStart').value = '09:00';
  $('abDuration').value = (S.settings && S.settings.default_session) || 50;
  $('abRepeat').value = 0;
  openModal('addBlockModal');
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
  $('plStart').value = todayStr();
  $('plExam').value = '';
  $('plDays').value = 7; $('plHours').value = 3;
  $('plSession').value = (S.settings && S.settings.default_session) || 50;
  $('subjectList').innerHTML = '';
  addSubjectRow('', 'medium');
  openModal('planModal');
}

async function generatePlan() {
  hideErr($('planError'));
  const subjects = [];
  $('subjectList').querySelectorAll('.subj-row').forEach((r) => {
    const n = r.querySelector('.sr-name').value.trim();
    if (n) subjects.push({ name: n, level: r.querySelector('.sr-level').value });
  });
  if (!subjects.length) { showErr($('planError'), 'Add at least one subject.'); return; }
  const start = $('plStart').value;
  if (!start) { showErr($('planError'), 'Pick a start date.'); return; }
  const days = parseInt($('plDays').value, 10);
  const hours = parseFloat($('plHours').value);
  const session = parseInt($('plSession').value, 10);
  if (!(days >= 1 && days <= 21)) { showErr($('planError'), 'Days must be between 1 and 21.'); return; }
  if (!(hours >= 0.5 && hours <= 10)) { showErr($('planError'), 'Hours per day must be between 0.5 and 10.'); return; }
  if (!(session >= 20 && session <= 120)) { showErr($('planError'), 'Session length must be between 20 and 120 minutes.'); return; }
  const btn = $('planGenBtn');
  const label = btn.textContent;
  btn.textContent = 'Generating… (about 20s)';
  btn.classList.add('loading');
  try {
    const r = await api('/api/plans/generate', {
      method: 'POST',
      body: {
        name: $('plName').value.trim(), subjects, goal: $('plGoal').value.trim(),
        start_date: start, days, hours_per_day: hours, session_minutes: session,
        exam_date: $('plExam').value || null, today: todayStr(), now_min: nowMin(),
      },
    });
    clearPreview(true);
    setPlanPayload(r);
    await refreshPlans();
    S.anchor = parseYmd(start);
    closeModal('planModal');
    if (S.view !== 'calendar') setView('calendar'); else renderCalendar();
    scrollToNow();
    if (r.warning) toast(r.warning); else toast('Plan created ✨', 'ok');
    if (r.unplaced) toast(r.unplaced + ' task(s) did not fit. Try more hours per day.');
  } catch (e) {
    if (!e.silent) showErr($('planError'), e.message);
  } finally {
    btn.textContent = label;
    btn.classList.remove('loading');
  }
}

async function blankPlan() {
  hideErr($('planError'));
  const r = await api('/api/plans/blank', { method: 'POST', body: { name: $('plName').value.trim() || 'My Study Plan' } });
  clearPreview(true);
  setPlanPayload(r);
  await refreshPlans();
  closeModal('planModal');
  if (S.view !== 'calendar') setView('calendar'); else renderCalendar();
  toast('Blank plan created. Add blocks with ＋ Block.', 'ok');
}

async function deletePlan() {
  if (!S.plan) return;
  const ok = await confirmBox('Delete plan?', '“' + S.plan.name + '” and all its blocks will be permanently deleted.', 'Delete plan');
  if (!ok) return;
  const r = await api('/api/plans/' + S.plan.id, { method: 'DELETE' });
  clearPreview(true);
  S.plans = r.plans || [];
  S.activePlanId = r.active_plan_id;
  if (r.active_plan_id) {
    const p = await api('/api/plans/' + r.active_plan_id);
    setPlanPayload(p);
  } else clearPlanLocal();
  renderCalendar();
  toast('Plan deleted', 'ok');
}

async function switchPlan(id) {
  if (!id || id === S.activePlanId) return;
  clearPreview(true);
  const p = await api('/api/plans/' + id + '/activate', { method: 'PUT' });
  setPlanPayload(p);
  renderCalendar();
  scrollToNow();
}

/* ======================= EXPORT ICS / PRINT ======================= */
function icsEsc(s) {
  return String(s == null ? '' : s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}
function icsFold(line) {
  const chars = Array.from(line);
  if (chars.length <= 60) return line;
  const parts = [];
  for (let i = 0; i < chars.length; i += 60) parts.push(chars.slice(i, i + 60).join(''));
  return parts.join('\r\n ');
}
function exportIcs() {
  if (!S.plan) return;
  const blocks = S.blocks.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  if (!blocks.length) { toast('Nothing to export yet'); return; }
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//LearnPulse OS//Viswesh & Team Dept of CSE//EN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEsc('LearnPulse: ' + S.plan.name)];
  blocks.forEach((b) => {
    const s = hm2m(b.start), e = s + b.duration;
    const d = b.date.replace(/-/g, '');
    const desc = [TYPE_LABEL[b.type] || b.type, b.subject ? 'Subject: ' + b.subject : '', b.topic ? 'Topic: ' + b.topic : '',
      b.type === 'task' ? 'Priority: ' + b.priority : '', 'Planned with LearnPulse OS'].filter(Boolean).join(' | ');
    L.push('BEGIN:VEVENT', 'UID:' + b.id + '@learnpulse-os', 'DTSTAMP:' + stamp,
      'DTSTART:' + d + 'T' + pad(Math.floor(s / 60)) + pad(s % 60) + '00',
      'DTEND:' + d + 'T' + pad(Math.floor(e / 60)) + pad(e % 60) + '00',
      'SUMMARY:' + icsEsc((b.done ? '✓ ' : '') + b.title),
      'DESCRIPTION:' + icsEsc(desc),
      'TRANSP:' + (b.defense === 'busy' ? 'OPAQUE' : 'TRANSPARENT'), 'END:VEVENT');
  });
  L.push('END:VCALENDAR');
  const text = L.map(icsFold).join('\r\n') + '\r\n';
  const blob = new Blob([text], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'learnpulse-' + (S.plan.name || 'plan').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.ics';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
  toast('Calendar file ready. Import it in Google Calendar → Settings → Import.', 'ok');
}

function printSchedule() {
  if (!S.plan) return;
  const blocks = S.blocks.slice().sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const byDate = {};
  blocks.forEach((b) => { (byDate[b.date] = byDate[b.date] || []).push(b); });
  let h = '<div class="pr-head"><h1>LearnPulse OS · Study Plan</h1><p>' + esc(S.plan.name) + ' · Student: ' + esc(S.user) +
    ' · Printed ' + esc(dateLabel(todayStr())) + ' ' + new Date().getFullYear() + '</p></div>';
  Object.keys(byDate).sort().forEach((d) => {
    h += '<div class="pr-day"><h2>' + esc(dateLabel(d)) + ' ' + d.slice(0, 4) + '</h2><table class="pr-table"><thead><tr><th>Time</th><th>Activity</th><th>Type</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead><tbody>';
    byDate[d].forEach((b) => {
      const s = hm2m(b.start);
      h += '<tr><td>' + fmt12(s) + ' – ' + fmt12(s + b.duration) + '</td><td>' + esc(b.title) + (b.locked ? ' 🔒' : '') + '</td><td>' +
        esc(TYPE_LABEL[b.type] || b.type) + '</td><td>' + esc(b.subject || '') + '</td><td>' + (b.type === 'task' ? esc(b.priority) : '') +
        '</td><td>' + (b.done ? 'Done' : '') + '</td></tr>';
    });
    h += '</tbody></table></div>';
  });
  if (!blocks.length) h += '<p>No blocks scheduled.</p>';
  h += '<div class="pr-foot">LearnPulse OS — Viswesh &amp; Team, Dept of CSE</div>';
  $('printArea').innerHTML = h;
  setTimeout(() => window.print(), 100);
}

/* ======================= HABITS ======================= */
async function loadHabits() {
  await guard(async () => {
    const r = await api('/api/habits');
    S.habits = r.habits || [];
    renderHabits();
  });
}

function renderHabits() {
  const el = $('habitList');
  if (!S.habits.length) {
    el.innerHTML = '<div class="empty"><div class="empty-ico">🔁</div><h3>No habits yet</h3><p>Add a routine like “Morning revision” and LearnPulse will fit it into your calendar every day.</p></div>';
    return;
  }
  el.innerHTML = S.habits.map((h) => {
    const days = HDOW.map((d, i) => '<span class="hc-day' + (h.days.indexOf(i) >= 0 ? ' on' : '') + '">' + d + '</span>').join('');
    return '<div class="habit-card" data-id="' + esc(h.id) + '"><div class="hc-name">' + esc(h.name) + '</div>' +
      '<div class="hc-meta"><span>⏱ ' + h.duration + ' min</span><span>🕒 ' + fmt12(h.earliest) + ' – ' + fmt12(h.latest) +
      '</span><span>⭐ ideal ' + fmt12(h.ideal) + '</span><span>' + (h.defense === 'busy' ? '🛡️ Busy' : '🔓 Free') + '</span></div>' +
      '<div class="hc-days">' + days + '</div>' +
      '<div class="hc-actions"><button class="btn sm hc-edit" type="button">Edit</button>' +
      '<button class="btn sm danger-ghost hc-del" type="button">Delete</button></div></div>';
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

async function saveHabit() {
  hideErr($('habitError'));
  const name = $('hbName').value.trim();
  if (!name) { showErr($('habitError'), 'Give your habit a name.'); return; }
  const days = [];
  $('hbDays').querySelectorAll('input').forEach((c) => { if (c.checked) days.push(+c.value); });
  if (!days.length) { showErr($('habitError'), 'Pick at least one day.'); return; }
  const body = {
    name, duration: parseInt($('hbDuration').value, 10) || 30, earliest: $('hbEarliest').value,
    ideal: $('hbIdeal').value, latest: $('hbLatest').value, days, defense: $('hbDefense').value, today: todayStr(),
  };
  if (!body.earliest || !body.ideal || !body.latest) { showErr($('habitError'), 'Fill in all three times.'); return; }
  try {
    const r = S.editHabit
      ? await api('/api/habits/' + S.editHabit, { method: 'PUT', body })
      : await api('/api/habits', { method: 'POST', body });
    S.habits = r.habits || [];
    closeModal('habitModal');
    renderHabits();
    await reloadActivePlan();
    toast('Habit saved', 'ok');
  } catch (e) { if (!e.silent) showErr($('habitError'), e.message); }
}

async function reloadActivePlan() {
  if (!S.activePlanId) return;
  const p = await api('/api/plans/' + S.activePlanId);
  setPlanPayload(p);
}

/* ======================= FOCUS TIMER ======================= */
const T = { minutes: 50, total: 3000, remaining: 3000, running: false, endAt: 0, iv: null };
const RING_C = 339.292;

function getFocusToday() {
  try {
    const o = JSON.parse(localStorage.getItem(LS.focus + ':' + S.user) || 'null');
    if (o && o.date === todayStr()) return o.min || 0;
  } catch (e) { /* ignore */ }
  return 0;
}
function addFocusToday(m) {
  try { localStorage.setItem(LS.focus + ':' + S.user, JSON.stringify({ date: todayStr(), min: getFocusToday() + m })); } catch (e) { /* ignore */ }
}
function updateFocusStats() {
  $('focusToday').textContent = String(getFocusToday());
  $('focusWeek').textContent = String(S.weeklyMinutes || 0);
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
  if (reset) { T.remaining = T.total; }
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
async function logFocus(minutes) {
  const r = await api('/api/focus', {
    method: 'POST', body: { minutes, subject: $('focusSubject').value.trim(), today: todayStr() },
  });
  addFocusToday(minutes);
  setStreak(r.streak);
  S.weeklyMinutes = r.weekly_minutes;
  updateFocusStats();
  return r;
}
async function completeTimer() {
  const mins = T.minutes;
  stopTimer(true);
  beep();
  try { await logFocus(mins); toast('Session complete! ' + mins + ' min logged 🎯', 'ok'); }
  catch (e) { if (!e.silent) toast('Could not log session: ' + e.message, 'error'); }
}
async function finishTimer() {
  const elapsed = T.total - T.remaining;
  const mins = Math.floor(elapsed / 60);
  if (mins < 1) { toast('Focus for at least 1 minute to log a session'); return; }
  stopTimer(true);
  await guard(async () => { await logFocus(mins); toast(mins + ' min logged 🎯', 'ok'); });
}

/* ======================= ANALYTICS ======================= */
async function loadAnalytics() {
  await guard(async () => {
    const a = await api('/api/analytics?today=' + todayStr());
    S.weeklyMinutes = a.weekly_logged_minutes;
    setStreak(a.streak);
    $('goalLabel').textContent = (a.weekly_logged_minutes / 60).toFixed(1) + ' / ' + a.weekly_goal_hours + ' h';
    $('goalBar').style.width = a.weekly_progress_pct + '%';
    $('goalPct').textContent = a.weekly_progress_pct + '% of weekly goal';
    $('kpiStreak').textContent = String(a.streak);
    $('kpiDefended').textContent = a.defended_hours + ' h';
    $('kpiTasks').textContent = a.tasks_done + '/' + a.tasks_total;
    drawCharts(a);
  });
}

function drawCharts(a) {
  if (typeof Chart === 'undefined') return;
  const cs = getComputedStyle(document.documentElement);
  const text = cs.getPropertyValue('--muted').trim() || '#64748b';
  const grid = cs.getPropertyValue('--border').trim() || '#e2e8f0';
  const surface = cs.getPropertyValue('--surface').trim() || '#fff';
  Chart.defaults.color = text;
  Chart.defaults.font.family = 'Inter, system-ui, sans-serif';
  if (S.charts.alloc) S.charts.alloc.destroy();
  if (S.charts.subjects) S.charts.subjects.destroy();
  S.charts.alloc = new Chart($('chartAlloc'), {
    type: 'doughnut',
    data: {
      labels: a.allocation.labels,
      datasets: [{ data: a.allocation.hours, backgroundColor: ['#14b8a6', '#3b82f6', '#8b5cf6', '#64748b', '#cbd5e1'], borderColor: surface, borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '62%',
      plugins: {
        legend: { position: 'bottom', labels: { boxWidth: 12, padding: 12 } },
        tooltip: { callbacks: { label: (c) => ' ' + c.label + ': ' + c.parsed + ' h' } },
      },
    },
  });
  S.charts.subjects = new Chart($('chartSubjects'), {
    type: 'bar',
    data: {
      labels: a.subjects.map((s) => s.subject),
      datasets: [{ data: a.subjects.map((s) => s.pct), backgroundColor: '#14b8a6', borderRadius: 6, maxBarThickness: 26 }],
    },
    options: {
      indexAxis: 'y', responsive: true, maintainAspectRatio: false,
      scales: {
        x: { min: 0, max: 100, grid: { color: grid }, ticks: { callback: (v) => v + '%' } },
        y: { grid: { display: false } },
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => ' ' + c.parsed.x + '% (' + a.subjects[c.dataIndex].done + '/' + a.subjects[c.dataIndex].total + ')' } },
      },
    },
  });
}

/* ======================= SETTINGS ======================= */
function fillSettings() {
  const s = S.settings; if (!s) return;
  $('setStart').value = s.study_start;
  $('setEnd').value = s.study_end;
  $('setBuffer').value = s.buffer_min;
  $('setMaxDaily').value = s.max_daily_hours;
  $('setWeeklyGoal').value = s.weekly_goal_hours;
  $('setDefense').value = s.defense_mode;
  $('setSession').value = s.default_session;
}
async function saveSettings() {
  const body = {
    study_start: $('setStart').value, study_end: $('setEnd').value,
    buffer_min: parseInt($('setBuffer').value, 10), max_daily_hours: parseFloat($('setMaxDaily').value),
    weekly_goal_hours: parseFloat($('setWeeklyGoal').value), defense_mode: $('setDefense').value,
    default_session: parseInt($('setSession').value, 10),
  };
  Object.keys(body).forEach((k) => { if (body[k] === '' || (typeof body[k] === 'number' && isNaN(body[k]))) delete body[k]; });
  const r = await api('/api/settings', { method: 'PUT', body });
  S.settings = r.settings;
  fillSettings();
  toast('Settings saved', 'ok');
}

/* ======================= PULSEBOT ======================= */
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
function renderChat(msgs) {
  const log = $('chatLog');
  log.innerHTML = '';
  if (!msgs.length) {
    log.innerHTML = '<div class="chat-empty">👋 Hi ' + esc(S.user) + '! I’m PulseBot, your study coach. Ask me what to study next, how to fix a weak topic, or how to organise your week.</div>';
    return;
  }
  msgs.forEach((m) => addBubble(m.role, m.content));
}
async function loadChat() {
  await guard(async () => {
    const r = await api('/api/chat');
    renderChat(r.messages || []);
  });
}
async function sendChat(text) {
  text = (text || '').trim();
  if (!text || S.chatBusy) return;
  S.chatBusy = true;
  $('chatSend').classList.add('loading');
  const empty = $('chatLog').querySelector('.chat-empty');
  if (empty) empty.remove();
  addBubble('user', text);
  const typing = addBubble('bot', '', true);
  const d = new Date();
  try {
    const r = await api('/api/chat', { method: 'POST', body: { message: text, today: todayStr(), now: pad(d.getHours()) + ':' + pad(d.getMinutes()) } });
    typing.remove();
    addBubble('bot', r.reply);
  } catch (e) {
    typing.remove();
    if (!e.silent) addBubble('bot', '⚠️ ' + e.message);
  } finally {
    S.chatBusy = false;
    $('chatSend').classList.remove('loading');
  }
}

/* ======================= EVENT WIRING ======================= */
function wire() {
  /* ----- login ----- */
  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    hideErr($('loginError'));
    const username = $('loginUser').value.trim();
    const pin = $('loginPin').value.trim();
    if (!/^[A-Za-z0-9_. \-]{2,24}$/.test(username)) { showErr($('loginError'), 'Username must be 2–24 characters: letters, numbers, space, . _ -'); return; }
    if (!/^\d{4}$/.test(pin)) { showErr($('loginError'), 'PIN must be exactly 4 digits.'); return; }
    const btn = $('loginBtn');
    btn.classList.add('loading');
    try {
      S.token = null;
      const r = await api('/api/auth', { method: 'POST', body: { username, pin }, auth: false });
      S.user = r.username; S.token = r.token;
      try { localStorage.setItem(LS.user, S.user); localStorage.setItem(LS.token, S.token); } catch (err) { /* ignore */ }
      $('loginPin').value = '';
      await bootApp();
      if (r.new_account) toast('Welcome to LearnPulse OS! Create your first plan with ✨ AI Plan.', 'ok');
    } catch (err) {
      if (!err.silent) { S.user = null; S.token = null; showErr($('loginError'), err.message); }
    } finally { btn.classList.remove('loading'); }
  });
  $('loginPin').addEventListener('input', () => { $('loginPin').value = $('loginPin').value.replace(/\D/g, '').slice(0, 4); });
  $('splashSwitch').addEventListener('click', () => resetToLogin());
  $('logoutBtn').addEventListener('click', logout);
  $('themeBtn').addEventListener('click', () => applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'));

  /* ----- nav ----- */
  $('nav').addEventListener('click', (e) => {
    const b = e.target.closest('.nav-btn');
    if (b) setView(b.dataset.view);
  });

  /* ----- modals ----- */
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
  $('planSelect').addEventListener('change', (e) => guard(() => switchPlan(e.target.value)));
  $('newPlanBtn').addEventListener('click', openPlanModal);
  $('emptyCreateBtn').addEventListener('click', openPlanModal);
  $('addBlockBtn').addEventListener('click', openAddBlock);
  $('rebalanceBtn').addEventListener('click', () => guard(startRebalance, $('rebalanceBtn')));
  $('exportIcsBtn').addEventListener('click', exportIcs);
  $('printBtn').addEventListener('click', printSchedule);
  $('deletePlanBtn').addEventListener('click', () => guard(deletePlan));
  $('applyPreviewBtn').addEventListener('click', () => guard(applyPreview, $('applyPreviewBtn')));
  $('discardPreviewBtn').addEventListener('click', () => { clearPreview(); toast('Preview discarded'); });
  $('calGrid').addEventListener('click', (e) => {
    const b = e.target.closest('.blk');
    if (!b || !b.dataset.id) return;
    openInspector(b.dataset.id);
  });

  /* ----- inspector ----- */
  $('inspDone').addEventListener('click', () => guard(async () => {
    const b = curBlock(); if (!b || !S.plan) return;
    const p = await api('/api/plans/' + S.plan.id + '/blocks/' + b.id + '/done', { method: 'POST', body: { done: !b.done, today: todayStr() } });
    setPlanPayload(p);
    setStreak(p.streak);
    S.weeklyMinutes = p.weekly_minutes;
    const nb = curBlock(); if (nb) fillInspector(nb);
    renderCalendar();
    toast(nb && nb.done ? 'Nice work! Logged ' + nb.duration + ' min 🔥' : 'Marked as not done', 'ok');
  }, $('inspDone')));
  $('inspLock').addEventListener('click', () => guard(async () => {
    const b = curBlock(); if (!b) return;
    await patchBlock({ locked: !b.locked }, b.locked ? 'Unlocked. AI may reschedule it.' : 'Locked. AI will not move it.');
  }, $('inspLock')));
  $('inspDefense').addEventListener('click', () => guard(async () => {
    const b = curBlock(); if (!b) return;
    await patchBlock({ defense: b.defense === 'busy' ? 'free' : 'busy' }, b.defense === 'busy' ? 'Time is now Free' : 'Time defended 🛡️');
  }, $('inspDefense')));
  $('inspForm').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      const title = $('inspTitle').value.trim();
      if (!title) { toast('Title cannot be empty', 'error'); return; }
      const dur = parseInt($('inspDuration').value, 10);
      if (!(dur >= 5 && dur <= 480)) { toast('Duration must be 5–480 minutes', 'error'); return; }
      if (!$('inspStart').value || !$('inspDate').value) { toast('Pick a date and start time', 'error'); return; }
      await patchBlock({
        title, subject: $('inspSubject').value.trim(), topic: $('inspTopic').value.trim(),
        date: $('inspDate').value, start: $('inspStart').value, duration: dur, priority: $('inspPriority').value,
      }, 'Saved');
      closeModal('inspectorModal');
    }, $('inspSave'));
  });
  $('inspDelete').addEventListener('click', () => guard(async () => {
    const b = curBlock(); if (!b || !S.plan) return;
    const ok = await confirmBox('Delete block?', '“' + b.title + '” will be removed from your calendar.', 'Delete');
    if (!ok) return;
    const p = await api('/api/plans/' + S.plan.id + '/blocks/' + b.id, { method: 'DELETE' });
    setPlanPayload(p);
    closeModal('inspectorModal');
    renderCalendar();
    toast('Block deleted', 'ok');
  }));
  $('inspNotes').addEventListener('click', () => { const b = curBlock(); if (b) openNotes(b, false); });
  $('inspQuiz').addEventListener('click', () => { const b = curBlock(); if (b) openQuiz(b); });
  $('inspAsk').addEventListener('click', () => {
    const b = curBlock(); if (!b) return;
    closeModal('inspectorModal');
    setView('pulsebot');
    const subj = b.subject ? ' (' + b.subject + ')' : '';
    sendChat('Help me study "' + blockTopic(b) + '"' + subj + '. I have a ' + b.duration + ' minute session scheduled.');
  });
  $('notesRefresh').addEventListener('click', () => { if (S.notesBlock) openNotes(S.notesBlock, true); });
  $('quizBody').addEventListener('click', (e) => {
    const o = e.target.closest('.quiz-opt');
    if (o) answerQuiz(+o.dataset.idx);
  });

  /* ----- add block ----- */
  $('addBlockForm').addEventListener('submit', (e) => {
    e.preventDefault();
    guard(async () => {
      const title = $('abTitle').value.trim();
      if (!title) { toast('Enter a title', 'error'); return; }
      if (!$('abDate').value || !$('abStart').value) { toast('Pick a date and start time', 'error'); return; }
      const dur = parseInt($('abDuration').value, 10);
      if (!(dur >= 5 && dur <= 480)) { toast('Duration must be 5–480 minutes', 'error'); return; }
      const p = await api('/api/plans/' + S.plan.id + '/blocks', {
        method: 'POST',
        body: {
          title, type: $('abType').value, subject: $('abSubject').value.trim(), priority: $('abPriority').value,
          date: $('abDate').value, start: $('abStart').value, duration: dur, repeat_weeks: parseInt($('abRepeat').value, 10) || 0,
        },
      });
      setPlanPayload(p);
      S.anchor = parseYmd($('abDate').value);
      closeModal('addBlockModal');
      renderCalendar();
      toast('Block added', 'ok');
    }, $('abSave'));
  });

  /* ----- plan modal ----- */
  $('addSubjectBtn').addEventListener('click', () => { if ($('subjectList').children.length < 10) addSubjectRow('', 'medium'); });
  $('planForm').addEventListener('submit', (e) => { e.preventDefault(); generatePlan(); });
  $('blankPlanBtn').addEventListener('click', () => guard(blankPlan, $('blankPlanBtn')));

  /* ----- habits ----- */
  $('addHabitBtn').addEventListener('click', () => openHabitModal(null));
  $('habitList').addEventListener('click', (e) => {
    const card = e.target.closest('.habit-card'); if (!card) return;
    const h = S.habits.find((x) => x.id === card.dataset.id); if (!h) return;
    if (e.target.closest('.hc-edit')) openHabitModal(h);
    else if (e.target.closest('.hc-del')) {
      guard(async () => {
        const ok = await confirmBox('Delete habit?', '“' + h.name + '” and its upcoming calendar blocks will be removed.', 'Delete');
        if (!ok) return;
        const r = await api('/api/habits/' + h.id + '?today=' + todayStr(), { method: 'DELETE' });
        S.habits = r.habits || [];
        renderHabits();
        await reloadActivePlan();
        toast('Habit deleted', 'ok');
      });
    }
  });
  $('habitForm').addEventListener('submit', (e) => { e.preventDefault(); guard(saveHabit, $('habitSave')); });

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

  /* ----- settings ----- */
  $('settingsForm').addEventListener('submit', (e) => { e.preventDefault(); guard(saveSettings, $('saveSettingsBtn')); });

  /* ----- chat ----- */
  $('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('chatInput').value;
    $('chatInput').value = ''; $('chatInput').style.height = 'auto';
    sendChat(t);
  });
  $('chatInput').addEventListener('input', () => {
    const el = $('chatInput'); el.style.height = 'auto'; el.style.height = Math.min(120, el.scrollHeight) + 'px';
  });
  $('chatInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && window.innerWidth >= 900) { e.preventDefault(); $('chatForm').requestSubmit(); }
  });
  $('chatChips').addEventListener('click', (e) => {
    const c = e.target.closest('.chip'); if (c) sendChat(c.dataset.prompt);
  });
  $('chatClear').addEventListener('click', () => guard(async () => {
    const ok = await confirmBox('Clear chat?', 'Your saved PulseBot conversation will be deleted.', 'Clear');
    if (!ok) return;
    await api('/api/chat', { method: 'DELETE' });
    renderChat([]);
  }));

  /* ----- housekeeping ----- */
  let rt = null;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!$('appShell').hidden && S.view === 'calendar') renderCalendar(); }, 200);
  });
  setInterval(() => { if (!$('appShell').hidden && S.view === 'calendar') updateNowLine(); }, 60000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !$('appShell').hidden && S.view === 'calendar') updateNowLine();
  });
}

/* ======================= START ======================= */
wire();
renderTimer();
init();

})();
