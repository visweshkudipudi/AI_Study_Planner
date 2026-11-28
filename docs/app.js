/* LearnPulse OS - app.js (v7 with AI Question Scanner)
   Viswesh & Team, Dept of CSE */

const API_BASE = "https://ai-study-planner-api.onrender.com"; // <-- Paste your exact Render URL (no trailing slash)

const DAY_START = 6 * 60;   // 6:00 AM
const DAY_END = 23 * 60;    // 11:00 PM
const HOUR_PX = 56;
const RING_C = 2 * Math.PI * 54;
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const VIEW_TITLES = {
  calendar: "Calendar",
  habits: "Habits",
  focus: "Focus",
  analytics: "Stats",
  scanner: "Scan AI",
  pulsebot: "PulseBot",
  settings: "Settings",
};

const $ = (id) => document.getElementById(id);

const S = {
  user: "",
  token: "",
  view: "calendar",
  streak: 0,
  todayMin: 0,
  weekMin: 0,
  settings: {},
  plans: [],
  activePlanId: null,
  planData: null,       // { plan, blocks, buffers }
  preview: null,        // { blocks, buffers, moves, changed, unplaced }
  habits: [],
  scans: [],
  chat: [],
  calDate: localDateStr(new Date()),
  calDays: window.innerWidth < 900 ? 1 : 3,
  inspBlock: null,
  editHabitId: null,
  notesCtx: null,
  quizState: null,
  scanImageData: "",
  scanMode: "solve",
  lastScan: null,
  timerTotal: 50 * 60,
  timerLeft: 50 * 60,
  timerRunning: false,
  timerEndAt: 0,
  timerId: null,
  chartAlloc: null,
  chartSubj: null,
  confirmCb: null,
  toastId: null,
};

// -------------------- Small utilities --------------------
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function parseDateLocal(s) {
  const [y, m, d] = String(s).split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(s, n) {
  const d = parseDateLocal(s);
  d.setDate(d.getDate() + n);
  return localDateStr(d);
}

function nowMin() {
  const d = new Date();
  return d.getHours() * 60 + d.getMinutes();
}

function nowHm() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function parseHm(s) {
  const [h, m] = String(s || "09:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

function fmt12(hm) {
  const m = parseHm(hm);
  const h24 = Math.floor(m / 60);
  const mm = String(m % 60).padStart(2, "0");
  const ap = h24 >= 12 ? "PM" : "AM";
  return `${h24 % 12 || 12}:${mm} ${ap}`;
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function toast(msg, kind = "") {
  const el = $("toast");
  el.textContent = msg;
  el.className = "toast" + (kind ? " " + kind : "");
  el.hidden = false;
  clearTimeout(S.toastId);
  S.toastId = setTimeout(() => { el.hidden = true; }, 3400);
}

function setLoading(btn, on) {
  if (!btn) return;
  btn.classList.toggle("loading", !!on);
  btn.disabled = !!on;
}

function showModal(id) { $(id).hidden = false; }
function hideModal(id) { $(id).hidden = true; }

function askConfirm(title, text, okLabel, cb) {
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmOk").textContent = okLabel || "Confirm";
  S.confirmCb = cb;
  showModal("confirmModal");
}

// -------------------- Markdown renderer (XSS-safe) --------------------
function renderInline(s) {
  return s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
}

function renderMd(md) {
  const text = String(md || "").replace(/\r\n/g, "\n");
  const codeBlocks = [];
  const stripped = text.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, (_, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code>${esc(code.trimEnd())}</code></pre>`);
    return `\n@@CODE_${idx}@@\n`;
  });

  const lines = stripped.split("\n");
  const out = [];
  let inUl = false;
  let inOl = false;

  const closeLists = () => {
    if (inUl) { out.push("</ul>"); inUl = false; }
    if (inOl) { out.push("</ol>"); inOl = false; }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const codeTag = /^@@CODE_(\d+)@@$/.exec(line.trim());
    if (codeTag) {
      closeLists();
      out.push(codeBlocks[Number(codeTag[1])]);
      continue;
    }
    if (!line.trim()) {
      closeLists();
      continue;
    }
    const h = /^(#{2,4})\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${renderInline(esc(h[2]))}</h${lvl}>`);
      continue;
    }
    const bq = /^>\s?(.*)$/.exec(line);
    if (bq) {
      closeLists();
      out.push(`<blockquote>${renderInline(esc(bq[1]))}</blockquote>`);
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    if (ul) {
      if (inOl) { out.push("</ol>"); inOl = false; }
      if (!inUl) { out.push("<ul>"); inUl = true; }
      out.push(`<li>${renderInline(esc(ul[1]))}</li>`);
      continue;
    }
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (!inOl) { out.push("<ol>"); inOl = true; }
      out.push(`<li>${renderInline(esc(ol[1]))}</li>`);
      continue;
    }
    closeLists();
    out.push(`<p>${renderInline(esc(line))}</p>`);
  }
  closeLists();
  return out.join("");
}

// -------------------- API client --------------------
async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (S.user && S.token && !opts.noAuth) {
    headers["X-Username"] = S.user;
    headers["X-Token"] = S.token;
  }
  const res = await fetch(API_BASE + path, {
    method: opts.method || "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    if (res.status === 401 && !opts.noAuth) {
      clearSessionLocal();
      showLogin("Session expired. Please sign in again.");
    }
    throw new Error(data.detail || `Request failed (${res.status})`);
  }
  return data;
}

// -------------------- Theme --------------------
function syncThemeIcon() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  $("themeBtn").textContent = cur === "dark" ? "☀️" : "🌙";
}

function toggleTheme() {
  const cur = document.documentElement.getAttribute("data-theme") || "light";
  const next = cur === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  try { localStorage.setItem("lp_theme", next); } catch {}
  syncThemeIcon();
  if (S.view === "analytics") loadAnalytics();
}

// -------------------- Auth & session --------------------
function saveSessionLocal(user, token) {
  S.user = user;
  S.token = token;
  try {
    localStorage.setItem("lp_user", user);
    localStorage.setItem("lp_token", token);
  } catch {}
}

function clearSessionLocal() {
  S.user = "";
  S.token = "";
  S.plans = [];
  S.activePlanId = null;
  S.planData = null;
  S.preview = null;
  S.habits = [];
  S.scans = [];
  S.chat = [];
  document.body.classList.remove("previewing");
  try {
    localStorage.removeItem("lp_user");
    localStorage.removeItem("lp_token");
  } catch {}
}

function showLogin(errMsg = "") {
  $("splash").hidden = true;
  $("appShell").hidden = true;
  $("loginScreen").hidden = false;
  $("loginPin").value = "";
  const err = $("loginError");
  err.textContent = errMsg;
  err.hidden = !errMsg;
}

