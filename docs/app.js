const API_BASE = "https://ai-study-planner-api.onrender.com"; // <-- Paste YOUR Render URL here (no trailing slash)

let session = { user_id: "", pin: "" };
let account = null;
let activePlanId = null;

let overallChart = null;
let subjectChart = null;

let timerBaseMinutes = 25;
let timerSeconds = 25 * 60;
let timerInterval = null;

// -------------------- Helpers --------------------
function escHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBotText(text) {
  let safe = escHtml(text);
  safe = safe.replace(/```(?:\w+)?\n?([\s\S]*?)```/g, "<pre><code>$1</code></pre>");
  safe = safe.replace(/`([^`]+)`/g, "<code>$1</code>");
  safe = safe.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  safe = safe.replace(/\n/g, "<br>");
  return safe;
}

function getActivePlan() {
  if (!account || !account.plans.length) return null;
  return account.plans.find((p) => p.plan_id === activePlanId) || account.plans[0];
}

function formatDayDate(startDateStr, dayNum) {
  if (!startDateStr || dayNum === 0) return "";
  const d = new Date(startDateStr + "T00:00:00");
  if (Number.isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + (dayNum - 1));
  return d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });
}

// -------------------- API Health --------------------
async function checkApiHealth() {
  const badge = document.getElementById("api-status");
  try {
    const res = await fetch(`${API_BASE}/health`);
    if (res.ok) {
      badge.textContent = "🟢 Online";
      badge.classList.add("online");
    } else {
      badge.textContent = "🟡 Starting...";
    }
  } catch {
    badge.textContent = "🔴 Waking up...";
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
  btn.textContent = "⏳ Connecting to LearnPulse OS...";

  try {
    const res = await fetch(`${API_BASE}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id, pin }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Login failed");

    session = { user_id, pin };
    localStorage.setItem("lp_session", JSON.stringify(session));
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    enterWorkspace();
  } catch (err) {
    errEl.textContent = `❌ ${err.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = "🚀 Launch LearnPulse OS";
  }
}

async function autoRestoreSession() {
  const saved = localStorage.getItem("lp_session");
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    if (!parsed.user_id || !parsed.pin) return;
    const res = await fetch(`${API_BASE}/api/auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: parsed.user_id, pin: parsed.pin }),
    });
    if (!res.ok) return;
    const data = await res.json();
    session = parsed;
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    enterWorkspace();
  } catch {
    // Stay on login screen if Render is waking up
  }
}

