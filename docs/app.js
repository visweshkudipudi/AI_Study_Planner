const API_BASE = "https://ai-study-planner-api-6agl.onrender.com"; // <-- Paste YOUR exact Render URL here (no trailing slash)

const START_HOUR = 6; // 6:00 AM
const END_HOUR = 23;  // 11:00 PM
const PX_PER_HOUR = 62;

let session = { user_id: "", pin: "" };
let account = null;
let activePlanId = null;
let selectedDay = 1;
let calMode = "day"; // "day" | "week"
let previewPlan = null;
let inspectedTaskId = null;
let activeQuiz = [];

let categoryChart = null;
let subjectChart = null;

let timerBaseMin = 25;
let timerSec = 25 * 60;
let timerHandle = null;

// -------------------- Helpers --------------------
function esc(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBotMd(text) {
  let s = esc(text);
  s = s.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  return s.replace(/\n/g, "<br>");
}

function timeToMin(str) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(str || ""));
  if (!m) return 540;
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmt12h(str) {
  const mins = timeToMin(str);
  const h24 = Math.floor(mins / 60);
  const m = mins % 60;
  const suffix = h24 >= 12 ? "PM" : "AM";
  const h12 = h24 % 12 || 12;
  return `${h12}:${String(m).padStart(2, "0")} ${suffix}`;
}

function fmtDayDate(startStr, dayNum) {
  if (!startStr || dayNum <= 0) return "";
  const d = new Date(startStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + (dayNum - 1));
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

function getDisplayPlan() {
  if (previewPlan) return previewPlan;
  if (!account || !account.plans.length) return null;
  return account.plans.find((p) => p.plan_id === activePlanId) || account.plans[0];
}

function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

// -------------------- Theme --------------------
function toggleTheme() {
  document.body.classList.toggle("dark");
  const isDark = document.body.classList.contains("dark");
  localStorage.setItem("lp_theme", isDark ? "dark" : "light");
  document.getElementById("theme-toggle-btn").textContent = isDark ? "☀️" : "🌙";
}

if (localStorage.getItem("lp_theme") === "dark") {
  document.body.classList.add("dark");
}

// -------------------- Health --------------------
async function checkHealth() {
  const pills = [document.getElementById("api-status"), document.getElementById("auth-api-status")];
  try {
    const res = await fetch(`${API_BASE}/health`);
    pills.forEach((p) => {
      if (!p) return;
      p.textContent = res.ok ? "● Online" : "● Starting...";
      if (res.ok) p.classList.add("online");
    });
  } catch {
    pills.forEach((p) => { if (p) p.textContent = "● Waking up..."; });
  }
}

// -------------------- Auth --------------------
async function handleAuth(event) {
  event.preventDefault();
  const user_id = document.getElementById("login-user").value.trim().toLowerCase();
  const pin = document.getElementById("login-pin").value.trim();
  const errEl = document.getElementById("auth-error");
  const btn = document.getElementById("auth-btn");

  errEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Connecting to LearnPulse OS...";

  try {
    const res = await fetch(`${API_BASE}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Authentication failed");

    session = { user_id, pin };
    localStorage.setItem("lp_session", JSON.stringify(session));
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    enterApp();
  } catch (err) {
    errEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "Launch LearnPulse OS →";
  }
}

async function autoRestore() {
  const raw = localStorage.getItem("lp_session");
  if (!raw) return;
  try {
    const saved = JSON.parse(raw);
    if (!saved.user_id || !saved.pin) return;
    const res = await fetch(`${API_BASE}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(saved),
    });
    if (!res.ok) return;
    const data = await res.json();
    session = saved;
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    enterApp();
  } catch { /* stay on auth */ }
}

function enterApp() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("theme-toggle-btn").textContent = document.body.classList.contains("dark") ? "☀️" : "🌙";
  document.getElementById("start-date").value = new Date().toISOString().slice(0, 10);
  renderAll();
}

function logout() {
  localStorage.removeItem("lp_session");
  session = { user_id: "", pin: "" };
  account = null;
  previewPlan = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
}

// -------------------- Navigation --------------------
const VIEW_TITLES = {
  planner: "AI Planner",
  tasks: "Smart Tasks",
  habits: "Flexible Habits",
  focus: "Focus Time & Rules",
  analytics: "Time Analytics",
  chat: "PulseBot AI Mentor",
};

function switchView(name) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  document.querySelectorAll(".view-pane").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
  document.getElementById("view-heading").textContent = VIEW_TITLES[name] || "LearnPulse OS";

  if (name === "analytics") renderAnalytics();
  if (name === "chat") renderChat();
  if (name === "tasks") renderAllTasksView();
}