async function handleLogin(e) {
  e.preventDefault();
  const user = $("loginUser").value.trim();
  const pin = $("loginPin").value.trim();
  const err = $("loginError");
  err.hidden = true;
  if (user.length < 2) { err.textContent = "Enter a username (at least 2 characters)."; err.hidden = false; return; }
  if (!/^\d{4}$/.test(pin)) { err.textContent = "PIN must be exactly 4 digits."; err.hidden = false; return; }

  const btn = $("loginBtn");
  setLoading(btn, true);
  try {
    const res = await api("/api/auth", { method: "POST", body: { username: user, pin }, noAuth: true });
    saveSessionLocal(res.username, res.token);
    await bootApp();
    toast(res.new_account ? `Welcome, ${res.username}! Account created.` : `Welcome back, ${res.username}!`, "ok");
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function handleLogout() {
  const u = S.user;
  const t = S.token;
  pauseTimer();
  clearSessionLocal();
  $("loginUser").value = "";
  showLogin();
  toast("Signed out");
  if (u && t) {
    fetch(API_BASE + "/api/logout", {
      method: "POST",
      headers: { "X-Username": u, "X-Token": t },
    }).catch(() => {});
  }
}

async function bootApp() {
  const today = localDateStr(new Date());
  const me = await api(`/api/me?today=${today}`);
  S.user = me.username;
  S.streak = me.streak || 0;
  S.todayMin = me.today_minutes || 0;
  S.weekMin = me.weekly_minutes || 0;
  S.settings = me.settings || {};
  S.habits = me.habits || [];
  S.plans = me.plans || [];
  S.activePlanId = me.active_plan_id;

  $("splash").hidden = true;
  $("loginScreen").hidden = true;
  $("appShell").hidden = false;

  updateTopbar();
  fillSettingsForm();
  applyDefaultTimer(S.settings.default_session || 50);
  renderPlanSelector();

  if (S.activePlanId) {
    await loadPlan(S.activePlanId);
  } else {
    S.planData = null;
    renderCalendar();
  }
  switchView("calendar");
}

function updateTopbar() {
  $("userName").textContent = S.user || "student";
  $("streakNum").textContent = String(S.streak || 0);
  $("focusToday").textContent = String(S.todayMin || 0);
  $("focusWeek").textContent = String(S.weekMin || 0);
}

// -------------------- Navigation --------------------
function switchView(view) {
  S.view = view;
  $("viewTitle").textContent = VIEW_TITLES[view] || "LearnPulse OS";
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === view);
  });
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("active", v.id === "view-" + view);
  });
  if (view === "calendar") renderCalendar();
  if (view === "habits") renderHabits();
  if (view === "analytics") loadAnalytics();
  if (view === "scanner") loadScans();
  if (view === "pulsebot") loadChat();
  if (view === "settings") fillSettingsForm();
}

// -------------------- Plans & Calendar --------------------
function renderPlanSelector() {
  const sel = $("planSelect");
  if (!S.plans.length) {
    sel.innerHTML = `<option value="">No plans</option>`;
    $("deletePlanBtn").disabled = true;
    $("rebalanceBtn").disabled = true;
    $("addBlockBtn").disabled = true;
    $("exportIcsBtn").disabled = true;
    $("printBtn").disabled = true;
    return;
  }
  sel.innerHTML = S.plans
    .map((p) => `<option value="${esc(p.id)}" ${p.id === S.activePlanId ? "selected" : ""}>${esc(p.name)}</option>`)
    .join("");
  $("deletePlanBtn").disabled = false;
  $("rebalanceBtn").disabled = false;
  $("addBlockBtn").disabled = false;
  $("exportIcsBtn").disabled = false;
  $("printBtn").disabled = false;
}

async function loadPlan(pid) {
  S.preview = null;
  document.body.classList.remove("previewing");
  $("previewBanner").hidden = true;
  const data = await api(`/api/plans/${pid}`);
  S.planData = data;
  S.activePlanId = pid;
  renderPlanSelector();
  renderCalendar();
}

function setCalDays(n) {
  S.calDays = window.innerWidth < 900 ? 1 : n;
  document.querySelectorAll("#viewSeg button").forEach((b) => {
    b.classList.toggle("active", Number(b.dataset.days) === S.calDays);
  });
  renderCalendar();
}

function visibleDates() {
  const count = window.innerWidth < 900 ? 1 : S.calDays;
  const arr = [];
  let base = S.calDate;
  if (count === 7) {
    const d = parseDateLocal(base);
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    base = localDateStr(d);
  }
  for (let i = 0; i < count; i++) arr.push(addDays(base, i));
  return arr;
}

function renderCalendar() {
  const hasPlan = !!S.planData;
  $("calWrap").hidden = !hasPlan;
  $("calEmpty").hidden = hasPlan;
  if (!hasPlan) return;

  const days = visibleDates();
  const today = localDateStr(new Date());
  const firstD = parseDateLocal(days[0]);
  const lastD = parseDateLocal(days[days.length - 1]);
  $("calLabel").textContent = days.length === 1
    ? firstD.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })
    : `${firstD.toLocaleDateString("en-IN", { day: "numeric", month: "short" })} – ${lastD.toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`;

  // Header
  $("calHead").innerHTML = `<div class="ch-gutter"></div>` + days.map((ds) => {
    const d = parseDateLocal(ds);
    const dow = DOW[(d.getDay() + 6) % 7];
    return `<div class="ch-day ${ds === today ? "today" : ""}">
      <div class="ch-dow">${dow}</div>
      <div class="ch-num">${d.getDate()}</div>
    </div>`;
  }).join("");

  // Time column (6 AM -> 11 PM)
  const totalHours = (DAY_END - DAY_START) / 60;
  let timeCol = `<div class="time-col">`;
  for (let h = 6; h < 23; h++) {
    const lbl = h === 12 ? "12p" : h > 12 ? `${h - 12}p` : `${h}a`;
    timeCol += `<div class="time-label"><span>${lbl}</span></div>`;
  }
  timeCol += `</div>`;

  const src = S.preview || S.planData;
  const blocks = src.blocks || [];
  const buffers = src.buffers || [];
  const movedSet = new Set(S.preview ? S.preview.changed : []);
  const nm = nowMin();

  const colsHtml = days.map((ds) => {
    const dayBlocks = blocks.filter((b) => b.date === ds);
    const dayBufs = buffers.filter((b) => b.date === ds);
    let inner = "";

    if (ds === today && nm >= DAY_START && nm <= DAY_END) {
      const top = ((nm - DAY_START) / 60) * HOUR_PX;
      inner += `<div class="now-line" style="top:${top}px"></div>`;
    }

    for (const buf of dayBufs) {
      const s = parseHm(buf.start);
      if (s < DAY_START || s >= DAY_END) continue;
      const top = ((s - DAY_START) / 60) * HOUR_PX;
      const h = Math.max(14, (buf.duration / 60) * HOUR_PX - 2);
      inner += `<div class="blk t-buffer" style="top:${top}px;height:${h}px">☕ Buffer (${buf.duration}m)</div>`;
    }

    for (const b of dayBlocks) {
      const s = parseHm(b.start);
      const top = Math.max(0, ((s - DAY_START) / 60) * HOUR_PX);
      const h = Math.max(22, (b.duration / 60) * HOUR_PX - 2);
      const cls = [
        "blk",
        `t-${b.type || "task"}`,
        (b.priority || "P3").toLowerCase(),
        h < 34 ? "short" : "",
        b.done ? "done" : "",
        movedSet.has(b.id) ? "moved" : "",
      ].filter(Boolean).join(" ");
      const icons = (b.locked ? "🔒" : "") + (b.defense === "free" ? "🔓" : "");
      inner += `<div class="${cls}" data-bid="${esc(b.id)}" style="top:${top}px;height:${h}px">
        ${icons ? `<span class="blk-icons">${icons}</span>` : ""}
        <span class="blk-title">${b.done ? "✓ " : ""}${esc(b.title)}</span>
        <span class="blk-time">${fmt12(b.start)} · ${b.duration}m${b.subject ? " · " + esc(b.subject) : ""}</span>
      </div>`;
    }
    return `<div class="day-col ${ds === today ? "today" : ""}" style="height:${totalHours * HOUR_PX}px">${inner}</div>`;
  }).join("");

  const grid = $("calGrid");
  grid.classList.toggle("previewing", !!S.preview);
  grid.innerHTML = timeCol + colsHtml;
}