function enterWorkspace() {
  document.getElementById("auth-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
  document.getElementById("logout-btn").classList.remove("hidden");
  document.getElementById("header-streak").classList.remove("hidden");
  document.getElementById("start-date").value = new Date().toISOString().slice(0, 10);
  renderAll();
}

function logout() {
  localStorage.removeItem("lp_session");
  session = { user_id: "", pin: "" };
  account = null;
  activePlanId = null;
  document.getElementById("app-shell").classList.add("hidden");
  document.getElementById("logout-btn").classList.add("hidden");
  document.getElementById("header-streak").classList.add("hidden");
  document.getElementById("auth-screen").classList.remove("hidden");
}

// -------------------- Navigation --------------------
function switchTab(tabName) {
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-pane").forEach((p) => p.classList.add("hidden"));
  document.getElementById(`tab-${tabName}`).classList.remove("hidden");
  if (tabName === "analytics") renderAnalytics();
  if (tabName === "chat") renderChat();
}

// -------------------- Rendering --------------------
function renderAll() {
  if (!account) return;

  const totalDone = account.plans.reduce((acc, p) => {
    let c = 0;
    (p.days || []).forEach((d) => (d.tasks || []).forEach((t) => { if (t.done) c++; }));
    return acc + c;
  }, 0);

  document.getElementById("display-user").textContent = account.user_id;
  document.getElementById("stat-streak").textContent = `🔥 ${account.streak || 0} days`;
  document.getElementById("header-streak").textContent = `🔥 ${account.streak || 0}d`;
  document.getElementById("stat-hours").textContent = `${((account.logged_minutes || 0) / 60).toFixed(1)} hrs`;
  document.getElementById("stat-completed").textContent = `${totalDone} tasks`;

  renderChat();

  const selector = document.getElementById("plan-selector");
  const delBtn = document.getElementById("delete-plan-btn");
  const actionsBar = document.getElementById("plan-actions-bar");
  const emptyState = document.getElementById("empty-plan-state");
  const activeArea = document.getElementById("active-plan-area");

  if (!account.plans.length) {
    selector.innerHTML = `<option value="">No plans created yet</option>`;
    delBtn.classList.add("hidden");
    actionsBar.classList.add("hidden");
    emptyState.classList.remove("hidden");
    activeArea.classList.add("hidden");
    return;
  }

  if (!account.plans.some((p) => p.plan_id === activePlanId)) {
    activePlanId = account.plans[0].plan_id;
  }

  selector.innerHTML = account.plans
    .map((p) => `<option value="${p.plan_id}" ${p.plan_id === activePlanId ? "selected" : ""}>📘 ${escHtml(p.plan_name)} (${p.days_count}d)</option>`)
    .join("");

  delBtn.classList.remove("hidden");
  actionsBar.classList.remove("hidden");
  emptyState.classList.add("hidden");
  activeArea.classList.remove("hidden");

  renderActivePlan();
}

function selectPlan(planId) {
  activePlanId = planId;
  renderActivePlan();
}

function renderActivePlan() {
  const plan = getActivePlan();
  if (!plan) return;

  document.getElementById("plan-title-display").textContent = plan.plan_name;
  document.getElementById("plan-summary").textContent = plan.summary || "";

  let total = 0;
  let done = 0;

  const html = (plan.days || [])
    .map((d) => {
      const dateTag = formatDayDate(plan.start_date, d.day);
      const dayLabel = d.day === 0 ? `✅ ${escHtml(d.title)}` : `Day ${d.day}: ${escHtml(d.title)}`;

      const tasksHtml = (d.tasks || [])
        .map((t) => {
          total++;
          if (t.done) done++;
          return `
            <div class="task-row ${t.done ? "done" : ""}">
              <label class="task-left">
                <input type="checkbox" ${t.done ? "checked" : ""} onchange="toggleTask('${t.id}', this.checked)" />
                <div>
                  <div class="task-meta">${escHtml(t.subject)} • ${escHtml(t.duration)}</div>
                  <div class="task-topic">${escHtml(t.topic)}</div>
                </div>
              </label>
              <div class="task-actions no-print">
                <button class="mini-ai-btn" onclick="openTopicHelp('${t.id}')">💡 Notes</button>
                <button class="mini-ai-btn" onclick="openTopicQuiz('${t.id}')">🧠 Quiz</button>
                <button class="mini-ai-btn" onclick="askPulseBotAboutTask('${t.id}')">🤖 Ask</button>
              </div>
            </div>
          `;
        })
        .join("");

      return `
        <div class="day-box">
          <div class="day-head">
            <h3>${dayLabel}</h3>
            ${dateTag ? `<span class="day-date">${dateTag}</span>` : ""}
          </div>
          ${tasksHtml}
        </div>
      `;
    })
    .join("");

  document.getElementById("days-container").innerHTML = html;
  const pct = total ? Math.round((done / total) * 100) : 0;
  document.getElementById("progress-text").textContent = `${pct}% (${done}/${total})`;
  document.getElementById("progress-fill").style.width = `${pct}%`;
}

// -------------------- Exclusive PulseBot Chat --------------------
function renderChat(pendingUserText = "") {
  const container = document.getElementById("chat-messages");
  if (!container) return;

  const history = account?.chat_history || [];
  let html = "";

  if (!history.length && !pendingUserText) {
    html = `
      <div class="msg-row assistant">
        <span class="msg-sender">🤖 PulseBot</span>
        <div class="msg-bubble">
          Hey <strong>${escHtml(account?.user_id || "there")}</strong>! I am <strong>PulseBot</strong>, your exclusive AI Study Mentor built into LearnPulse OS.<br><br>
          Ask me to explain any concept, write simplified code, solve derivations, or guide your next study session!
        </div>
      </div>
    `;
  } else {
    html = history
      .map(
        (m) => `
        <div class="msg-row ${m.role}">
          <span class="msg-sender">${m.role === "user" ? "👤 You" : "🤖 PulseBot"}</span>
          <div class="msg-bubble">${m.role === "assistant" ? formatBotText(m.content) : escHtml(m.content)}</div>
        </div>
      `
      )
      .join("");
  }

  if (pendingUserText) {
    html += `
      <div class="msg-row user">
        <span class="msg-sender">👤 You</span>
        <div class="msg-bubble">${escHtml(pendingUserText)}</div>
      </div>
      <div class="msg-row assistant">
        <span class="msg-sender">🤖 PulseBot</span>
        <div class="msg-bubble">⏳ Thinking...</div>
      </div>
    `;
  }

  container.innerHTML = html;
  container.scrollTop = container.scrollHeight;
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
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        message: text,
        active_plan_id: activePlanId || "",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "PulseBot could not reply.");

    account.chat_history = data.chat_history || [];
    renderChat();
  } catch (err) {
    alert(`PulseBot Error: ${err.message}`);
    renderChat();
  } finally {
    btn.disabled = false;
    input.focus();
  }
}

