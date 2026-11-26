const API_BASE = "https://ai-study-planner-api-6agl.onrender.com"; // <-- Paste your Render URL here (no trailing slash)

let currentPlan = null;
let timerSeconds = 25 * 60;
let timerInterval = null;

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
    badge.textContent = "🔴 Offline / Waking up";
  }
}

async function loadSavedPlan() {
  const userId = document.getElementById("user-id").value.trim();
  if (!userId) return alert("Enter your username first.");
  localStorage.setItem("study_user_id", userId);

  try {
    const res = await fetch(`${API_BASE}/api/plan/${encodeURIComponent(userId)}`);
    const data = await res.json();
    if (!data.found) return alert("No saved plan found for this username yet. Generate one below!");
    currentPlan = data.plan;
    renderPlan();
  } catch {
    alert("Could not reach the server. Wait 20 seconds if Render is waking up, then try again.");
  }
}

async function generatePlan(event) {
  event.preventDefault();
  const userId = document.getElementById("user-id").value.trim();
  if (!userId) return alert("Enter your username in Step 1 first.");
  localStorage.setItem("study_user_id", userId);

  const btn = document.getElementById("gen-btn");
  btn.disabled = true;
  btn.textContent = "⏳ Generating AI Plan...";

  try {
    const res = await fetch(`${API_BASE}/api/generate-plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        subjects: document.getElementById("subjects").value.trim(),
        days: Number(document.getElementById("days").value),
        hours_per_day: Number(document.getElementById("hours").value),
        weak_topics: document.getElementById("weak-topics").value.trim(),
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Generation failed");
    currentPlan = data.plan;
    renderPlan();
  } catch (err) {
    alert(`Error: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "✨ Generate AI Schedule";
  }
}

async function toggleTask(taskId, isDone) {
  const userId = document.getElementById("user-id").value.trim();
  for (const day of currentPlan.days) {
    for (const task of day.tasks) {
      if (task.id === taskId) task.done = isDone;
    }
  }
  renderPlan();

  try {
    await fetch(`${API_BASE}/api/toggle-task`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, task_id: taskId, done: isDone }),
    });
  } catch {
    alert("Sync failed — check your connection.");
  }
}

function renderPlan() {
  if (!currentPlan) return;
  document.getElementById("plan-section").classList.remove("hidden");
  document.getElementById("plan-summary").textContent = currentPlan.summary || "";

  let total = 0;
  let completed = 0;

  const html = (currentPlan.days || [])
    .map((d) => {
      const tasksHtml = (d.tasks || [])
        .map((t) => {
          total += 1;
          if (t.done) completed += 1;
          return `
            <label class="task-row ${t.done ? "done" : ""}">
              <input type="checkbox" ${t.done ? "checked" : ""} onchange="toggleTask('${t.id}', this.checked)" />
              <div>
                <div class="task-meta">${t.subject} • ${t.duration}</div>
                <div class="task-topic">${t.topic}</div>
              </div>
            </label>
          `;
        })
        .join("");

      return `<div class="day-box"><h3>Day ${d.day}: ${d.title}</h3>${tasksHtml}</div>`;
    })
    .join("");

  document.getElementById("days-container").innerHTML = html;
  const pct = total ? Math.round((completed / total) * 100) : 0;
  document.getElementById("progress-text").textContent = `${pct}% (${completed}/${total})`;
  document.getElementById("progress-fill").style.width = `${pct}%`;
}

// Focus Timer
function updateTimerDisplay() {
  const m = String(Math.floor(timerSeconds / 60)).padStart(2, "0");
  const s = String(timerSeconds % 60).padStart(2, "0");
  document.getElementById("timer-display").textContent = `${m}:${s}`;
}
function startTimer() {
  if (timerInterval) return;
  timerInterval = setInterval(() => {
    if (timerSeconds <= 0) {
      pauseTimer();
      alert("🎉 Focus session complete! Take a 5-minute break.");
      return;
    }
    timerSeconds -= 1;
    updateTimerDisplay();
  }, 1000);
}
function pauseTimer() {
  clearInterval(timerInterval);
  timerInterval = null;
}
function resetTimer() {
  pauseTimer();
  timerSeconds = 25 * 60;
  updateTimerDisplay();
}

// Init
const savedUser = localStorage.getItem("study_user_id");
if (savedUser) {
  document.getElementById("user-id").value = savedUser;
  loadSavedPlan();
}
checkApiHealth();