// -------------------- Block Inspector --------------------
function openInspector(bid) {
  if (S.preview) {
    toast("Apply or discard Preview mode first.");
    return;
  }
  const b = (S.planData?.blocks || []).find((x) => x.id === bid);
  if (!b) return;
  S.inspBlock = b;

  $("inspHeading").textContent = b.title;
  $("inspMeta").innerHTML = `
    <span class="tag ${esc(b.type)}">${esc(b.type.toUpperCase())}</span>
    <span class="tag">${esc(b.priority)}</span>
    ${b.subject ? `<span class="tag">${esc(b.subject)}</span>` : ""}
    <span class="tag">${fmt12(b.start)} · ${b.duration}m</span>
  `;

  const doneBtn = $("inspDone");
  doneBtn.classList.toggle("on", !!b.done);
  doneBtn.textContent = b.done ? "✅ Completed" : "✅ Mark done";

  const lockBtn = $("inspLock");
  lockBtn.classList.toggle("on", !!b.locked);
  lockBtn.textContent = b.locked ? "🔒 Locked" : "🔓 Unlocked";

  const defBtn = $("inspDefense");
  defBtn.classList.toggle("on", b.defense === "busy");
  defBtn.textContent = b.defense === "busy" ? "🛡️ Busy" : "🔓 Free";

  $("inspTitle").value = b.title || "";
  $("inspSubject").value = b.subject || "";
  $("inspTopic").value = b.topic || "";
  $("inspDate").value = b.date || S.calDate;
  $("inspStart").value = b.start || "09:00";
  $("inspDuration").value = b.duration || 50;
  $("inspPriority").value = b.priority || "P3";

  showModal("inspectorModal");
}