function setCalMode(mode) {
  calMode = mode;
  document.getElementById("mode-day-btn").classList.toggle("active", mode === "day");
  document.getElementById("mode-week-btn").classList.toggle("active", mode === "week");
  renderTimeline();
}

// -------------------- Master Render --------------------
function renderAll() {
  if (!account) return;

  document.getElementById("sidebar-user").textContent = account.user_id;
  document.getElementById("user-avatar").textContent = account.user_id.charAt(0).toUpperCase();
  document.getElementById("sidebar-streak").textContent = `🔥 ${account.streak || 0}d streak`;

  // Sync settings form
  const s = account.settings || {};
  document.getElementById("set-start").value = s.study_start || "07:00";
  document.getElementById("set-end").value = s.study_end || "22:30";
  document.getElementById("set-goal").value = s.focus_goal_hours || 14;
  document.getElementById("set-defense").value = s.defense_mode || "proactive";
  document.getElementById("set-buffers").value = String(s.auto_buffers !== false);
  document.getElementById("set-buf-min").value = s.buffer_minutes || 15;
  document.getElementById("defense-mode-badge").textContent = s.defense_mode === "reactive" ? "Reactive" : "Proactive";

  // Plan selector
  const sel = document.getElementById("plan-selector");
  if (!account.plans.length) {
    sel.innerHTML = `<option value="">No plans yet</option>`;
    document.getElementById("planner-empty").classList.remove("hidden");
    document.getElementById("planner-active").classList.add("hidden");
  } else {
    if (!account.plans.some((p) => p.plan_id === activePlanId)) {
      activePlanId = account.plans[0].plan_id;
    }
    sel.innerHTML = account.plans
      .map((p) => `<option value="${p.plan_id}" ${p.plan_id === activePlanId ? "selected" : ""}>📘 ${esc(p.plan_name)}</option>`)
      .join("");
    document.getElementById("planner-empty").classList.add("hidden");
    document.getElementById("planner-active").classList.remove("hidden");
    renderPlanner();
  }

  document.getElementById("preview-banner").classList.toggle("hidden", !previewPlan);
  renderHabits();
  renderAllTasksView();
  renderChat();
}

function selectPlan(planId) {
  previewPlan = null;
  activePlanId = planId;
  selectedDay = 1;
  renderAll();
}

// -------------------- Planner & Hourly Timeline --------------------
function renderPlanner() {
  const plan = getDisplayPlan();
  if (!plan) return;

  const studyDays = (plan.days || []).filter((d) => d.day > 0);
  if (studyDays.length && !studyDays.some((d) => d.day === selectedDay)) {
    selectedDay = studyDays[0].day;
  }

  document.getElementById("print-plan-title").textContent = `LearnPulse OS — ${plan.plan_name}`;
  document.getElementById("plan-summary").textContent = plan.summary || "";

  // Day switcher pills
  document.getElementById("day-pills").innerHTML = studyDays
    .map((d) => {
      const dt = fmtDayDate(plan.start_date, d.day);
      return `<button class="day-pill ${d.day === selectedDay ? "active" : ""}" onclick="pickDay(${d.day})">Day ${d.day}${dt ? " • " + dt : ""}</button>`;
    })
    .join("");

  // Progress & Priority Queue
  let total = 0;
  let done = 0;
  const pendingQueue = [];
  const prioOrder = { P1: 1, P2: 2, P3: 3, P4: 4 };

  (plan.days || []).forEach((d) => {
    (d.tasks || []).forEach((t) => {
      total++;
      if (t.done) done++;
      else pendingQueue.push({ ...t, day: d.day });
    });
  });

  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("plan-progress-pill").textContent = `${pct}% done (${done}/${total})`;
  document.getElementById("queue-count").textContent = `${pendingQueue.length} pending`;

  pendingQueue.sort((a, b) => (prioOrder[a.priority] || 3) - (prioOrder[b.priority] || 3) || a.day - b.day);
  document.getElementById("priority-queue-list").innerHTML = pendingQueue.length
    ? pendingQueue
        .slice(0, 8)
        .map(
          (t) => `
          <div class="queue-item" onclick="openBlockInspector('${t.id}')">
            <div class="queue-item-top">
              <span class="prio-tag prio-${t.priority || "P2"}">${t.priority || "P2"}</span>
              <span class="subtext">Day ${t.day} • ${fmt12h(t.start_time)}</span>
            </div>
            <strong>${esc(t.topic)}</strong>
            <span class="subtext">${esc(t.subject)} • ${t.duration_min}m ${t.locked ? "🔒" : ""}</span>
          </div>
        `
        )
        .join("")
    : `<p class="subtext">🎉 All tasks completed!</p>`;

  renderTimeline();
}

function pickDay(dayNum) {
  selectedDay = dayNum;
  renderPlanner();
}

