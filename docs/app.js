
/* LearnPulse OS — Client-side study planner
   No backend required. Groq API key is entered by the user in Settings.
*/

(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const STORE = "learnpulse_os_v8";
  const SESSION = "learnpulse_session_v8";

  const defaultData = () => ({
    accounts: {},
    activeUser: null,
    settings: {
      theme: "light",
      groqKey: "",
      visionModel: "meta-llama/llama-4-scout-17b-16e-instruct"
    },
    blocks: [],
    habits: [],
    focusLogs: [],
    chats: [],
    scans: [],
    goalHours: 6,
    completedDays: []
  });

  let data = loadData();
  let currentDate = new Date();
  let calendarMode = "day";
  let selectedBlock = null;
  let pendingRebalance = null;
  let timerInterval = null;
  let timerRemaining = 0;
  let timerRunning = false;
  let focusStartedAt = null;

  function loadData() {
    try {
      return { ...defaultData(), ...JSON.parse(localStorage.getItem(STORE) || "{}") };
    } catch {
      return defaultData();
    }
  }

  function saveData() {
    localStorage.setItem(STORE, JSON.stringify(data));
  }

  function id() {
    return crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  }

  function escapeHTML(value = "") {
    return String(value).replace(/[&<>"']/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;"
    })[char]);
  }

  function dateKey(date) {
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function addMinutes(date, minutes) {
    return new Date(new Date(date).getTime() + minutes * 60000);
  }

  function formatTime(date) {
    return new Date(date).toLocaleTimeString([], {
      hour: "numeric", minute: "2-digit"
    });
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function notify(message) {
    let toast = $("#lpToast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "lpToast";
      toast.className = "toast";
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toast._timeout);
    toast._timeout = setTimeout(() => toast.classList.remove("show"), 2600);
  }

  function activeAccount() {
    return data.accounts[data.activeUser];
  }

  function saveAccount() {
    if (data.activeUser && activeAccount()) {
      activeAccount().planner = {
        settings: data.settings,
        blocks: data.blocks,
        habits: data.habits,
        focusLogs: data.focusLogs,
        chats: data.chats,
        scans: data.scans,
        goalHours: data.goalHours,
        completedDays: data.completedDays
      };
      saveData();
    }
  }

  function loadAccount(username) {
    data.activeUser = username;
    const planner = data.accounts[username].planner || {};
    data.settings = { ...defaultData().settings, ...(planner.settings || {}) };
    data.blocks = planner.blocks || [];
    data.habits = planner.habits || [];
    data.focusLogs = planner.focusLogs || [];
    data.chats = planner.chats || [];
    data.scans = planner.scans || [];
    data.goalHours = planner.goalHours || 6;
    data.completedDays = planner.completedDays || [];
    saveData();
  }

  async function hashPin(pin) {
    const bytes = new TextEncoder().encode(pin);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)]
      .map(byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function mount() {
    let root = $("#app") || $("#appRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "app";
      document.body.appendChild(root);
    }
    root.innerHTML = `
      <div id="loginScreen" class="login-screen"></div>
      <div id="mainApp" class="app-shell" hidden>
        <aside class="sidebar" id="sidebarNav">
          <div class="brand">✦ LearnPulse</div>
          <div class="user-label" id="userLabel"></div>
          <nav>
            <button data-page="calendar" class="nav-item active">▦ Calendar</button>
            <button data-page="habits" class="nav-item">◇ Habits</button>
            <button data-page="focus" class="nav-item">◷ Focus</button>
            <button data-page="analytics" class="nav-item">▥ Analytics</button>
            <button data-page="scanner" class="nav-item">⌕ Question Scanner</button>
            <button data-page="pulsebot" class="nav-item">✧ PulseBot</button>
            <button data-page="settings" class="nav-item">⚙ Settings</button>
          </nav>
          <button id="logoutBtn" class="logout-button">Log out</button>
        </aside>
        <main class="main-content">
          <header class="topbar">
            <div>
              <div class="eyebrow">YOUR PERSONAL STUDY SPACE</div>
              <h1 id="pageTitle">Calendar</h1>
            </div>
            <button id="themeBtn" class="icon-button" title="Toggle theme">☼</button>
          </header>
          <section id="pageContent"></section>
        </main>
        <nav class="mobile-nav" id="mobileNav">
          <button data-page="calendar">▦<small>Calendar</small></button>
          <button data-page="habits">◇<small>Habits</small></button>
          <button data-page="focus">◷<small>Focus</small></button>
          <button data-page="analytics">▥<small>Stats</small></button>
          <button data-page="pulsebot">✧<small>AI</small></button>
        </nav>
      </div>
      <div id="modalRoot"></div>
    `;

    $("#loginScreen").innerHTML = `
      <div class="login-card">
        <div class="brand">✦ LearnPulse</div>
        <h1>Make every study session count.</h1>
        <p class="muted">Your personal study planner.</p>
        <div class="login-tabs">
          <button id="loginTab" class="active">Log in</button>
          <button id="registerTab">Create account</button>
        </div>
        <form id="authForm">
          <label>Username</label>
          <input id="authUsername" minlength="2" maxlength="24"
            placeholder="Enter username" autocomplete="username" required>
          <label>4-digit PIN</label>
          <input id="authPin" type="password" inputmode="numeric"
            pattern="[0-9]{4}" maxlength="4" placeholder="••••"
            autocomplete="current-password" required>
          <button class="primary-button" type="submit" id="authSubmit">Log in</button>
          <p id="authMessage" class="form-message"></p>
        </form>
      </div>
    `;

    $("#loginTab").addEventListener("click", () => setAuthMode("login"));
    $("#registerTab").addEventListener("click", () => setAuthMode("register"));
    $("#authForm").addEventListener("submit", authenticate);
    $("#logoutBtn").addEventListener("click", logout);
    $("#themeBtn").addEventListener("click", toggleTheme);

    $$("[data-page]").forEach(button => {
      button.addEventListener("click", () => showPage(button.dataset.page));
    });

    const session = sessionStorage.getItem(SESSION);
    if (session && data.accounts[session]) {
      loadAccount(session);
      enterApp();
    } else {
      showLogin();
    }
  }

  let authMode = "login";

  function setAuthMode(mode) {
    authMode = mode;
    $("#loginTab").classList.toggle("active", mode === "login");
    $("#registerTab").classList.toggle("active", mode === "register");
    $("#authSubmit").textContent = mode === "login" ? "Log in" : "Create account";
    $("#authMessage").textContent = "";
  }

  async function authenticate(event) {
    event.preventDefault();
    const username = $("#authUsername").value.trim();
    const pin = $("#authPin").value;

    if (!/^[a-zA-Z0-9_]{2,24}$/.test(username)) {
      return authMessage("Use 2–24 letters, numbers or underscores.");
    }
    if (!/^\d{4}$/.test(pin)) return authMessage("Enter a 4-digit PIN.");

    const pinHash = await hashPin(pin);

    if (authMode === "register") {
      if (data.accounts[username]) return authMessage("Username already exists.");
      data.accounts[username] = { pinHash, planner: {} };
      loadAccount(username);
      sessionStorage.setItem(SESSION, username);
      enterApp();
      notify("Account created.");
    } else {
      const account = data.accounts[username];
      if (!account || account.pinHash !== pinHash) {
        return authMessage("Incorrect username or PIN.");
      }
      loadAccount(username);
      sessionStorage.setItem(SESSION, username);
      enterApp();
    }
  }

  function authMessage(message) {
    $("#authMessage").textContent = message;
  }

  function showLogin() {
    $("#loginScreen").hidden = false;
    $("#mainApp").hidden = true;
  }

  function enterApp() {
    $("#loginScreen").hidden = true;
    $("#mainApp").hidden = false;
    $("#userLabel").textContent = `Signed in as ${data.activeUser}`;
    applyTheme();
    showPage("calendar");
  }

  function logout() {
    saveAccount();
    sessionStorage.removeItem(SESSION);
    data.activeUser = null;
    showLogin();
    notify("Logged out.");
  }

  function applyTheme() {
    document.documentElement.dataset.theme = data.settings.theme;
  }

  function toggleTheme() {
    data.settings.theme = data.settings.theme === "dark" ? "light" : "dark";
    applyTheme();
    saveAccount();
  }

  function showPage(page) {
    const pages = {
      calendar: ["Calendar", renderCalendar],
      habits: ["Habits", renderHabits],
      focus: ["Focus", renderFocus],
      analytics: ["Analytics", renderAnalytics],
      scanner: ["Question Scanner", renderScanner],
      pulsebot: ["PulseBot", renderPulseBot],
      settings: ["Settings", renderSettings]
    };
    if (!pages[page]) return;
    $("#pageTitle").textContent = pages[page][0];
    $$("[data-page]").forEach(button => {
      button.classList.toggle("active", button.dataset.page === page);
    });
    pages[page][1]();
  }

  function renderCalendar() {
    const content = $("#pageContent");
    const today = dateKey(new Date());
    const date = dateKey(currentDate);
    const dayBlocks = data.blocks
      .filter(block => block.date === date)
      .sort((a, b) => a.start.localeCompare(b.start));

    content.innerHTML = `
      <div class="calendar-toolbar">
        <div class="date-controls">
          <button class="secondary-button" id="prevDate">‹</button>
          <button class="secondary-button" id="todayBtn">Today</button>
          <button class="secondary-button" id="nextDate">›</button>
          <strong>${currentDate.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</strong>
        </div>
        <div class="toolbar-actions">
          <select id="calendarMode">
            <option value="day">Day</option>
            <option value="three">3-Day</option>
            <option value="week">Week</option>
          </select>
          <button class="secondary-button" id="blankPlanBtn">Blank plan</button>
          <button class="primary-button" id="aiPlanBtn">✧ AI plan</button>
        </div>
      </div>
      <div class="calendar-summary">
        <div class="stat-card"><span>Scheduled blocks</span><strong>${dayBlocks.length}</strong></div>
        <div class="stat-card"><span>Completed</span><strong>${dayBlocks.filter(b => b.done).length}</strong></div>
        <div class="stat-card"><span>Study time</span><strong>${(dayBlocks.reduce((sum, b) => sum + duration(b), 0) / 60).toFixed(1)}h</strong></div>
      </div>
      <div class="calendar-layout">
        <div class="calendar-grid">
          <div class="calendar-heading"><span>TIME</span><span>YOUR SCHEDULE</span></div>
          <div id="timeline"></div>
        </div>
        <aside class="calendar-side">
          <div class="panel">
            <h3>Quick add</h3>
            <button class="primary-button full-width" id="addBlockBtn">＋ Add study block</button>
            <button class="secondary-button full-width" id="rebalanceBtn">↻ Rebalance day</button>
          </div>
          <div class="panel">
            <h3>Upcoming</h3>
            ${dayBlocks.slice(0, 5).map(block => `
              <div class="upcoming-item">
                <span class="color-dot" style="background:${escapeHTML(block.color || "#777")}"></span>
                <div><strong>${escapeHTML(block.title)}</strong><small>${escapeHTML(block.start)} – ${escapeHTML(block.end)}</small></div>
              </div>`).join("") || `<p class="muted">No blocks planned yet.</p>`}
          </div>
        </aside>
      </div>
      <div id="blockInspector"></div>
    `;

    $("#calendarMode").value = calendarMode;
    $("#calendarMode").addEventListener("change", e => {
      calendarMode = e.target.value;
      renderCalendar();
    });
    $("#prevDate").onclick = () => moveDate(-1);
    $("#nextDate").onclick = () => moveDate(1);
    $("#todayBtn").onclick = () => { currentDate = new Date(); renderCalendar(); };
    $("#addBlockBtn").onclick = () => openBlockModal();
    $("#blankPlanBtn").onclick = () => openBlockModal();
    $("#aiPlanBtn").onclick = createAIPlan;
    $("#rebalanceBtn").onclick = rebalanceDay;

    renderTimeline();
  }

  function moveDate(amount) {
    const step = calendarMode === "week" ? 7 : calendarMode === "three" ? 3 : 1;
    currentDate.setDate(currentDate.getDate() + amount * step);
    renderCalendar();
  }

  function duration(block) {
    const [sh, sm] = block.start.split(":").map(Number);
    const [eh, em] = block.end.split(":").map(Number);
    return Math.max(0, eh * 60 + em - sh * 60 - sm);
  }

  function renderTimeline() {
    const timeline = $("#timeline");
    if (!timeline) return;
    const date = dateKey(currentDate);
    const blocks = data.blocks.filter(block => block.date === date);
    let html = "";
    for (let hour = 6; hour <= 23; hour++) {
      html += `<div class="time-row">
        <div class="time-label">${String(hour % 12 || 12)} ${hour < 12 ? "AM" : "PM"}</div>
        <div class="time-slot" data-hour="${hour}"></div>
      </div>`;
    }
    timeline.innerHTML = html;

    blocks.forEach(block => {
      const [h, m] = block.start.split(":").map(Number);
      const top = ((h - 6) * 60 + m) * (64 / 60);
      const height = Math.max(34, duration(block) * (64 / 60));
      const element = document.createElement("button");
      element.className = `calendar-block${block.done ? " completed" : ""}${block.locked ? " locked" : ""}`;
      element.style.top = `${top}px`;
      element.style.height = `${height}px`;
      element.style.borderLeftColor = block.color || "#777";
      element.innerHTML = `<strong>${escapeHTML(block.title)}</strong>
        <small>${escapeHTML(block.start)} – ${escapeHTML(block.end)}</small>
        ${block.done ? "<span>✓ Done</span>" : ""}`;
      element.onclick = () => openInspector(block.id);
      const slot = $(".time-slot[data-hour='" + h + "']");
      if (slot) slot.appendChild(element);
      else timeline.appendChild(element);
    });

    $$(".time-slot").forEach(slot => {
      slot.addEventListener("dblclick", () => {
        const hour = Number(slot.dataset.hour);
        openBlockModal(null, `${String(hour).padStart(2, "0")}:00`);
      });
    });
  }

  function openBlockModal(block = null, suggestedStart = "09:00") {
    const editing = Boolean(block);
    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal">
          <div class="modal-header">
            <h2>${editing ? "Edit block" : "Add study block"}</h2>
            <button class="icon-button" id="closeModal">✕</button>
          </div>
          <form id="blockForm">
            <label>Title</label>
            <input id="blockTitle" required maxlength="80" value="${escapeHTML(block?.title || "")}" placeholder="e.g. Physics — Kinetic Theory">
            <label>Subject / category</label>
            <input id="blockSubject" value="${escapeHTML(block?.subject || "")}" placeholder="Physics">
            <label>Date</label>
            <input id="blockDate" type="date" required value="${block?.date || dateKey(currentDate)}">
            <div class="form-row">
              <div><label>Start</label><input id="blockStart" type="time" required value="${block?.start || suggestedStart}"></div>
              <div><label>End</label><input id="blockEnd" type="time" required value="${block?.end || "10:00"}"></div>
            </div>
            <label>Colour</label>
            <input id="blockColor" type="color" value="${block?.color || "#7867e8"}">
            <label class="check-label"><input id="blockFixed" type="checkbox" ${block?.fixed ? "checked" : ""}> Fixed-time block</label>
            <label class="check-label"><input id="blockRepeat" type="checkbox"> Repeat every day for 7 days</label>
            <button class="primary-button full-width" type="submit">${editing ? "Save changes" : "Add block"}</button>
          </form>
        </div>
      </div>
    `;
    $("#closeModal").onclick = closeModal;
    $("#modalBackdrop").onclick = e => { if (e.target.id === "modalBackdrop") closeModal(); };
    $("#blockForm").onsubmit = e => {
      e.preventDefault();
      const start = $("#blockStart").value;
      const end = $("#blockEnd").value;
      if (end <= start) return notify("End time must be after start time.");

      const base = {
        title: $("#blockTitle").value.trim(),
        subject: $("#blockSubject").value.trim(),
        date: $("#blockDate").value,
        start, end,
        color: $("#blockColor").value,
        fixed: $("#blockFixed").checked,
        done: block?.done || false,
        locked: block?.locked || false,
        notes: block?.notes || ""
      };

      if (editing) {
        Object.assign(block, base);
      } else {
        const repeat = $("#blockRepeat").checked;
        for (let i = 0; i < (repeat ? 7 : 1); i++) {
          const date = new Date(`${base.date}T12:00:00`);
          date.setDate(date.getDate() + i);
          data.blocks.push({ ...base, id: id(), date: dateKey(date) });
        }
      }
      saveAccount();
      closeModal();
      renderCalendar();
      notify(editing ? "Block updated." : "Block added.");
    };
  }

  function closeModal() {
    $("#modalRoot").innerHTML = "";
  }

  function openInspector(blockId) {
    const block = data.blocks.find(item => item.id === blockId);
    if (!block) return;
    selectedBlock = blockId;
    const inspector = $("#blockInspector");
    inspector.innerHTML = `
      <div class="panel inspector">
        <div class="panel-heading">
          <div><span class="eyebrow">BLOCK DETAILS</span><h3>${escapeHTML(block.title)}</h3></div>
          <button class="icon-button" id="closeInspector">✕</button>
        </div>
        <p>${escapeHTML(block.subject || "Study block")} · ${escapeHTML(block.start)}–${escapeHTML(block.end)}</p>
        <div class="inspector-actions">
          <button class="secondary-button" id="doneBlock">${block.done ? "Mark not done" : "✓ Mark done"}</button>
          <button class="secondary-button" id="lockBlock">${block.locked ? "Unlock" : "Lock"}</button>
          <button class="secondary-button" id="editBlock">Edit</button>
          <button class="secondary-button" id="aiNotes">AI notes</button>
          <button class="secondary-button" id="quizBlock">3-question quiz</button>
          <button class="danger-button" id="deleteBlock">Delete</button>
        </div>
        <label>Notes</label>
        <textarea id="blockNotes" rows="3" placeholder="Add your notes...">${escapeHTML(block.notes || "")}</textarea>
        <button class="secondary-button" id="saveNotes">Save notes</button>
        <div id="blockAIResult"></div>
      </div>
    `;
    $("#closeInspector").onclick = () => inspector.innerHTML = "";
    $("#doneBlock").onclick = () => {
      block.done = !block.done;
      saveAccount();
      renderCalendar();
      openInspector(blockId);
    };
    $("#lockBlock").onclick = () => {
      block.locked = !block.locked;
      saveAccount();
      renderCalendar();
      openInspector(blockId);
    };
    $("#editBlock").onclick = () => openBlockModal(block);
    $("#deleteBlock").onclick = () => {
      if (!confirm("Delete this study block?")) return;
      data.blocks = data.blocks.filter(item => item.id !== blockId);
      saveAccount();
      renderCalendar();
      notify("Block deleted.");
    };
    $("#saveNotes").onclick = () => {
      block.notes = $("#blockNotes").value;
      saveAccount();
      notify("Notes saved.");
    };
    $("#aiNotes").onclick = () => generateBlockAI(block, "notes");
    $("#quizBlock").onclick = () => generateBlockAI(block, "quiz");
  }

  async function groqRequest(messages, options = {}) {
    const key = data.settings.groqKey.trim();
    if (!key) throw new Error("Add your Groq API key in Settings first.");

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`
      },
      body: JSON.stringify({
        model: options.model || "openai/gpt-oss-120b",
        messages,
        temperature: 0.5,
        max_tokens: options.max_tokens || 1200
      })
    });

    const result = await response.json();
    if (!response.ok) {
      throw new Error(result.error?.message || "Groq request failed.");
    }
    return result.choices?.[0]?.message?.content || "No response received.";
  }

  async function generateBlockAI(block, type) {
    const result = $("#blockAIResult");
    result.textContent = "Generating...";
    const prompt = type === "quiz"
      ? `Create exactly 3 multiple-choice questions about ${block.title}. Return numbered questions, four options A-D, and the correct answer with a short explanation.`
      : `Create concise study notes for ${block.title}. Include key concepts, formulas where relevant, and a short revision checklist.`;
    try {
      const answer = await groqRequest([{ role: "user", content: prompt }]);
      result.innerHTML = `<div class="ai-response">${formatText(answer)}</div>`;
    } catch (error) {
      result.textContent = error.message;
    }
  }

  function formatText(text) {
    return escapeHTML(text)
      .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
      .replace(/\n/g, "<br>");
  }

  async function createAIPlan() {
    if (!data.settings.groqKey) {
      openBlockModal();
      notify("Add a Groq key in Settings to generate an AI plan.");
      return;
    }
    const date = dateKey(currentDate);
    const existing = data.blocks.filter(block => block.date === date);
    const prompt = `Create a realistic study schedule for this date: ${date}.
Available study hours: 6 AM to 11 PM.
Existing blocks: ${JSON.stringify(existing.map(b => ({
      title: b.title, start: b.start, end: b.end, fixed: b.fixed
    })))}.
Return ONLY a JSON array. Each object must contain title, subject, start, end.
Use 24-hour HH:MM times. Avoid overlaps. Include short breaks.`;

    notify("Creating your study plan...");
    try {
      const answer = await groqRequest([{ role: "user", content: prompt }]);
      const match = answer.match(/\[[\s\S]*\]/);
      if (!match) throw new Error("AI did not return a valid plan.");
      const plan = JSON.parse(match[0]);
      const newBlocks = plan.map(item => ({
        id: id(),
        title: String(item.title || "Study session"),
        subject: String(item.subject || ""),
        date,
        start: item.start,
        end: item.end,
        color: "#7867e8",
        done: false,
        locked: false,
        fixed: false,
        notes: ""
      })).filter(validBlock);

      if (!newBlocks.length) throw new Error("No valid study blocks returned.");
      pendingRebalance = newBlocks;
      showPlanPreview(newBlocks, "AI study plan");
    } catch (error) {
      notify(error.message);
    }
  }

  function validBlock(block) {
    return /^\d{2}:\d{2}$/.test(block.start) &&
      /^\d{2}:\d{2}$/.test(block.end) &&
      block.end > block.start;
  }

  function showPlanPreview(blocks, title) {
    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" id="modalBackdrop">
        <div class="modal">
          <div class="modal-header"><h2>${escapeHTML(title)}</h2><button id="closeModal" class="icon-button">✕</button></div>
          <p class="muted">Review before applying.</p>
          ${blocks.map(b => `<div class="upcoming-item"><div><strong>${escapeHTML(b.title)}</strong><small>${escapeHTML(b.start)} – ${escapeHTML(b.end)}</small></div></div>`).join("")}
          <div class="form-row">
            <button class="secondary-button" id="discardPlan">Discard</button>
            <button class="primary-button" id="applyPlan">Apply plan</button>
          </div>
        </div>
      </div>
    `;
    $("#closeModal").onclick = closeModal;
    $("#discardPlan").onclick = () => { pendingRebalance = null; closeModal(); };
    $("#applyPlan").onclick = () => {
      if (pendingRebalance) data.blocks.push(...pendingRebalance);
      pendingRebalance = null;
      saveAccount();
      closeModal();
      renderCalendar();
      notify("Plan applied.");
    };
  }

  function rebalanceDay() {
    const date = dateKey(currentDate);
    const blocks = data.blocks.filter(b => b.date === date);
    const fixed = blocks.filter(b => b.done || b.locked || b.fixed);
    const movable = blocks.filter(b => !b.done && !b.locked && !b.fixed)
      .sort((a, b) => a.start.localeCompare(b.start));

    let cursor = 8 * 60;
    const preview = [];
    movable.forEach(block => {
      const length = duration(block);
      let start = cursor;
      let end = start + length;

      while (fixed.some(f => {
        const fs = timeToMinutes(f.start);
        const fe = timeToMinutes(f.end);
        return start < fe && end > fs;
      })) {
        cursor += 15;
        start = cursor;
        end = start + length;
      }

      preview.push({ ...block, start: minutesToTime(start), end: minutesToTime(end) });
      cursor = end + 15;
    });

    if (!preview.length) return notify("No movable blocks to rebalance.");
    pendingRebalance = preview;
    showPlanPreview(preview, "Rebalance preview");
    $("#applyPlan").onclick = () => {
      preview.forEach(updated => {
        const original = data.blocks.find(b => b.id === updated.id);
        if (original) {
          original.start = updated.start;
          original.end = updated.end;
        }
      });
      pendingRebalance = null;
      saveAccount();
      closeModal();
      renderCalendar();
      notify("Schedule rebalanced.");
    };
  }

  function timeToMinutes(time) {
    const [h, m] = time.split(":").map(Number);
    return h * 60 + m;
  }

  function minutesToTime(minutes) {
    return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  }

  function renderHabits() {
    const content = $("#pageContent");
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    content.innerHTML = `
      <div class="page-intro"><h2>Build consistent habits</h2><p class="muted">Create recurring study routines and track your progress.</p></div>
      <button class="primary-button" id="addHabitBtn">＋ Add habit</button>
      <div class="habit-list">
        ${data.habits.map(habit => `
          <div class="panel habit-card">
            <div><h3>${escapeHTML(habit.name)}</h3><p class="muted">${escapeHTML(habit.window || "Any time")}</p>
              <div class="habit-days">${days.map((day, i) => `<span class="${habit.days.includes(i) ? "selected" : ""}">${day}</span>`).join("")}</div>
            </div>
            <button class="danger-button" data-delete-habit="${habit.id}">Delete</button>
          </div>`).join("") || `<div class="empty-state">No habits yet. Add your first habit.</div>`}
      </div>
      <button class="secondary-button" id="scheduleHabits">Schedule next 14 days</button>
    `;
    $("#addHabitBtn").onclick = openHabitModal;
    $("#scheduleHabits").onclick = scheduleHabits;
    $$("[data-delete-habit]").forEach(button => {
      button.onclick = () => {
        data.habits = data.habits.filter(h => h.id !== button.dataset.deleteHabit);
        saveAccount();
        renderHabits();
      };
    });
  }

  function openHabitModal() {
    $("#modalRoot").innerHTML = `
      <div class="modal-backdrop" id="modalBackdrop"><div class="modal">
        <div class="modal-header"><h2>New habit</h2><button id="closeModal" class="icon-button">✕</button></div>
        <form id="habitForm">
          <label>Habit name</label><input id="habitName" required placeholder="e.g. Revise chemistry">
          <label>Preferred time window</label>
          <select id="habitWindow"><option>Morning</option><option>Afternoon</option><option>Evening</option><option>Any time</option></select>
          <label>Repeat on</label>
          <div class="weekday-picker">${["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map((d,i)=>`<label><input type="checkbox" value="${i}" checked> ${d}</label>`).join("")}</div>
          <button class="primary-button full-width">Save habit</button>
        </form>
      </div></div>`;
    $("#closeModal").onclick = closeModal;
    $("#habitForm").onsubmit = e => {
      e.preventDefault();
      const selected = $$("input[type=checkbox]:checked", $("#habitForm")).map(x => Number(x.value));
      if (!selected.length) return notify("Choose at least one day.");
      data.habits.push({
        id: id(),
        name: $("#habitName").value.trim(),
        window: $("#habitWindow").value,
        days: selected
      });
      saveAccount();
      closeModal();
      renderHabits();
    };
  }

  function scheduleHabits() {
    const today = startOfDay(new Date());
    let count = 0;
    for (let offset = 0; offset < 14; offset++) {
      const day = new Date(today);
      day.setDate(today.getDate() + offset);
      const weekday = (day.getDay() + 6) % 7;
      data.habits.filter(h => h.days.includes(weekday)).forEach(habit => {
        const date = dateKey(day);
        if (data.blocks.some(b => b.date === date && b.habitId === habit.id)) return;
        const start = habit.window === "Morning" ? "08:00" :
          habit.window === "Afternoon" ? "14:00" :
          habit.window === "Evening" ? "18:00" : "10:00";
        const end = minutesToTime(timeToMinutes(start) + 30);
        data.blocks.push({
          id: id(), habitId: habit.id, title: habit.name,
          subject: "Habit", date, start, end,
          color: "#20a486", done: false, locked: false, fixed: false, notes: ""
        });
        count++;
      });
    }
    saveAccount();
    notify(`${count} habit sessions scheduled.`);
  }

  function renderFocus() {
    $("#pageContent").innerHTML = `
      <div class="focus-layout">
        <div class="panel focus-panel">
          <span class="eyebrow">FOCUS SESSION</span>
          <h2 id="timerDisplay">25:00</h2>
          <div class="timer-presets">
            <button data-minutes="25" class="active">25 min</button>
            <button data-minutes="50">50 min</button>
            <button data-minutes="90">90 min</button>
          </div>
          <div class="timer-actions">
            <button class="primary-button" id="timerStart">Start</button>
            <button class="secondary-button" id="timerReset">Reset</button>
          </div>
          <p class="muted">Choose a duration and focus on one task.</p>
        </div>
        <div class="panel">
          <h3>Recent focus sessions</h3>
          ${data.focusLogs.slice(-8).reverse().map(log => `<div class="upcoming-item"><div><strong>${escapeHTML(log.label)}</strong><small>${escapeHTML(log.date)} · ${log.minutes} minutes</small></div></div>`).join("") || `<p class="muted">Your completed sessions will appear here.</p>`}
        </div>
      </div>`;
    const saved = JSON.parse(sessionStorage.getItem("lp_timer") || "{}");
    timerRemaining = saved.remaining || 25 * 60;
    timerRunning = false;
    updateTimerDisplay();
    $$("[data-minutes]").forEach(button => {
      button.onclick = () => {
        clearInterval(timerInterval);
        timerRunning = false;
        timerRemaining = Number(button.dataset.minutes) * 60;
        updateTimerDisplay();
        $("#timerStart").textContent = "Start";
        $$("[data-minutes]").forEach(b => b.classList.toggle("active", b === button));
      };
    });
    $("#timerStart").onclick = toggleTimer;
    $("#timerReset").onclick = resetTimer;
  }

  function updateTimerDisplay() {
    const display = $("#timerDisplay");
    if (display) display.textContent =
      `${String(Math.floor(timerRemaining / 60)).padStart(2, "0")}:${String(timerRemaining % 60).padStart(2, "0")}`;
    sessionStorage.setItem("lp_timer", JSON.stringify({ remaining: timerRemaining }));
  }

  function toggleTimer() {
    if (timerRunning) {
      clearInterval(timerInterval);
      timerRunning = false;
      $("#timerStart").textContent = "Resume";
      return;
    }
    timerRunning = true;
    focusStartedAt = Date.now();
    $("#timerStart").textContent = "Pause";
    timerInterval = setInterval(() => {
      timerRemaining--;
      updateTimerDisplay();
      if (timerRemaining <= 0) finishFocus();
    }, 1000);
  }

  function resetTimer() {
    clearInterval(timerInterval);
    timerRunning = false;
    timerRemaining = 25 * 60;
    updateTimerDisplay();
    $("#timerStart").textContent = "Start";
  }

  function finishFocus() {
    clearInterval(timerInterval);
    timerRunning = false;
    const minutes = Math.round((Date.now() - focusStartedAt) / 60000) || 25;
    data.focusLogs.push({
      id: id(), date: dateKey(new Date()), minutes,
      label: "Focus session"
    });
    saveAccount();
    notify("Focus session complete!");
    renderFocus();
  }

  function renderAnalytics() {
    const today = dateKey(new Date());
    const completed = data.blocks.filter(b => b.done);
    const hours = data.focusLogs.reduce((sum, log) => sum + log.minutes / 60, 0);
    const todayDone = data.blocks.filter(b => b.date === today && b.done).length;
    const lastSeven = Array.from({ length: 7 }, (_, i) => {
      const d = new Date();
      d.setDate(d.getDate() - (6 - i));
      const key = dateKey(d);
      return {
        label: d.toLocaleDateString([], { weekday: "short" }),
        hours: data.focusLogs.filter(log => log.date === key)
          .reduce((sum, log) => sum + log.minutes / 60, 0)
      };
    });

    $("#pageContent").innerHTML = `
      <div class="analytics-grid">
        <div class="stat-card"><span>Focus hours</span><strong>${hours.toFixed(1)}</strong></div>
        <div class="stat-card"><span>Tasks completed</span><strong>${completed.length}</strong></div>
        <div class="stat-card"><span>Today's tasks</span><strong>${todayDone}</strong></div>
        <div class="stat-card"><span>Weekly goal</span><strong>${data.goalHours}h/day</strong></div>
      </div>
      <div class="panel">
        <h3>Daily focus goal</h3>
        <label>Target hours per day</label>
        <input id="goalHours" type="number" min="1" max="16" value="${data.goalHours}">
        <button class="secondary-button" id="saveGoal">Save goal</button>
      </div>
      <div class="panel">
        <h3>Focus time — last 7 days</h3>
        <div class="simple-chart">
          ${lastSeven.map(day => `<div class="chart-column"><div class="chart-bar" style="height:${Math.min(150, day.hours * 22)}px"></div><strong>${day.hours.toFixed(1)}h</strong><small>${day.label}</small></div>`).join("")}
        </div>
      </div>
    `;
    $("#saveGoal").onclick = () => {
      data.goalHours = Math.max(1, Math.min(16, Number($("#goalHours").value) || 6));
      saveAccount();
      renderAnalytics();
      notify("Goal updated.");
    };
  }

  function renderScanner() {
    $("#pageContent").innerHTML = `
      <div class="page-intro"><h2>Scan a question</h2><p class="muted">Upload or take a picture of a question and ask AI to explain it.</p></div>
      <div class="panel scanner-panel">
        <label class="upload-area" for="questionImage">
          <span class="upload-icon">⌕</span>
          <strong>Choose an image</strong>
          <small>JPG, PNG or WEBP</small>
        </label>
        <input id="questionImage" type="file" accept="image/*" capture="environment" hidden>
        <img id="scanPreview" class="scan-preview" hidden alt="Question preview">
        <label>What do you want help with?</label>
        <textarea id="scanPrompt" rows="3" placeholder="Explain step by step, solve it, or identify the formula..."></textarea>
        <button class="primary-button" id="scanSubmit">Analyze question</button>
        <div id="scanResult"></div>
      </div>
      <div class="panel"><h3>Recent scans</h3><div id="scanHistory"></div></div>
    `;
    $("#questionImage").onchange = previewImage;
    $("#scanSubmit").onclick = analyzeImage;
    renderScanHistory();
  }

  let scanDataUrl = "";

  function previewImage(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) return notify("Choose an image file.");
    const reader = new FileReader();
    reader.onload = () => {
      scanDataUrl = reader.result;
      $("#scanPreview").src = scanDataUrl;
      $("#scanPreview").hidden = false;
    };
    reader.readAsDataURL(file);
  }

  async function compressImage(dataUrl) {
    const image = new Image();
    image.src = dataUrl;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
    });
    const max = 1400;
    const scale = Math.min(1, max / Math.max(image.width, image.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(image.width * scale);
    canvas.height = Math.round(image.height * scale);
    canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.78);
  }

  async function analyzeImage() {
    if (!scanDataUrl) return notify("Choose an image first.");
    if (!data.settings.groqKey) return notify("Add your Groq key in Settings.");
    const result = $("#scanResult");
    result.textContent = "Analyzing image...";
    try {
      const compressed = await compressImage(scanDataUrl);
      const prompt = $("#scanPrompt").value.trim() ||
        "Read this question and explain the solution step by step.";
      const answer = await groqRequest([{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: compressed } }
        ]
      }], { model: data.settings.visionModel, max_tokens: 1800 });

      data.scans.push({
        id: id(),
        date: new Date().toLocaleString(),
        prompt,
        answer
      });
      saveAccount();
      result.innerHTML = `<div class="ai-response">${formatText(answer)}</div>`;
      renderScanHistory();
    } catch (error) {
      result.textContent = error.message;
    }
  }

  function renderScanHistory() {
    const history = $("#scanHistory");
    if (!history) return;
    history.innerHTML = data.scans.slice(-5).reverse().map(scan => `
      <div class="upcoming-item">
        <div><strong>${escapeHTML(scan.prompt.slice(0, 55))}</strong><small>${escapeHTML(scan.date)}</small></div>
        <button class="secondary-button" data-open-scan="${scan.id}">Open</button>
      </div>`).join("") || `<p class="muted">No scans yet.</p>`;
    $$("[data-open-scan]").forEach(button => {
      button.onclick = () => {
        const scan = data.scans.find(s => s.id === button.dataset.openScan);
        if (scan) $("#scanResult").innerHTML = `<div class="ai-response">${formatText(scan.answer)}</div>`;
      };
    });
  }

  function renderPulseBot() {
    $("#pageContent").innerHTML = `
      <div class="chat-layout">
        <div class="panel chat-panel">
          <div class="chat-heading"><div><h2>✧ PulseBot</h2><p class="muted">Your study planning assistant</p></div></div>
          <div class="quick-prompts">
            <button data-prompt="Help me plan today's study schedule.">Plan my day</button>
            <button data-prompt="Which subjects should I revise based on my schedule?">What should I revise?</button>
            <button data-prompt="Give me a quick study strategy for my weakest topics.">Study strategy</button>
          </div>
          <div id="chatMessages" class="chat-messages"></div>
          <form id="chatForm" class="chat-form">
            <input id="chatInput" placeholder="Ask PulseBot..." autocomplete="off" required>
            <button class="primary-button">Send</button>
          </form>
        </div>
      </div>
    `;
    data.chats.forEach(message => appendChat(message.role, message.content));
    $$("[data-prompt]").forEach(button => {
      button.onclick = () => sendChat(button.dataset.prompt);
    });
    $("#chatForm").onsubmit = e => {
      e.preventDefault();
      const message = $("#chatInput").value.trim();
      if (message) sendChat(message);
    };
  }

  function appendChat(role, content) {
    const messages = $("#chatMessages");
    if (!messages) return;
    const item = document.createElement("div");
    item.className = `chat-message ${role}`;
    item.textContent = content;
    messages.appendChild(item);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendChat(message) {
    $("#chatInput").value = "";
    data.chats.push({ role: "user", content: message });
    appendChat("user", message);

    const schedule = data.blocks
      .filter(b => b.date >= dateKey(new Date()))
      .slice(0, 30)
      .map(b => `${b.date} ${b.start}-${b.end}: ${b.title}${b.done ? " (done)" : ""}`)
      .join("\n");
    const habits = data.habits.map(h => `${h.name}: ${h.window}`).join("\n");
    const recentFocus = data.focusLogs.slice(-10)
      .map(log => `${log.date}: ${log.minutes} minutes`).join("\n");

    const context = `You are PulseBot, a helpful study assistant.
Use the user's local study data when relevant. Do not invent schedule details.
Upcoming schedule:
${schedule || "No scheduled blocks."}
Habits:
${habits || "No habits created."}
Recent focus sessions:
${recentFocus || "No focus sessions yet."}
Answer clearly and practically.`;

    try {
      const messages = [
        { role: "system", content: context },
        ...data.chats.slice(-12),
        { role: "user", content: message }
      ];
      const answer = await groqRequest(messages);
      data.chats.push({ role: "assistant", content: answer });
      appendChat("assistant", answer);
      saveAccount();
    } catch (error) {
      appendChat("assistant", error.message);
    }
  }

  function renderSettings() {
    $("#pageContent").innerHTML = `
      <div class="settings-layout">
        <div class="panel">
          <h2>AI settings</h2>
          <label>Groq API key</label>
          <input id="groqKey" type="password" autocomplete="off" placeholder="Enter your Groq API key" value="${escapeHTML(data.settings.groqKey)}">
          <small class="muted">Stored only in this browser on this device. Do not share your key.</small>
          <label>Vision model</label>
          <input id="visionModel" value="${escapeHTML(data.settings.visionModel)}">
          <button class="primary-button" id="saveAISettings">Save AI settings</button>
        </div>
        <div class="panel">
          <h2>Backup and restore</h2>
          <p class="muted">Export your planner data or restore it from a backup file.</p>
          <button class="secondary-button" id="exportBackup">Export backup JSON</button>
          <label class="secondary-button file-button" for="importBackup">Import backup JSON</label>
          <input id="importBackup" type="file" accept="application/json" hidden>
        </div>
        <div class="panel">
          <h2>Calendar exports</h2>
          <button class="secondary-button" id="exportICS">Export calendar (.ics)</button>
          <button class="secondary-button" id="printCalendar">Print planner</button>
        </div>
        <div class="panel">
          <h2>Account</h2>
          <p>Username: <strong>${escapeHTML(data.activeUser || "")}</strong></p>
          <button class="danger-button" id="settingsLogout">Log out</button>
        </div>
      </div>
    `;
    $("#saveAISettings").onclick = () => {
      data.settings.groqKey = $("#groqKey").value.trim();
      data.settings.visionModel = $("#visionModel").value.trim() ||
        "meta-llama/llama-4-scout-17b-16e-instruct";
      saveAccount();
      notify("AI settings saved.");
    };
    $("#exportBackup").onclick = exportBackup;
    $("#importBackup").onchange = importBackup;
    $("#exportICS").onclick = exportICS;
    $("#printCalendar").onclick = () => window.print();
    $("#settingsLogout").onclick = logout;
  }

  function downloadFile(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  function exportBackup() {
    saveAccount();
    const backup = {
      version: 1,
      exportedAt: new Date().toISOString(),
      username: data.activeUser,
      planner: activeAccount().planner
    };
    downloadFile("learnpulse-backup.json", JSON.stringify(backup, null, 2), "application/json");
  }

  function importBackup(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const backup = JSON.parse(reader.result);
        const planner = backup.planner || backup;
        if (!planner || typeof planner !== "object") throw new Error("Invalid backup file.");
        data.settings = { ...defaultData().settings, ...(planner.settings || {}) };
        data.blocks = Array.isArray(planner.blocks) ? planner.blocks : [];
        data.habits = Array.isArray(planner.habits) ? planner.habits : [];
        data.focusLogs = Array.isArray(planner.focusLogs) ? planner.focusLogs : [];
        data.chats = Array.isArray(planner.chats) ? planner.chats : [];
        data.scans = Array.isArray(planner.scans) ? planner.scans : [];
        data.goalHours = planner.goalHours || 6;
        data.completedDays = planner.completedDays || [];
        saveAccount();
        notify("Backup restored.");
        renderSettings();
      } catch (error) {
        notify(error.message || "Could not import backup.");
      }
    };
    reader.readAsText(file);
  }

  function exportICS() {
    const events = data.blocks.map(block => {
      const start = `${block.date.replace(/-/g, "")}T${block.start.replace(":", "")}00`;
      const end = `${block.date.replace(/-/g, "")}T${block.end.replace(":", "")}00`;
      return [
        "BEGIN:VEVENT",
        `UID:${block.id}@learnpulse`,
        `DTSTART:${start}`,
        `DTEND:${end}`,
        `SUMMARY:${String(block.title).replace(/[,;\\]/g, " ")}`,
        `DESCRIPTION:${String(block.subject || "").replace(/[,;\\]/g, " ")}`,
        "END:VEVENT"
      ].join("\r\n");
    });
    const calendar = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//LearnPulse//Study Planner//EN",
      ...events,
      "END:VCALENDAR"
    ].join("\r\n");
    downloadFile("learnpulse-calendar.ics", calendar, "text/calendar");
  }

  document.addEventListener("DOMContentLoaded", mount);
})();