function sendQuickPrompt(promptText) {
  document.getElementById("chat-input").value = promptText;
  sendChatMessage(null);
}

function askPulseBotAboutTask(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;
  switchTab("chat");
  sendQuickPrompt(`Explain "${task.topic}" in ${task.subject} clearly with an easy example for exams.`);
}

async function clearChat() {
  if (!confirm("Clear your PulseBot conversation history?")) return;
  try {
    const res = await fetch(`${API_BASE}/api/chat/clear`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: session.user_id, pin: session.pin }),
    });
    if (res.ok) {
      account.chat_history = [];
      renderChat();
    }
  } catch {
    alert("Could not clear chat right now.");
  }
}

// -------------------- Plan Actions --------------------
async function generatePlan(event) {
  event.preventDefault();
  const btn = document.getElementById("gen-btn");
  btn.disabled = true;
  btn.textContent = "⏳ LearnPulse AI is crafting your plan...";

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

    account = data.account;
    activePlanId = data.plan.plan_id;
    event.target.reset();
    document.getElementById("start-date").value = new Date().toISOString().slice(0, 10);
    renderAll();
    switchTab("schedule");
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Generate AI Schedule";
  }
}

async function toggleTask(taskId, isDone) {
  const plan = getActivePlan();
  if (!plan) return;

  for (const d of plan.days) {
    for (const t of d.tasks) {
      if (t.id === taskId) t.done = isDone;
    }
  }
  renderActivePlan();

  try {
    const res = await fetch(`${API_BASE}/api/tasks/toggle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_id: plan.plan_id,
        task_id: taskId,
        done: isDone,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      account = data.account;
      renderAll();
    }
  } catch {
    alert("Sync failed — check your internet connection.");
  }
}

async function deleteActivePlan() {
  const plan = getActivePlan();
  if (!plan) return;
  if (!confirm(`Delete "${plan.plan_name}" permanently?`)) return;

  try {
    const res = await fetch(`${API_BASE}/api/plans/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: session.user_id,
        pin: session.pin,
        plan_id: plan.plan_id,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail);
    account = data.account;
    activePlanId = account.plans[0]?.plan_id || null;
    renderAll();
  } catch (err) {
    alert(`Delete failed: ${err.message}`);
  }
}

// -------------------- Adaptive Rescheduler --------------------
function openRebalanceModal() {
  const plan = getActivePlan();
  if (!plan) return;
  document.getElementById("rebalance-hours").value = plan.hours_per_day || 3;
  document.getElementById("rebalance-modal").classList.add("open");
}

function closeRebalanceModal() {
  document.getElementById("rebalance-modal").classList.remove("open");
}