function renderTimeline() {
  const plan = getDisplayPlan();
  if (!plan) return;
  const studyDays = (plan.days || []).filter((d) => d.day > 0);
  const currentDayObj = studyDays.find((d) => d.day === selectedDay) || studyDays[0];
  if (!currentDayObj) return;

  const isMobile = window.innerWidth <= 900;
  const effectiveMode = isMobile ? "day" : calMode;

  document.getElementById("cal-day-title").textContent =
    effectiveMode === "week"
      ? `${plan.plan_name} — Multi-Day View`
      : `Day ${currentDayObj.day}: ${currentDayObj.title}`;
  document.getElementById("cal-day-date").textContent = fmtDayDate(plan.start_date, currentDayObj.day);

  const visibleDays =
    effectiveMode === "week"
      ? studyDays.slice(
          Math.max(0, studyDays.findIndex((d) => d.day === selectedDay)),
          Math.max(0, studyDays.findIndex((d) => d.day === selectedDay)) + 3
        )
      : [currentDayObj];

  // Build time axis labels (6 AM -> 11 PM)
  let axisHtml = `<div class="time-axis">`;
  for (let h = START_HOUR; h < END_HOUR; h++) {
    const topPx = (h - START_HOUR) * PX_PER_HOUR;
    const label = h === 12 ? "12 PM" : h > 12 ? `${h - 12} PM` : `${h} AM`;
    axisHtml += `<span class="time-label" style="top:${topPx + 8}px">${label}</span>`;
  }
  axisHtml += `</div>`;

  // Current time red line position
  const now = new Date();
  const nowMins = now.getHours() * 60 + now.getMinutes();
  const nowTop = ((nowMins - START_HOUR * 60) / 60) * PX_PER_HOUR;
  const showNow = nowMins >= START_HOUR * 60 && nowMins <= END_HOUR * 60;

  const autoBuffers = account?.settings?.auto_buffers !== false;
  const bufMins = Number(account?.settings?.buffer_minutes || 15);

  const colsHtml = visibleDays
    .map((dayObj) => {
      const tasks = [...(dayObj.tasks || [])].sort((a, b) => timeToMin(a.start_time) - timeToMin(b.start_time));
      let blocksHtml = showNow ? `<div class="now-line" style="top:${nowTop}px"></div>` : "";

      tasks.forEach((t, idx) => {
        const startM = timeToMin(t.start_time);
        const durM = Number(t.duration_min || 45);
        const topPx = Math.max(0, ((startM - START_HOUR * 60) / 60) * PX_PER_HOUR);
        const heightPx = Math.max(36, (durM / 60) * PX_PER_HOUR - 3);
        const endM = startM + durM;

        const defenseIcon = t.locked ? "🔒" : t.defense === "busy" ? "🛡️" : "🔓";
        const typeCls = `type-${t.block_type || "task"}`;

        blocksHtml += `
          <div class="cal-block ${typeCls} ${t.done ? "is-done" : ""} ${previewPlan ? "is-preview" : ""}"
               style="top:${topPx}px; height:${heightPx}px;"
               onclick="openBlockInspector('${t.id}')">
            <div class="blk-top">
              <span>${fmt12h(t.start_time)} • ${durM}m</span>
              <span class="blk-badges">
                <span class="prio-tag prio-${t.priority || "P2"}">${t.priority || "P2"}</span>
                <span>${defenseIcon}</span>
              </span>
            </div>
            <div class="blk-topic">${t.done ? "✅ " : ""}${esc(t.topic)}</div>
            ${heightPx >= 52 ? `<div class="blk-sub">${esc(t.subject)} • ${t.defense === "busy" ? "Busy" : "Free"}</div>` : ""}
          </div>
        `;

        // Auto-Buffer decompression strip if enabled and no immediate overlap
        if (autoBuffers && t.block_type !== "fixed" && !t.done) {
          const nextTask = tasks[idx + 1];
          const nextStart = nextTask ? timeToMin(nextTask.start_time) : END_HOUR * 60;
          if (nextStart - endM >= bufMins) {
            const bufTop = ((endM - START_HOUR * 60) / 60) * PX_PER_HOUR;
            const bufH = Math.max(16, (bufMins / 60) * PX_PER_HOUR - 2);
            blocksHtml += `<div class="cal-buffer" style="top:${bufTop}px; height:${bufH}px;">☕ Auto-Buffer • ${bufMins}m break</div>`;
          }
        }
      });

      const dtLabel = fmtDayDate(plan.start_date, dayObj.day);
      return `
        <div class="day-column-wrap">
          ${effectiveMode === "week" ? `<div class="day-col-header"><span>Day ${dayObj.day}</span><span class="subtext">${dtLabel}</span></div>` : ""}
          <div class="day-column">${blocksHtml}</div>
        </div>
      `;
    })
    .join("");

  const grid = document.getElementById("timeline-grid");
  grid.className = `timeline-grid mode-${effectiveMode}`;
  grid.innerHTML = axisHtml + colsHtml;

  // Auto-scroll to ~7:30 AM on first render
  const scroller = document.getElementById("timeline-scroll");
  if (scroller && !scroller.dataset.scrolled) {
    scroller.scrollTop = PX_PER_HOUR * 1.5;
    scroller.dataset.scrolled = "1";
  }
}