async function saveInspector(e) {
  e.preventDefault();
  if (!S.inspBlock || !S.activePlanId) return;
  const btn = $("inspSave");
  setLoading(btn, true);
  try {
    const data = await api(`/api/plans/${S.activePlanId}/blocks/${S.inspBlock.id}`, {
      method: "PUT",
      body: {
        title: $("inspTitle").value.trim(),
        subject: $("inspSubject").value.trim(),
        topic: $("inspTopic").value.trim(),
        date: $("inspDate").value,
        start: $("inspStart").value,
        duration: Number($("inspDuration").value),
        priority: $("inspPriority").value,
      },
    });
    S.planData = data;
    renderCalendar();
    hideModal("inspectorModal");
    toast("Block updated", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

async function toggleInspectorDone() {
  if (!S.inspBlock || !S.activePlanId) return;
  try {
    const data = await api(`/api/plans/${S.activePlanId}/blocks/${S.inspBlock.id}/done`, {
      method: "POST",
      body: { done: !S.inspBlock.done, today: localDateStr(new Date()) },
    });
    S.planData = data;
    S.streak = data.streak ?? S.streak;
    S.todayMin = data.today_minutes ?? S.todayMin;
    S.weekMin = data.weekly_minutes ?? S.weekMin;
    updateTopbar();
    renderCalendar();
    openInspector(S.inspBlock.id);
  } catch (ex) {
    toast(ex.message, "error");
  }
}

async function toggleInspectorField(field, val) {
  if (!S.inspBlock || !S.activePlanId) return;
  try {
    const data = await api(`/api/plans/${S.activePlanId}/blocks/${S.inspBlock.id}`, {
      method: "PUT",
      body: { [field]: val },
    });
    S.planData = data;
    renderCalendar();
    openInspector(S.inspBlock.id);
  } catch (ex) {
    toast(ex.message, "error");
  }
}

function deleteInspectorBlock() {
  if (!S.inspBlock || !S.activePlanId) return;
  const bid = S.inspBlock.id;
  askConfirm("Delete block?", `Remove "${S.inspBlock.title}" from this plan?`, "Delete", async () => {
    try {
      S.planData = await api(`/api/plans/${S.activePlanId}/blocks/${bid}`, { method: "DELETE" });
      hideModal("inspectorModal");
      renderCalendar();
      toast("Block deleted");
    } catch (ex) {
      toast(ex.message, "error");
    }
  });
}

// -------------------- Add Block --------------------
function openAddBlock() {
  if (!S.activePlanId) return toast("Create a plan first.", "error");
  $("abTitle").value = "";
  $("abType").value = "task";
  $("abPriority").value = "P3";
  $("abSubject").value = "";
  $("abDate").value = S.calDate;
  $("abStart").value = "09:00";
  $("abDuration").value = S.settings.default_session || 50;
  $("abRepeat").value = 0;
  showModal("addBlockModal");
}

async function submitAddBlock(e) {
  e.preventDefault();
  const title = $("abTitle").value.trim();
  if (!title) return toast("Enter a title.", "error");
  const btn = $("abSave");
  setLoading(btn, true);
  try {
    const type = $("abType").value;
    S.planData = await api(`/api/plans/${S.activePlanId}/blocks`, {
      method: "POST",
      body: {
        title,
        type,
        priority: $("abPriority").value,
        subject: $("abSubject").value.trim(),
        date: $("abDate").value || S.calDate,
        start: $("abStart").value,
        duration: Number($("abDuration").value),
        locked: type === "fixed" ? true : undefined,
        repeat_weeks: Number($("abRepeat").value || 0),
      },
    });
    hideModal("addBlockModal");
    renderCalendar();
    toast("Block added", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

// -------------------- Create AI Plan / Blank Plan --------------------
function addSubjectRow(name = "", level = "medium") {
  const row = document.createElement("div");
  row.className = "subj-row";
  row.innerHTML = `
    <input type="text" maxlength="60" placeholder="Subject name" value="${esc(name)}">
    <select>
      <option value="weak" ${level === "weak" ? "selected" : ""}>Weak</option>
      <option value="medium" ${level === "medium" ? "selected" : ""}>Medium</option>
      <option value="strong" ${level === "strong" ? "selected" : ""}>Strong</option>
    </select>
    <button class="icon-btn" type="button" aria-label="Remove">✕</button>
  `;
  row.querySelector("button").addEventListener("click", () => {
    if ($("subjectList").children.length > 1) row.remove();
  });
  $("subjectList").appendChild(row);
}

function openPlanModal() {
  $("plName").value = "";
  $("plGoal").value = "";
  $("plStart").value = localDateStr(new Date());
  $("plExam").value = "";
  $("plDays").value = 7;
  $("plHours").value = 3;
  $("plSession").value = S.settings.default_session || 50;
  $("planError").hidden = true;
  $("subjectList").innerHTML = "";
  addSubjectRow("C Programming", "medium");
  addSubjectRow("Calculus & Matrices", "weak");
  showModal("planModal");
}

async function submitGeneratePlan(e) {
  e.preventDefault();
  const err = $("planError");
  err.hidden = true;
  const subjects = [...$("subjectList").querySelectorAll(".subj-row")]
    .map((r) => ({ name: r.querySelector("input").value.trim(), level: r.querySelector("select").value }))
    .filter((s) => s.name);
  if (!subjects.length) {
    err.textContent = "Add at least one subject.";
    err.hidden = false;
    return;
  }
  const btn = $("planGenBtn");
  setLoading(btn, true);
  try {
    const start_date = $("plStart").value || localDateStr(new Date());
    const data = await api("/api/plans/generate", {
      method: "POST",
      body: {
        name: $("plName").value.trim(),
        subjects,
        goal: $("plGoal").value.trim(),
        start_date,
        exam_date: $("plExam").value || null,
        days: Number($("plDays").value || 7),
        hours_per_day: Number($("plHours").value || 3),
        session_minutes: Number($("plSession").value || 50),
        today: localDateStr(new Date()),
        now_min: nowMin(),
      },
    });
    const list = await api("/api/plans");
    S.plans = list.plans;
    S.activePlanId = data.plan.id;
    S.planData = data;
    S.calDate = start_date;
    hideModal("planModal");
    renderPlanSelector();
    renderCalendar();
    toast(data.warning || `Plan "${data.plan.name}" created!`, data.warning ? "" : "ok");
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

async function createBlankPlan() {
  const btn = $("blankPlanBtn");
  setLoading(btn, true);
  try {
    const data = await api("/api/plans/blank", {
      method: "POST",
      body: { name: $("plName").value.trim() || "My Study Plan" },
    });
    const list = await api("/api/plans");
    S.plans = list.plans;
    S.activePlanId = data.plan.id;
    S.planData = data;
    hideModal("planModal");
    renderPlanSelector();
    renderCalendar();
    toast("Blank plan created", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

function deleteCurrentPlan() {
  if (!S.activePlanId || !S.planData) return;
  const pid = S.activePlanId;
  askConfirm("Delete plan?", `Permanently delete "${S.planData.plan.name}"?`, "Delete", async () => {
    try {
      const res = await api(`/api/plans/${pid}`, { method: "DELETE" });
      S.plans = res.plans || [];
      S.activePlanId = res.active_plan_id;
      if (S.activePlanId) await loadPlan(S.activePlanId);
      else { S.planData = null; renderPlanSelector(); renderCalendar(); }
      toast("Plan deleted");
    } catch (ex) {
      toast(ex.message, "error");
    }
  });
}

// -------------------- Rebalance (Preview + Apply) --------------------
async function runRebalancePreview() {
  if (!S.activePlanId) return;
  const btn = $("rebalanceBtn");
  setLoading(btn, true);
  try {
    const data = await api(`/api/plans/${S.activePlanId}/rebalance/preview`, {
      method: "POST",
      body: { today: localDateStr(new Date()), now_min: nowMin() },
    });
    if (!data.changed.length) {
      toast("Your schedule is already balanced!", "ok");
      return;
    }
    S.preview = data;
    document.body.classList.add("previewing");
    $("previewInfo").textContent = `${data.changed.length} block(s) shifted around locked slots. Nothing saved yet.`;
    $("previewBanner").hidden = false;
    renderCalendar();
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

async function applyPreview() {
  if (!S.preview || !S.activePlanId) return;
  const btn = $("applyPreviewBtn");
  setLoading(btn, true);
  try {
    S.planData = await api(`/api/plans/${S.activePlanId}/rebalance/apply`, {
      method: "POST",
      body: { moves: S.preview.moves },
    });
    discardPreview();
    toast("Rebalanced schedule applied!", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

function discardPreview() {
  S.preview = null;
  document.body.classList.remove("previewing");
  $("previewBanner").hidden = true;
  renderCalendar();
}

// -------------------- Export .ics & Print PDF --------------------
function exportIcs() {
  if (!S.planData) return;
  const pad = (n) => String(n).padStart(2, "0");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LearnPulse OS//Viswesh & Team Dept of CSE//EN"];
  for (const b of S.planData.blocks || []) {
    const [y, mo, d] = b.date.split("-").map(Number);
    const sm = parseHm(b.start);
    const start = new Date(y, mo - 1, d, Math.floor(sm / 60), sm % 60);
    const end = new Date(start.getTime() + b.duration * 60000);
    const fmt = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${b.id}@learnpulse.os`);
    lines.push(`DTSTART:${fmt(start)}`);
    lines.push(`DTEND:${fmt(end)}`);
    lines.push(`SUMMARY:[${b.priority}] ${b.title}`);
    lines.push(`DESCRIPTION:${b.subject || b.type} (${b.defense})`);
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${(S.planData.plan.name || "LearnPulse").replace(/\s+/g, "_")}.ics`;
  a.click();
}

function printPlan() {
  if (!S.planData) return;
  const byDay = {};
  for (const b of S.planData.blocks || []) {
    (byDay[b.date] = byDay[b.date] || []).push(b);
  }
  const daysHtml = Object.keys(byDay).sort().map((ds) => {
    const rows = byDay[ds].map((b) => `<tr>
      <td>${fmt12(b.start)} (${b.duration}m)</td>
      <td>${esc(b.title)}</td>
      <td>${esc(b.subject || b.type)}</td>
      <td>${esc(b.priority)}${b.locked ? " 🔒" : ""}</td>
      <td>${b.done ? "Done" : "Pending"}</td>
    </tr>`).join("");
    return `<div class="pr-day"><h2>${ds}</h2><table class="pr-table"><thead><tr><th>Time</th><th>Task</th><th>Subject</th><th>Priority</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }).join("");

  $("printArea").innerHTML = `
    <div class="pr-head">
      <h1>${esc(S.planData.plan.name)}</h1>
      <p>Student: ${esc(S.user)} · Exported ${localDateStr(new Date())}</p>
    </div>
    ${daysHtml || "<p>No scheduled blocks.</p>"}
    <div class="pr-foot">LearnPulse OS — Developed by Viswesh &amp; Team, Dept of CSE</div>
  `;
  window.print();
}

// -------------------- Habits --------------------
function renderHabits() {
  const list = $("habitList");
  if (!S.habits.length) {
    list.innerHTML = `<div class="empty"><div class="empty-ico">🔁</div><h3>No habits yet</h3><p>Add flexible daily study habits and LearnPulse will auto-place them around your classes.</p></div>`;
    return;
  }
  list.innerHTML = S.habits.map((h) => `
    <div class="habit-card">
      <div class="hc-name">${esc(h.name)}</div>
      <div class="hc-meta">
        <span>⏱ ${h.duration}m</span>
        <span>Window ${fmt12(h.earliest)}–${fmt12(h.latest)}</span>
        <span>Ideal ${fmt12(h.ideal)}</span>
        <span>${h.defense === "busy" ? "🛡️ Busy" : "🔓 Free"}</span>
      </div>
      <div class="hc-days">${DOW.map((d, i) => `<span class="hc-day ${(h.days || []).includes(i) ? "on" : ""}">${d}</span>`).join("")}</div>
      <div class="hc-actions">
        <button class="btn sm" type="button" data-edit-hab="${esc(h.id)}">Edit</button>
        <button class="btn sm danger-ghost" type="button" data-del-hab="${esc(h.id)}">Delete</button>
      </div>
    </div>
  `).join("");
}

function openHabitModal(hid = null) {
  S.editHabitId = hid;
  const h = hid ? S.habits.find((x) => x.id === hid) : null;
  $("habitHeading").textContent = h ? "Edit habit" : "New habit";
  $("hbName").value = h ? h.name : "";
  $("hbDuration").value = h ? h.duration : 30;
  $("hbDefense").value = h ? h.defense : "busy";
  $("hbEarliest").value = h ? h.earliest : "07:00";
  $("hbIdeal").value = h ? h.ideal : "08:00";
  $("hbLatest").value = h ? h.latest : "10:00";
  const days = h ? h.days : [0, 1, 2, 3, 4, 5, 6];
  $("hbDays").querySelectorAll("input").forEach((cb) => {
    cb.checked = days.includes(Number(cb.value));
  });
  $("habitError").hidden = true;
  showModal("habitModal");
}

async function submitHabit(e) {
  e.preventDefault();
  const err = $("habitError");
  err.hidden = true;
  const days = [...$("hbDays").querySelectorAll("input:checked")].map((c) => Number(c.value));
  const body = {
    name: $("hbName").value.trim(),
    duration: Number($("hbDuration").value || 30),
    defense: $("hbDefense").value,
    earliest: $("hbEarliest").value,
    ideal: $("hbIdeal").value,
    latest: $("hbLatest").value,
    days,
    today: localDateStr(new Date()),
  };
  const btn = $("habitSave");
  setLoading(btn, true);
  try {
    const res = S.editHabitId
      ? await api(`/api/habits/${S.editHabitId}`, { method: "PUT", body })
      : await api("/api/habits", { method: "POST", body });
    S.habits = res.habits || [];
    hideModal("habitModal");
    renderHabits();
    if (S.activePlanId) await loadPlan(S.activePlanId);
    toast("Habit saved & synced to calendar", "ok");
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

function deleteHabit(hid) {
  const h = S.habits.find((x) => x.id === hid);
  askConfirm("Delete habit?", `Delete "${h?.name || "this habit"}"?`, "Delete", async () => {
    try {
      const res = await api(`/api/habits/${hid}?today=${localDateStr(new Date())}`, { method: "DELETE" });
      S.habits = res.habits || [];
      renderHabits();
      if (S.activePlanId) await loadPlan(S.activePlanId);
      toast("Habit deleted");
    } catch (ex) {
      toast(ex.message, "error");
    }
  });
}

// -------------------- Focus Timer --------------------
function applyDefaultTimer(mins) {
  const m = [25, 50, 90].includes(Number(mins)) ? Number(mins) : 50;
  setTimerMinutes(m);
}

function setTimerMinutes(mins) {
  pauseTimer();
  S.timerTotal = mins * 60;
  S.timerLeft = S.timerTotal;
  document.querySelectorAll("#focusChips .chip").forEach((c) => {
    c.classList.toggle("active", Number(c.dataset.min) === mins);
  });
  updateTimerUI();
}

function updateTimerUI() {
  const mm = String(Math.floor(S.timerLeft / 60)).padStart(2, "0");
  const ss = String(S.timerLeft % 60).padStart(2, "0");
  $("timerDisplay").textContent = `${mm}:${ss}`;
  const ratio = S.timerTotal > 0 ? 1 - S.timerLeft / S.timerTotal : 0;
  $("timerRing").style.strokeDashoffset = String(RING_C * ratio);
  $("timerStart").hidden = S.timerRunning;
  $("timerPause").hidden = !S.timerRunning;
  $("timerFinish").hidden = S.timerLeft === S.timerTotal;
}

function startTimer() {
  if (S.timerRunning) return;
  S.timerRunning = true;
  S.timerEndAt = Date.now() + S.timerLeft * 1000;
  updateTimerUI();
  S.timerId = setInterval(() => {
    S.timerLeft = Math.max(0, Math.round((S.timerEndAt - Date.now()) / 1000));
    updateTimerUI();
    if (S.timerLeft <= 0) finishAndLogTimer(true);
  }, 500);
}

function pauseTimer() {
  S.timerRunning = false;
  clearInterval(S.timerId);
  S.timerId = null;
  updateTimerUI();
}

function resetTimer() {
  pauseTimer();
  S.timerLeft = S.timerTotal;
  updateTimerUI();
}

async function finishAndLogTimer(completed = false) {
  pauseTimer();
  const elapsedMin = completed ? Math.round(S.timerTotal / 60) : Math.max(1, Math.round((S.timerTotal - S.timerLeft) / 60));
  try {
    const res = await api("/api/focus", {
      method: "POST",
      body: {
        minutes: elapsedMin,
        subject: $("focusSubject").value.trim(),
        today: localDateStr(new Date()),
      },
    });
    S.streak = res.streak;
    S.todayMin = res.today_minutes;
    S.weekMin = res.weekly_minutes;
    updateTopbar();
    resetTimer();
    toast(`Logged ${elapsedMin} min focus session!`, "ok");
  } catch (ex) {
    toast(ex.message, "error");
  }
}

// -------------------- Analytics --------------------
async function loadAnalytics() {
  try {
    const d = await api(`/api/analytics?today=${localDateStr(new Date())}`);
    const loggedH = (d.weekly_logged_minutes / 60).toFixed(1);
    $("goalLabel").textContent = `${loggedH} / ${d.weekly_goal_hours} h`;
    $("goalBar").style.width = `${d.weekly_progress_pct}%`;
    $("goalPct").textContent = `${d.weekly_progress_pct}% of goal`;
    $("kpiStreak").textContent = String(d.streak);
    $("kpiDefended").textContent = `${d.defended_hours} h`;
    $("kpiTasks").textContent = `${d.tasks_done}/${d.tasks_total}`;

    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    const txtColor = isDark ? "#cbd5e1" : "#334155";
    const gridColor = isDark ? "rgba(148,163,184,.16)" : "rgba(15,23,42,.08)";

    if (S.chartAlloc) S.chartAlloc.destroy();
    S.chartAlloc = new Chart($("chartAlloc"), {
      type: "doughnut",
      data: {
        labels: d.allocation.labels,
        datasets: [{
          data: d.allocation.hours,
          backgroundColor: ["#14b8a6", "#3b82f6", "#8b5cf6", "#64748b", "#cbd5e1"],
          borderWidth: 0,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { color: txtColor } } },
      },
    });

    if (S.chartSubj) S.chartSubj.destroy();
    S.chartSubj = new Chart($("chartSubjects"), {
      type: "bar",
      data: {
        labels: d.subjects.map((s) => s.subject),
        datasets: [{
          label: "Completed %",
          data: d.subjects.map((s) => s.pct),
          backgroundColor: "#0d9488",
          borderRadius: 6,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          y: { min: 0, max: 100, ticks: { color: txtColor }, grid: { color: gridColor } },
          x: { ticks: { color: txtColor }, grid: { display: false } },
        },
        plugins: { legend: { display: false } },
      },
    });
  } catch (ex) {
    toast(ex.message, "error");
  }
}

// -------------------- AI Notes & 3-Q Quiz --------------------
async function openNotesForBlock(refresh = false) {
  if (!S.inspBlock && !S.notesCtx) return;
  if (!refresh && S.inspBlock) {
    S.notesCtx = {
      topic: S.inspBlock.topic || S.inspBlock.title,
      subject: S.inspBlock.subject || "",
      plan_id: S.activePlanId,
      block_id: S.inspBlock.id,
    };
  }
  const ctx = S.notesCtx;
  hideModal("inspectorModal");
  $("notesTitle").textContent = `Notes: ${ctx.topic}`;
  $("notesBody").innerHTML = `<p class="muted">Generating concise study notes…</p>`;
  showModal("notesModal");
  const btn = $("notesRefresh");
  setLoading(btn, true);
  try {
    const res = await api("/api/ai/notes", { method: "POST", body: { ...ctx, refresh } });
    $("notesBody").innerHTML = renderMd(res.notes);
  } catch (ex) {
    $("notesBody").innerHTML = `<p class="form-error">${esc(ex.message)}</p>`;
  } finally {
    setLoading(btn, false);
  }
}

async function openQuizForBlock() {
  if (!S.inspBlock) return;
  const topic = S.inspBlock.topic || S.inspBlock.title;
  const subject = S.inspBlock.subject || "";
  hideModal("inspectorModal");
  $("quizTitle").textContent = `Quiz: ${topic}`;
  $("quizBody").innerHTML = `<p class="muted">Building 3 practice questions…</p>`;
  showModal("quizModal");
  try {
    const res = await api("/api/ai/quiz", { method: "POST", body: { topic, subject } });
    S.quizState = { topic, subject, questions: res.questions, idx: 0, score: 0 };
    renderQuizStep();
  } catch (ex) {
    $("quizBody").innerHTML = `<p class="form-error">${esc(ex.message)}</p>`;
  }
}

function renderQuizStep() {
  const qz = S.quizState;
  const body = $("quizBody");
  if (qz.idx >= qz.questions.length) {
    body.innerHTML = `<div class="quiz-score"><b>${qz.score} / ${qz.questions.length}</b><p class="muted">${qz.score === qz.questions.length ? "Great job! Topic mastered." : "Added to your weak topics for revision."}</p></div>`;
    api("/api/quiz/result", {
      method: "POST",
      body: { topic: qz.topic, subject: qz.subject, score: qz.score, total: qz.questions.length },
    }).catch(() => {});
    return;
  }
  const q = qz.questions[qz.idx];
  body.innerHTML = `
    <div class="quiz-prog">Question ${qz.idx + 1} of ${qz.questions.length}</div>
    <div class="quiz-q">${esc(q.q)}</div>
    <div id="quizOpts">${q.options.map((o, i) => `<button class="quiz-opt" type="button" data-opt="${i}">${String.fromCharCode(65 + i)}. ${esc(o)}</button>`).join("")}</div>
    <div id="quizExpl" class="quiz-expl" hidden></div>
    <button id="quizNext" class="btn primary sm" type="button" hidden>${qz.idx + 1 < qz.questions.length ? "Next question →" : "See score"}</button>
  `;
  body.querySelectorAll(".quiz-opt").forEach((btn) => {
    btn.addEventListener("click", () => {
      const picked = Number(btn.dataset.opt);
      if (picked === q.answer) qz.score++;
      body.querySelectorAll(".quiz-opt").forEach((b, i) => {
        b.classList.add("disabled");
        if (i === q.answer) b.classList.add("correct");
        else if (i === picked) b.classList.add("wrong");
      });
      $("quizExpl").textContent = q.explanation || "";
      $("quizExpl").hidden = false;
      $("quizNext").hidden = false;
    });
  });
  $("quizNext").addEventListener("click", () => {
    qz.idx++;
    renderQuizStep();
  });
}

// -------------------- AI Question Scanner --------------------
function compressImageFile(file) {
  return new Promise((resolve, reject) => {
    if (!file || !file.type.startsWith("image/")) {
      return reject(new Error("Please pick a valid image file."));
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("Invalid image format."));
      img.onload = () => {
        const maxSide = 1400;
        let w = img.width;
        let h = img.height;
        if (w > maxSide || h > maxSide) {
          const scale = maxSide / Math.max(w, h);
          w = Math.round(w * scale);
          h = Math.round(h * scale);
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
        resolve({ dataUrl, w, h, kb: Math.round((dataUrl.length * 3) / 4096) });
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleScanFile(file) {
  const err = $("scanError");
  err.hidden = true;
  try {
    const out = await compressImageFile(file);
    S.scanImageData = out.dataUrl;
    $("scanPreviewImg").src = out.dataUrl;
    $("scanImgMeta").textContent = `${out.w}×${out.h}px · ~${out.kb} KB`;
    $("scanDropZone").hidden = true;
    $("scanPreviewWrap").hidden = false;
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  }
}

function clearSelectedScanImage() {
  S.scanImageData = "";
  $("scanCameraInput").value = "";
  $("scanFileInput").value = "";
  $("scanPreviewImg").removeAttribute("src");
  $("scanPreviewWrap").hidden = true;
  $("scanDropZone").hidden = false;
  $("scanError").hidden = true;
}

async function submitScan() {
  const err = $("scanError");
  err.hidden = true;
  if (!S.scanImageData) {
    err.textContent = "Take a photo or upload a question image first.";
    err.hidden = false;
    return;
  }
  const btn = $("scanSolveBtn");
  setLoading(btn, true);
  try {
    const res = await api("/api/ai/scan", {
      method: "POST",
      body: {
        image: S.scanImageData,
        subject: $("scanSubject").value.trim(),
        mode: S.scanMode,
        note: $("scanNote").value.trim(),
      },
    });
    S.lastScan = res.scan;
    S.scans = res.scans || [];
    showScanResult(res.scan);
    renderScanHistory();
    toast("Question solved!", "ok");
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    setLoading(btn, false);
  }
}

function showScanResult(scan) {
  S.lastScan = scan;
  $("scanResultBody").innerHTML = renderMd(scan.answer);
  $("scanResultCard").hidden = false;
  $("scanResultCard").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

async function loadScans() {
  try {
    const res = await api("/api/ai/scans");
    S.scans = res.scans || [];
    renderScanHistory();
  } catch {}
}

function renderScanHistory() {
  const wrap = $("scanHistoryList");
  if (!S.scans.length) {
    wrap.innerHTML = `<p class="muted small">No scanned questions yet.</p>`;
    return;
  }
  wrap.innerHTML = S.scans.map((sc) => `
    <button class="scan-item" type="button" data-scan-id="${esc(sc.id)}">
      <div class="scan-item-title">${esc(sc.title || "Scanned question")}</div>
      <div class="scan-item-meta">
        <span>${esc(sc.subject || sc.mode)}</span>
        <span>${sc.ts ? sc.ts.slice(0, 10) : ""}</span>
      </div>
    </button>
  `).join("");
}

// -------------------- PulseBot Chat --------------------
async function loadChat() {
  try {
    const res = await api("/api/chat");
    S.chat = res.messages || [];
    renderChat();
  } catch (ex) {
    toast(ex.message, "error");
  }
}

function renderChat(typing = false) {
  const log = $("chatLog");
  if (!S.chat.length && !typing) {
    log.innerHTML = `<div class="chat-empty">👋 Hi <b>${esc(S.user)}</b>! Ask PulseBot about your syllabus, code, or today's schedule.</div>`;
    return;
  }
  let html = S.chat.map((m) => `
    <div class="msg ${m.role === "user" ? "user" : "bot"}">
      <div class="bubble ${m.role === "user" ? "" : "md"}">${m.role === "user" ? esc(m.content) : renderMd(m.content)}</div>
    </div>
  `).join("");
  if (typing) {
    html += `<div class="msg bot"><div class="bubble"><span class="typing"><i></i><i></i><i></i></span></div></div>`;
  }
  log.innerHTML = html;
  log.scrollTop = log.scrollHeight;
}

async function sendChat(text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  $("chatInput").value = "";
  S.chat.push({ role: "user", content: msg });
  renderChat(true);
  const btn = $("chatSend");
  setLoading(btn, true);
  try {
    const res = await api("/api/chat", {
      method: "POST",
      body: { message: msg, today: localDateStr(new Date()), now: nowHm() },
    });
    S.chat = res.messages || S.chat;
    renderChat(false);
  } catch (ex) {
    S.chat.pop();
    renderChat(false);
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

// -------------------- Settings --------------------
function fillSettingsForm() {
  const st = S.settings || {};
  $("setStart").value = st.study_start || "09:00";
  $("setEnd").value = st.study_end || "21:00";
  $("setBuffer").value = st.buffer_min ?? 15;
  $("setMaxDaily").value = st.max_daily_hours ?? 6;
  $("setWeeklyGoal").value = st.weekly_goal_hours ?? 10;
  $("setSession").value = st.default_session ?? 50;
  $("setDefense").value = st.defense_mode || "proactive";
}

async function submitSettings(e) {
  e.preventDefault();
  const btn = $("saveSettingsBtn");
  setLoading(btn, true);
  try {
    const res = await api("/api/settings", {
      method: "PUT",
      body: {
        study_start: $("setStart").value,
        study_end: $("setEnd").value,
        buffer_min: Number($("setBuffer").value),
        max_daily_hours: Number($("setMaxDaily").value),
        weekly_goal_hours: Number($("setWeeklyGoal").value),
        default_session: Number($("setSession").value),
        defense_mode: $("setDefense").value,
      },
    });
    S.settings = res.settings;
    if (S.activePlanId) await loadPlan(S.activePlanId);
    toast("Settings saved", "ok");
  } catch (ex) {
    toast(ex.message, "error");
  } finally {
    setLoading(btn, false);
  }
}

// -------------------- Event Wiring --------------------
function bindEvents() {
  syncThemeIcon();
  $("themeBtn").addEventListener("click", toggleTheme);
  $("loginForm").addEventListener("submit", handleLogin);
  $("logoutBtn").addEventListener("click", handleLogout);
  $("splashSwitch").addEventListener("click", () => { clearSessionLocal(); showLogin(); });

  // Nav
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.addEventListener("click", () => switchView(b.dataset.view));
  });

  // Modals close
  document.querySelectorAll("[data-close]").forEach((el) => {
    el.addEventListener("click", () => {
      const m = el.closest(".modal");
      if (m) m.hidden = true;
    });
  });
  $("confirmOk").addEventListener("click", () => {
    hideModal("confirmModal");
    if (S.confirmCb) { const fn = S.confirmCb; S.confirmCb = null; fn(); }
  });

  // Calendar controls
  $("calPrev").addEventListener("click", () => { S.calDate = addDays(S.calDate, -(window.innerWidth < 900 ? 1 : S.calDays)); renderCalendar(); });
  $("calNext").addEventListener("click", () => { S.calDate = addDays(S.calDate, window.innerWidth < 900 ? 1 : S.calDays); renderCalendar(); });
  $("calToday").addEventListener("click", () => { S.calDate = localDateStr(new Date()); renderCalendar(); });
  document.querySelectorAll("#viewSeg button").forEach((b) => {
    b.addEventListener("click", () => setCalDays(Number(b.dataset.days)));
  });
  $("planSelect").addEventListener("change", async (e) => {
    const pid = e.target.value;
    if (!pid) return;
    try {
      S.planData = await api(`/api/plans/${pid}/activate`, { method: "PUT" });
      S.activePlanId = pid;
      renderCalendar();
    } catch (ex) {
      toast(ex.message, "error");
    }
  });
  $("newPlanBtn").addEventListener("click", openPlanModal);
  $("emptyCreateBtn").addEventListener("click", openPlanModal);
  $("addBlockBtn").addEventListener("click", openAddBlock);
  $("rebalanceBtn").addEventListener("click", runRebalancePreview);
  $("applyPreviewBtn").addEventListener("click", applyPreview);
  $("discardPreviewBtn").addEventListener("click", discardPreview);
  $("exportIcsBtn").addEventListener("click", exportIcs);
  $("printBtn").addEventListener("click", printPlan);
  $("deletePlanBtn").addEventListener("click", deleteCurrentPlan);

  $("calGrid").addEventListener("click", (e) => {
    const blk = e.target.closest(".blk[data-bid]");
    if (blk) openInspector(blk.dataset.bid);
  });

  // Inspector
  $("inspForm").addEventListener("submit", saveInspector);
  $("inspDone").addEventListener("click", toggleInspectorDone);
  $("inspLock").addEventListener("click", () => toggleInspectorField("locked", !S.inspBlock?.locked));
  $("inspDefense").addEventListener("click", () => toggleInspectorField("defense", S.inspBlock?.defense === "busy" ? "free" : "busy"));
  $("inspDelete").addEventListener("click", deleteInspectorBlock);
  $("inspNotes").addEventListener("click", () => openNotesForBlock(false));
  $("notesRefresh").addEventListener("click", () => openNotesForBlock(true));
  $("inspQuiz").addEventListener("click", openQuizForBlock);
  $("inspAsk").addEventListener("click", () => {
    if (!S.inspBlock) return;
    const prompt = `Explain "${S.inspBlock.topic || S.inspBlock.title}"${S.inspBlock.subject ? " (" + S.inspBlock.subject + ")" : ""} clearly with an example.`;
    hideModal("inspectorModal");
    switchView("pulsebot");
    sendChat(prompt);
  });

  // Add block & Plan modals
  $("addBlockForm").addEventListener("submit", submitAddBlock);
  $("addSubjectBtn").addEventListener("click", () => addSubjectRow());
  $("planForm").addEventListener("submit", submitGeneratePlan);
  $("blankPlanBtn").addEventListener("click", createBlankPlan);

  // Habits
  $("addHabitBtn").addEventListener("click", () => openHabitModal(null));
  $("habitForm").addEventListener("submit", submitHabit);
  $("habitList").addEventListener("click", (e) => {
    const ed = e.target.closest("[data-edit-hab]");
    const dl = e.target.closest("[data-del-hab]");
    if (ed) openHabitModal(ed.dataset.editHab);
    if (dl) deleteHabit(dl.dataset.delHab);
  });

  // Focus
  document.querySelectorAll("#focusChips .chip").forEach((c) => {
    c.addEventListener("click", () => setTimerMinutes(Number(c.dataset.min)));
  });
  $("timerStart").addEventListener("click", startTimer);
  $("timerPause").addEventListener("click", pauseTimer);
  $("timerFinish").addEventListener("click", () => finishAndLogTimer(false));
  $("timerReset").addEventListener("click", resetTimer);

  // Scanner
  $("scanCameraBtn").addEventListener("click", () => $("scanCameraInput").click());
  $("scanFileBtn").addEventListener("click", () => $("scanFileInput").click());
  $("scanCameraInput").addEventListener("change", (e) => { if (e.target.files[0]) handleScanFile(e.target.files[0]); });
  $("scanFileInput").addEventListener("change", (e) => { if (e.target.files[0]) handleScanFile(e.target.files[0]); });
  $("scanRemoveImg").addEventListener("click", clearSelectedScanImage);
  document.querySelectorAll("#scanModeChips .chip").forEach((c) => {
    c.addEventListener("click", () => {
      S.scanMode = c.dataset.mode;
      document.querySelectorAll("#scanModeChips .chip").forEach((x) => x.classList.toggle("active", x === c));
    });
  });
  $("scanSolveBtn").addEventListener("click", submitScan);
  $("scanCopyBtn").addEventListener("click", async () => {
    if (!S.lastScan) return;
    try { await navigator.clipboard.writeText(S.lastScan.answer); toast("Solution copied!", "ok"); }
    catch { toast("Copy failed on this browser", "error"); }
  });
  $("scanAskBotBtn").addEventListener("click", () => {
    if (!S.lastScan) return;
    switchView("pulsebot");
    sendChat(`I scanned this question: "${S.lastScan.title}". Explain the key trick to remember for exams and give me 1 similar practice question.`);
  });
  $("scanHistoryList").addEventListener("click", (e) => {
    const item = e.target.closest("[data-scan-id]");
    if (!item) return;
    const found = S.scans.find((x) => x.id === item.dataset.scanId);
    if (found) showScanResult(found);
  });
  $("scanClearHist").addEventListener("click", () => {
    if (!S.scans.length) return;
    askConfirm("Clear scan history?", "Remove all saved scanned solutions?", "Clear", async () => {
      await api("/api/ai/scans", { method: "DELETE" });
      S.scans = [];
      renderScanHistory();
      toast("Scan history cleared");
    });
  });

  // PulseBot
  $("chatForm").addEventListener("submit", (e) => { e.preventDefault(); sendChat($("chatInput").value); });
  $("chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat($("chatInput").value); }
  });
  document.querySelectorAll("#chatChips .chip").forEach((c) => {
    c.addEventListener("click", () => sendChat(c.dataset.prompt));
  });
  $("chatClear").addEventListener("click", () => {
    askConfirm("Clear chat?", "Delete your PulseBot conversation history?", "Clear", async () => {
      await api("/api/chat", { method: "DELETE" });
      S.chat = [];
      renderChat();
      toast("Chat cleared");
    });
  });

  // Settings
  $("settingsForm").addEventListener("submit", submitSettings);

  window.addEventListener("resize", () => { if (S.view === "calendar" && S.planData) renderCalendar(); });
}

// -------------------- Boot --------------------
async function init() {
  bindEvents();
  updateTimerUI();
  let u = "";
  let t = "";
  try {
    u = localStorage.getItem("lp_user") || "";
    t = localStorage.getItem("lp_token") || "";
  } catch {}
  if (u && t) {
    S.user = u;
    S.token = t;
    $("loginScreen").hidden = true;
    $("splash").hidden = false;
    try {
      await bootApp();
      return;
    } catch {
      clearSessionLocal();
    }
  }
  showLogin();
}

init();