async function submitRebalance() {
  const plan = getActivePlan();
  if (!plan) return;
  const btn = document.getElementById("rebalance-submit-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Rebalancing...";

  try {
    const res = await fetch(`${API_BASE}/api/plans/rebalance`, {
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
    if (!res.ok) throw new Error(data.detail || "Rebalance failed");

    account = data.account;
    activePlanId = data.plan.plan_id;
    closeRebalanceModal();
    renderAll();
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "⚡ Rebalance Now";
  }
}

// -------------------- AI Topic Notes & Quick Quiz --------------------
function findTaskById(taskId) {
  const plan = getActivePlan();
  if (!plan) return null;
  for (const d of plan.days || []) {
    for (const t of d.tasks || []) {
      if (t.id === taskId) return t;
    }
  }
  return null;
}

function closeAiModal() {
  document.getElementById("ai-modal").classList.remove("open");
}

async function openTopicHelp(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;

  document.getElementById("ai-modal-title").textContent = `💡 ${task.subject}: ${task.topic}`;
  document.getElementById("ai-modal-body").innerHTML = `<p class="muted">⏳ Generating concise study notes...</p>`;
  document.getElementById("ai-modal").classList.add("open");

  try {
    const res = await fetch(`${API_BASE}/api/ai/topic-help`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: task.subject, topic: task.topic }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Failed to load notes");
    const d = json.data || {};

    const points = (d.key_points || []).map((p) => `<li>${escHtml(p)}</li>`).join("");
    const formulas = (d.formulas_or_code || []).map((f) => `<div class="code-chip">${escHtml(f)}</div>`).join("");

    document.getElementById("ai-modal-body").innerHTML = `
      <div class="note-box">
        <h4>Quick Overview</h4>
        <p>${escHtml(d.overview)}</p>
      </div>
      <div class="note-box">
        <h4>Key Exam Points</h4>
        <ul>${points}</ul>
      </div>
      ${formulas ? `<div class="note-box"><h4>Key Formulas / Syntax</h4>${formulas}</div>` : ""}
      <div class="note-box">
        <h4>🎯 High-Scoring Exam Tip</h4>
        <p>${escHtml(d.exam_tip)}</p>
      </div>
    `;
  } catch (err) {
    document.getElementById("ai-modal-body").innerHTML = `<p class="error-msg">❌ ${escHtml(err.message)}</p>`;
  }
}

let activeQuizData = [];

async function openTopicQuiz(taskId) {
  const task = findTaskById(taskId);
  if (!task) return;

  document.getElementById("ai-modal-title").textContent = `🧠 Quick Quiz: ${task.topic}`;
  document.getElementById("ai-modal-body").innerHTML = `<p class="muted">⏳ Generating 3 practice questions...</p>`;
  document.getElementById("ai-modal").classList.add("open");

  try {
    const res = await fetch(`${API_BASE}/api/ai/topic-quiz`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subject: task.subject, topic: task.topic }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.detail || "Failed to load quiz");

    activeQuizData = json.questions || [];
    if (!activeQuizData.length) throw new Error("No questions returned.");

    document.getElementById("ai-modal-body").innerHTML = activeQuizData
      .map(
        (q, qi) => `
        <div class="quiz-card" id="quiz-q-${qi}">
          <div class="quiz-q">Q${qi + 1}. ${escHtml(q.question)}</div>
          <div class="quiz-opts">
            ${(q.options || [])
              .map(
                (opt, oi) =>
                  `<button class="quiz-opt" onclick="answerQuiz(${qi}, ${oi}, this)">${String.fromCharCode(65 + oi)}. ${escHtml(opt)}</button>`
              )
              .join("")}
          </div>
          <div class="quiz-exp hidden" id="quiz-exp-${qi}"></div>
        </div>
      `
      )
      .join("");
  } catch (err) {
    document.getElementById("ai-modal-body").innerHTML = `<p class="error-msg">❌ ${escHtml(err.message)}</p>`;
  }
}

function answerQuiz(qIdx, selectedIdx) {
  const card = document.getElementById(`quiz-q-${qIdx}`);
  if (card.dataset.answered) return;
  card.dataset.answered = "1";

  const q = activeQuizData[qIdx];
  const buttons = card.querySelectorAll(".quiz-opt");
  buttons.forEach((b, idx) => {
    if (idx === q.answer_index) b.classList.add("correct");
    else if (idx === selectedIdx) b.classList.add("wrong");
  });

  const exp = document.getElementById(`quiz-exp-${qIdx}`);
  exp.textContent = `${selectedIdx === q.answer_index ? "✅ Correct!" : "❌ Not quite."} ${q.explanation || ""}`;
  exp.classList.remove("hidden");
}

// -------------------- Calendar (.ics) Export --------------------
function exportICS() {
  const plan = getActivePlan();
  if (!plan) return;

  const baseDate = new Date((plan.start_date || new Date().toISOString().slice(0, 10)) + "T09:00:00");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//LearnPulse OS//Viswesh & Team Dept of CSE//EN",
  ];

  const pad = (n) => String(n).padStart(2, "0");
  const toIcsDate = (dt) =>
    `${dt.getFullYear()}${pad(dt.getMonth() + 1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;

  (plan.days || []).forEach((d) => {
    if (d.day === 0) return;
    let cursor = new Date(baseDate.getTime());
    cursor.setDate(cursor.getDate() + (d.day - 1));

    (d.tasks || []).forEach((t) => {
      const start = new Date(cursor.getTime());
      const end = new Date(cursor.getTime() + 60 * 60 * 1000);
      cursor = new Date(end.getTime() + 15 * 60 * 1000);

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${t.id}@learnpulse.os`);
      lines.push(`DTSTART:${toIcsDate(start)}`);
      lines.push(`DTEND:${toIcsDate(end)}`);
      lines.push(`SUMMARY:[${t.subject}] ${t.topic}`);
      lines.push(`DESCRIPTION:LearnPulse OS Plan: ${plan.plan_name} (${t.duration})`);
      lines.push("END:VEVENT");
    });
  });

  lines.push("END:VCALENDAR");

  const blob = new Blob([lines.join("\r\n")], { type: "text/calendar;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${plan.plan_name.replace(/\s+/g, "_")}_LearnPulse.ics`;
  a.click();
}

// -------------------- Analytics (Chart.js) --------------------
function renderAnalytics() {
  const plan = getActivePlan();
  const emptyEl = document.getElementById("analytics-empty");
  const chartsWrap = document.getElementById("analytics-charts");

  if (!plan || !(plan.days || []).length) {
    emptyEl.classList.remove("hidden");
    chartsWrap.classList.add("hidden");
    return;
  }

  emptyEl.classList.add("hidden");
  chartsWrap.classList.remove("hidden");

  let doneTotal = 0;
  let pendingTotal = 0;
  const subMap = {};

  (plan.days || []).forEach((d) => {
    (d.tasks || []).forEach((t) => {
      const subj = t.subject || "General";
      if (!subMap[subj]) subMap[subj] = { done: 0, total: 0 };
      subMap[subj].total++;
      if (t.done) {
        doneTotal++;
        subMap[subj].done++;
      } else {
        pendingTotal++;
      }
    });
  });

  if (overallChart) overallChart.destroy();
  overallChart = new Chart(document.getElementById("overall-chart"), {
    type: "doughnut",
    data: {
      labels: ["Completed", "Remaining"],
      datasets: [{ data: [doneTotal, pendingTotal], backgroundColor: ["#10b981", "#1e293b"], borderWidth: 0 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#cbd5e1" } } },
    },
  });

  const subjects = Object.keys(subMap);
  const pcts = subjects.map((s) => Math.round((subMap[s].done / subMap[s].total) * 100));

  if (subjectChart) subjectChart.destroy();
  subjectChart = new Chart(document.getElementById("subject-chart"), {
    type: "bar",
    data: {
      labels: subjects,
      datasets: [{ label: "Completion %", data: pcts, backgroundColor: "#38bdf8", borderRadius: 6 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { min: 0, max: 100, ticks: { color: "#94a3b8" }, grid: { color: "rgba(148,163,184,0.12)" } },
        x: { ticks: { color: "#cbd5e1" }, grid: { display: false } },
      },
      plugins: { legend: { display: false } },
    },
  });
}

// -------------------- Focus Timer --------------------
function updateTimerUI() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  document.getElementById("timer-display").textContent = `${m}:${s}`;
  document.getElementById("log-mins-preview").textContent = timerBaseMinutes;
}

function setTimerMinutes(mins) {
  pauseTimer();
  timerBaseMinutes = mins;
  timerSeconds = mins * 60;
  updateTimerUI();
}

function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (timerSeconds <= 0) {
      pauseTimer();
      logCurrentSession();
      alert(`🎉 ${timerBaseMinutes}-minute Focus Session completed and logged!`);
      return;
    }
    timerSeconds--;
    updateTimerUI();
  }, 1000);
}

function pauseTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}

function resetTimer() {
  pauseTimer();
  timerSeconds = timerBaseMinutes * 60;
  updateTimerUI();
}

async function logCurrentSession() {
  if (!session.user_id) return;
  try {
    const res = await fetch(`${API_BASE}/api/focus/log`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: session.user_id, pin: session.pin, minutes: timerBaseMinutes }),
    });
    const data = await res.json();
    if (res.ok) {
      account = data.account;
      renderAll();
      document.getElementById("session-log-msg").textContent = `✅ Logged +${timerBaseMinutes} minutes to your study analytics!`;
    }
  } catch {
    document.getElementById("session-log-msg").textContent = "⚠️ Could not log session — check connection.";
  }
}

// Init
updateTimerUI();
checkApiHealth();
autoRestoreSession();