// -------------------- Block Inspector --------------------
function findTaskInDisplayPlan(taskId) {
  const plan = getDisplayPlan();
  if (!plan) return null;
  for (const d of plan.days || []) {
    for (const t of d.tasks || []) {
      if (t.id === taskId) return { task: t, day: d.day };
    }
  }
  return null;
}

function openBlockInspector(taskId) {
  if (previewPlan) {
    alert("Apply or Discard Preview Mode first before editing individual blocks.");
    return;
  }
  const found = findTaskInDisplayPlan(taskId);
  if (!found) return;
  inspectedTaskId = taskId;
  const t = found.task;

  document.getElementById("bm-badge").textContent = `${t.priority || "P2"} • ${(t.block_type || "task").toUpperCase()} • Day ${found.day}`;
  document.getElementById("bm-title").textContent = `${t.subject}: ${t.topic}`;
  document.getElementById("bm-start").value = t.start_time || "09:00";
  document.getElementById("bm-dur").value = t.duration_min || 45;
  document.getElementById("bm-prio").value = t.priority || "P2";

  const doneBtn = document.getElementById("bm-done-btn");
  doneBtn.classList.toggle("active", !!t.done);
  doneBtn.textContent = t.done ? "✅ Completed" : "⬜ Mark Done";

  const lockBtn = document.getElementById("bm-lock-btn");
  lockBtn.classList.toggle("active", !!t.locked);
  lockBtn.textContent = t.locked ? "🔒 Locked" : "⚡ Flexible";

  const defBtn = document.getElementById("bm-def-btn");
  defBtn.classList.toggle("active", t.defense === "busy");
  defBtn.textContent = t.defense === "busy" ? "🛡️ Busy" : "🔓 Free";

  openModal("block-modal");
}

async function patchInspectedTask(payload) {
  const plan = getDisplayPlan();
  if (!plan || !inspectedTaskId) return;
  try {
    const res = await fetch(`${API_BASE}/api/tasks/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_id: plan.plan_id,
        task_id: inspectedTaskId,
        ...payload,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Update failed");
    account = data.account;
    renderAll();
    if (payload.delete) closeModal("block-modal");
    else openBlockInspector(inspectedTaskId);
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function inspectorAction(kind) {
  const found = findTaskInDisplayPlan(inspectedTaskId);
  if (!found) return;
  const t = found.task;
  if (kind === "done") patchInspectedTask({ done: !t.done });
  if (kind === "lock") patchInspectedTask({ locked: !t.locked });
  if (kind === "defense") patchInspectedTask({ defense: t.defense === "busy" ? "free" : "busy" });
}

async function inspectorSaveEdits() {
  await patchInspectedTask({
    start_time: document.getElementById("bm-start").value,
    duration_min: Number(document.getElementById("bm-dur").value),
    priority: document.getElementById("bm-prio").value,
  });
  closeModal("block-modal");
}

function inspectorDelete() {
  if (confirm("Delete this block from your calendar?")) {
    patchInspectedTask({ delete: true });
  }
}

// -------------------- Plan CRUD & Preview Mode --------------------
function openNewPlanModal() {
  document.getElementById("start-date").value = new Date().toISOString().slice(0, 10);
  openModal("new-plan-modal");
}

async function generatePlan(event) {
  event.preventDefault();
  const btn = document.getElementById("gen-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Building Smart Calendar...";

  try {
    const res = await fetch(`${API_BASE}/api/plans/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_name: document.getElementById("plan-name").value.trim(),
        subjects: document.getElementById("subjects").value.trim(),
        days: Number(document.getElementById("days").value),
        hours_per_day: Number(document.getElementById("hours").value),
        start_date: document.getElementById("start-date").value,
        weak_topics: document.getElementById("weak-topics").value.trim(),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Generation failed");

    previewPlan = null;
    account = data.account;
    activePlanId = data.plan.plan_id;
    selectedDay = 1;
    event.target.reset();
    closeModal("new-plan-modal");
    renderAll();
    switchView("planner");
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate Schedule";
  }
}

function openAddBlockModal() {
  if (!getDisplayPlan()) return alert("Create a study plan first.");
  document.getElementById("add-day").value = selectedDay || 1;
  openModal("add-block-modal");
}

async function submitAddBlock(event) {
  event.preventDefault();
  const plan = getDisplayPlan();
  if (!plan) return;
  const blockType = document.getElementById("add-type").value;

  try {
    const res = await fetch(`${API_BASE}/api/tasks/add`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_id: plan.plan_id,
        day: Number(document.getElementById("add-day").value),
        subject: document.getElementById("add-subject").value.trim(),
        topic: document.getElementById("add-topic").value.trim(),
        start_time: document.getElementById("add-start").value,
        duration_min: Number(document.getElementById("add-dur").value),
        priority: document.getElementById("add-priority").value,
        block_type: blockType,
        locked: blockType === "fixed",
        defense: "busy",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Could not add block");

    account = data.account;
    event.target.reset();
    closeModal("add-block-modal");
    renderAll();
  } catch (err) {
    alert(`Error: ${err.message}`);
  }
}

function openRebalanceModal() {
  const plan = getDisplayPlan();
  if (!plan) return;
  document.getElementById("rebalance-hours").value = plan.hours_per_day || 3.5;
  openModal("rebalance-modal");
}

async function runRebalancePreview() {
  const plan = getDisplayPlan();
  if (!plan) return;
  const btn = document.getElementById("rebalance-submit-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Calculating Preview...";

  try {
    const res = await fetch(`${API_BASE}/api/plans/rebalance-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_id: plan.plan_id,
        remaining_days: Number(document.getElementById("rebalance-days").value),
        hours_per_day: Number(document.getElementById("rebalance-hours").value),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Preview failed");

    previewPlan = data.preview_plan;
    selectedDay = 1;
    closeModal("rebalance-modal");
    switchView("planner");
    renderAll();
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "👀 Preview New Schedule";
  }
}

async function applyPreview() {
  if (!previewPlan) return;
  const btn = document.getElementById("apply-preview-btn");
  btn.disabled = true;
  btn.textContent = "Saving...";

  try {
    const res = await fetch(`${API_BASE}/api/plans/apply-preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: session.user_id, pin: session.pin, plan: previewPlan }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Apply failed");

    previewPlan = null;
    account = data.account;
    renderAll();
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "✅ Apply Schedule";
  }
}

function discardPreview() {
  previewPlan = null;
  renderAll();
}

async function deleteActivePlan() {
  const plan = getDisplayPlan();
  if (!plan || !confirm(`Delete "${plan.plan_name}" permanently?`)) return;
  const res = await fetch(`${API_BASE}/api/plans/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: session.user_id, pin: session.pin, plan_id: plan.plan_id }),
  });
  const data = await res.json();
  if (res.ok) {
    previewPlan = null;
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    renderAll();
  }
}

// -------------------- Tasks List View --------------------
function renderAllTasksView() {
  const el = document.getElementById("all-tasks-list");
  const plan = getDisplayPlan();
  if (!plan) {
    el.innerHTML = `<div class="panel-box"><p class="subtext">No active plan yet. Create a plan to see your priority tasks.</p></div>`;
    return;
  }

  const all = [];
  const prioRank = { P1: 1, P2: 2, P3: 3, P4: 4 };
  (plan.days || []).forEach((d) => {
    (d.tasks || []).forEach((t) => all.push({ ...t, day: d.day }));
  });
  all.sort((a, b) => Number(a.done) - Number(b.done) || (prioRank[a.priority] || 3) - (prioRank[b.priority] || 3) || a.day - b.day);

  el.innerHTML = all
    .map(
      (t) => `
      <div class="task-list-row ${t.done ? "done" : ""}" onclick="openBlockInspector('${t.id}')">
        <div>
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:3px;">
            <span class="prio-tag prio-${t.priority || "P2"}">${t.priority || "P2"}</span>
            <span class="subtext">${esc(t.subject)} • Day ${t.day} at ${fmt12h(t.start_time)} (${t.duration_min}m)</span>
          </div>
          <strong>${t.done ? "✅ " : ""}${esc(t.topic)}</strong>
        </div>
        <div class="subtext">${t.locked ? "🔒 Locked" : t.defense === "busy" ? "🛡️ Busy" : "🔓 Free"}</div>
      </div>
    `
    )
    .join("");
}

// -------------------- Habits & Settings --------------------
function renderHabits() {
  const list = document.getElementById("habits-list");
  const habits = account?.habits || [];
  if (!habits.length) {
    list.innerHTML = `<p class="subtext">No flexible habits added yet.</p>`;
    return;
  }
  list.innerHTML = habits
    .map(
      (h) => `
      <div class="habit-item">
        <div>
          <strong>🔁 ${esc(h.title)}</strong>
          <div class="subtext" style="color:inherit; opacity:0.85;">
            ${esc(h.subject)} • ${h.duration_min}m • Window ${fmt12h(h.window_start)}–${fmt12h(h.window_end)} (Ideal ${fmt12h(h.ideal_time)}) • ${h.defense === "busy" ? "🛡️ Busy" : "🔓 Free"}
          </div>
        </div>
        <button class="icon-btn danger-txt" onclick="deleteHabit('${h.id}')" title="Delete habit">🗑️</button>
      </div>
    `
    )
    .join("");
}

async function saveHabit(event) {
  event.preventDefault();
  const res = await fetch(`${API_BASE}/api/habits/save`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: session.user_id,
      pin: session.pin,
      title: document.getElementById("hab-title").value.trim(),
      subject: document.getElementById("hab-subject").value.trim(),
      duration_min: Number(document.getElementById("hab-dur").value),
      window_start: document.getElementById("hab-start").value,
      window_end: document.getElementById("hab-end").value,
      ideal_time: document.getElementById("hab-ideal").value,
      defense: document.getElementById("hab-def").value,
      active: true,
    }),
  });
  const data = await res.json();
  if (res.ok) {
    account = data.account;
    event.target.reset();
    renderAll();
  } else {
    alert(data.detail || "Could not save habit.");
  }
}

async function deleteHabit(habitId) {
  const res = await fetch(`${API_BASE}/api/habits/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: session.user_id, pin: session.pin, habit_id: habitId }),
  });
  const data = await res.json();
  if (res.ok) {
    account = data.account;
    renderAll();
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const res = await fetch(`${API_BASE}/api/settings/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: session.user_id,
      pin: session.pin,
      study_start: document.getElementById("set-start").value,
      study_end: document.getElementById("set-end").value,
      focus_goal_hours: Number(document.getElementById("set-goal").value),
      defense_mode: document.getElementById("set-defense").value,
      auto_buffers: document.getElementById("set-buffers").value === "true",
      buffer_minutes: Number(document.getElementById("set-buf-min").value),
    }),
  });
  const data = await res.json();
  if (res.ok) {
    account = data.account;
    renderAll();
    document.getElementById("settings-msg").textContent = "✅ Time rules & buffer settings saved!";
  }
}

// -------------------- AI Notes & Quiz --------------------
async function openTopicHelpFromInspector() {
  const found = findTaskInDisplayPlan(inspectedTaskId);
  if (!found) return;
  closeModal("block-modal");
  const t = found.task;

  document.getElementById("ai-modal-title").textContent = `💡 Notes: ${t.topic}`;
  document.getElementById("ai-modal-body").innerHTML = `<p class="subtext">⏳ Generating exam-ready notes...</p>`;
  openModal("ai-modal");

  try {
    const res = await fetch(`${API_BASE}/api/ai/topic-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: t.subject, topic: t.topic }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Failed");
    const d = json.data || {};
    document.getElementById("ai-modal-body").innerHTML = `
      <div class="note-card"><h4>Overview</h4><p>${esc(d.overview)}</p></div>
      <div class="note-card"><h4>Key Points</h4><ul>${(d.key_points || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul></div>
      ${(d.formulas_or_code || []).length ? `<div class="note-card"><h4>Formulas / Code</h4>${d.formulas_or_code.map((f) => `<div class="formula-line">${esc(f)}</div>`).join("")}</div>` : ""}
      <div class="note-card"><h4>🎯 Exam Tip</h4><p>${esc(d.exam_tip)}</p></div>
    `;
  } catch (err) {
    document.getElementById("ai-modal-body").innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

async function openTopicQuizFromInspector() {
  const found = findTaskInDisplayPlan(inspectedTaskId);
  if (!found) return;
  closeModal("block-modal");
  const t = found.task;

  document.getElementById("ai-modal-title").textContent = `🧠 Quick Quiz: ${t.topic}`;
  document.getElementById("ai-modal-body").innerHTML = `<p class="subtext">⏳ Building 3 practice questions...</p>`;
  openModal("ai-modal");

  try {
    const res = await fetch(`${API_BASE}/api/ai/topic-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: t.subject, topic: t.topic }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Failed");
    activeQuiz = json.questions || [];
    document.getElementById("ai-modal-body").innerHTML = activeQuiz
      .map(
        (q, qi) => `
        <div class="quiz-box" id="qz-${qi}">
          <strong>Q${qi + 1}. ${esc(q.question)}</strong>
          <div class="quiz-opts">
            ${(q.options || []).map((o, oi) => `<button class="quiz-opt" onclick="pickQuiz(${qi}, ${oi})">${String.fromCharCode(65 + oi)}. ${esc(o)}</button>`).join("")}
          </div>
          <p class="subtext hidden" id="qz-exp-${qi}" style="margin-top:0.45rem;"></p>
        </div>
      `
      )
      .join("");
  } catch (err) {
    document.getElementById("ai-modal-body").innerHTML = `<p class="error-text">${esc(err.message)}</p>`;
  }
}

function pickQuiz(qi, oi) {
  const box = document.getElementById(`qz-${qi}`);
  if (box.dataset.done) return;
  box.dataset.done = "1";
  const q = activeQuiz[qi];
  box.querySelectorAll(".quiz-opt").forEach((b, idx) => {
    if (idx === q.answer_index) b.classList.add("correct");
    else if (idx === oi) b.classList.add("wrong");
  });
  const exp = document.getElementById(`qz-exp-${qi}`);
  exp.textContent = `${oi === q.answer_index ? "✅ Correct!" : "❌ Incorrect."} ${q.explanation || ""}`;
  exp.classList.remove("hidden");
}

function askBotFromInspector() {
  const found = findTaskInDisplayPlan(inspectedTaskId);
  if (!found) return;
  closeModal("block-modal");
  switchView("chat");
  sendQuickPrompt(`Explain "${found.task.topic}" in ${found.task.subject} clearly with an exam-ready example.`);
}

// -------------------- PulseBot Chat --------------------
function renderChat(pending = "") {
  const feed = document.getElementById("chat-messages");
  if (!feed) return;
  const hist = account?.chat_history || [];

  let html = !hist.length && !pending
    ? `<div class="msg assistant"><span class="msg-who">🤖 PulseBot</span><div class="msg-body">Hi <strong>${esc(account?.user_id)}</strong>! I'm <strong>PulseBot</strong> inside LearnPulse OS. Ask me about your next priority block, weak topics, or any engineering concept.</div></div>`
    : hist.map((m) => `<div class="msg ${m.role}"><span class="msg-who">${m.role === "user" ? "You" : "🤖 PulseBot"}</span><div class="msg-body">${m.role === "assistant" ? formatBotMd(m.content) : esc(m.content)}</div></div>`).join("");

  if (pending) {
    html += `<div class="msg user"><span class="msg-who">You</span><div class="msg-body">${esc(pending)}</div></div>
             <div class="msg assistant"><span class="msg-who">🤖 PulseBot</span><div class="msg-body">⏳ Thinking...</div></div>`;
  }
  feed.innerHTML = html;
  feed.scrollTop = feed.scrollHeight;
}

async function sendChatMessage(event) {
  if (event) event.preventDefault();
  const input = document.getElementById("chat-input");
  const btn = document.getElementById("chat-send-btn");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  btn.disabled = true;
  renderChat(text);

  try {
    const res = await fetch(`${API_BASE}/api/chat/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: session.user_id, pin: session.pin, message: text, active_plan_id: activePlanId || "" }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "PulseBot unavailable");
    account.chat_history = data.chat_history || [];
    renderChat();
  } catch (err) {
    alert(err.message);
    renderChat();
  } finally {
    btn.disabled = false;
  }
}

function sendQuickPrompt(txt) {
  document.getElementById("chat-input").value = txt;
  sendChatMessage(null);
}

async function clearChat() {
  if (!confirm("Clear PulseBot chat history?")) return;
  const res = await fetch(`${API_BASE}/api/chat/clear`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: session.user_id, pin: session.pin }),
  });
  if (res.ok) {
    account.chat_history = [];
    renderChat();
  }
}

// -------------------- Analytics --------------------
function renderAnalytics() {
  if (!account) return;
  const plan = getDisplayPlan();
  const loggedHrs = (account.logged_minutes || 0) / 60;
  const goalHrs = account.settings?.focus_goal_hours || 14;

  document.getElementById("kpi-goal").textContent = `${loggedHrs.toFixed(1)} / ${goalHrs} hrs`;
  document.getElementById("kpi-goal-fill").style.width = `${Math.min(100, Math.round((loggedHrs / goalHrs) * 100))}%`;
  document.getElementById("kpi-streak").textContent = `🔥 ${account.streak || 0} days`;

  const catMins = { focus: 0, task: 0, habit: 0, fixed: 0 };
  const subMap = {};
  let defendedMins = 0;
  let doneCount = 0;
  let totalCount = 0;

  if (plan) {
    (plan.days || []).forEach((d) => {
      (d.tasks || []).forEach((t) => {
        totalCount++;
        const m = Number(t.duration_min || 45);
        const type = t.block_type || "task";
        catMins[type] = (catMins[type] || 0) + m;
        if (t.defense === "busy" || t.locked) defendedMins += m;
        if (t.done) doneCount++;

        const s = t.subject || "General";
        if (!subMap[s]) subMap[s] = { done: 0, total: 0 };
        subMap[s].total++;
        if (t.done) subMap[s].done++;
      });
    });
  }

  document.getElementById("kpi-defended").textContent = `${(defendedMins / 60).toFixed(1)} hrs`;
  document.getElementById("kpi-done").textContent = `${doneCount} / ${totalCount}`;

  if (categoryChart) categoryChart.destroy();
  categoryChart = new Chart(document.getElementById("category-chart"), {
    type: "doughnut",
    data: {
      labels: ["Focus Time", "Tasks", "Habits", "Fixed/Locked"],
      datasets: [{
        data: [+(catMins.focus / 60).toFixed(1), +(catMins.task / 60).toFixed(1), +(catMins.habit / 60).toFixed(1), +(catMins.fixed / 60).toFixed(1)],
        backgroundColor: ["#0d9488", "#2563eb", "#7c3aed", "#64748b"],
        borderWidth: 0,
      }],
    },
    options: { responsive: true, maintainAspectRatio: false },
  });

  const subjects = Object.keys(subMap);
  const pcts = subjects.map((s) => Math.round((subMap[s].done / subMap[s].total) * 100));

  if (subjectChart) subjectChart.destroy();
  subjectChart = new Chart(document.getElementById("subject-chart"), {
    type: "bar",
    data: {
      labels: subjects,
      datasets: [{ label: "Completed %", data: pcts, backgroundColor: "#4f46e5", borderRadius: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: { y: { min: 0, max: 100 } },
      plugins: { legend: { display: false } },
    },
  });
}

// -------------------- .ICS Calendar Export --------------------
function exportICS() {
  const plan = getDisplayPlan();
  if (!plan) return;
  const baseDate = new Date((plan.start_date || new Date().toISOString().slice(0, 10)) + "T00:00:00");
  const pad = (n) => String(n).padStart(2, "0");
  const fmtIcs = (dt) => `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;

  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LearnPulse OS//Viswesh & Team Dept of CSE//EN"];
  (plan.days || []).forEach((d) => {
    if (d.day <= 0) return;
    (d.tasks || []).forEach((t) => {
      const start = new Date(baseDate.getTime());
      start.setDate(start.getDate() + (d.day - 1));
      const m = timeToMin(t.start_time);
      start.setHours(Math.floor(m / 60), m % 60, 0, 0);
      const end = new Date(start.getTime() + Number(t.duration_min || 45) * 60000);

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${t.id}@learnpulse.os`);
      lines.push(`DTSTART:${fmtIcs(start)}`);
      lines.push(`DTEND:${fmtIcs(end)}`);
      lines.push(`SUMMARY:[${t.priority || "P2"}] ${t.subject}: ${t.topic}`);
      lines.push(`DESCRIPTION:LearnPulse OS (${t.block_type}) — ${t.defense === "busy" ? "Defended Busy" : "Flexible Free"}`);
      lines.push("END:VEVENT");
    });
  });
  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${plan.plan_name.replace(/\s+/g, "_")}_LearnPulseOS.ics`;
  a.click();
}

// -------------------- Focus Timer --------------------
function updateTimerUI() {
  const m = String(Math.floor(timerSec / 60)).padStart(2, "0");
  const s = String(timerSec % 60).padStart(2, "0");
  document.getElementById("timer-display").textContent = `${m}:${s}`;
  document.getElementById("log-mins-preview").textContent = timerBaseMin;
}
function setTimerMinutes(mins) { pauseTimer(); timerBaseMin = mins; timerSec = mins * 60; updateTimerUI(); }
function startTimer() {
  if (timerHandle) return;
  timerHandle = setInterval(() => {
    if (timerSec <= 0) { pauseTimer(); logCurrentSession(); alert(`🎉 ${timerBaseMin}m Focus Session logged!`); return; }
    timerSec--;
    updateTimerUI();
  }, 1000);
}
function pauseTimer() { clearInterval(timerHandle); timerHandle = null; }
function resetTimer() { pauseTimer(); timerSec = timerBaseMin * 60; updateTimerUI(); }

async function logCurrentSession() {
  if (!session.user_id) return;
  const res = await fetch(`${API_BASE}/api/focus/log`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: session.user_id, pin: session.pin, minutes: timerBaseMin }),
  });
  const data = await res.json();
  if (res.ok) {
    account = data.account;
    renderAll();
    document.getElementById("session-log-msg").textContent = `✅ +${timerBaseMin} min added to your Focus Goal!`;
  }
}

// Init
updateTimerUI();
checkHealth();
autoRestore();
window.addEventListener("resize", () => { if (account) renderTimeline(); });
