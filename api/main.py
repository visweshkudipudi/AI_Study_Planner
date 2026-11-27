import hashlib
import json
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel
from pymongo import MongoClient

app = FastAPI(title="LearnPulse OS v3 API — Viswesh & Team, Dept of CSE")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MONGO_URI = os.getenv("MONGO_URI", "")
DB_NAME = os.getenv("MONGO_DB_NAME", "ai_study_planner")
COLLECTION_NAME = os.getenv("WEB_COLLECTION_NAME", "learnpulse_os_accounts")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

mongo_client = MongoClient(MONGO_URI) if MONGO_URI else None
accounts_col = mongo_client[DB_NAME][COLLECTION_NAME] if mongo_client else None
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None

DEFAULT_SETTINGS = {
    "study_start": "07:00",
    "study_end": "22:30",
    "focus_goal_hours": 14,
    "defense_mode": "proactive",
    "auto_buffers": True,
    "buffer_minutes": 15,
}


# -------------------- Helpers --------------------
def hash_pin(user_id: str, pin: str) -> str:
    raw = f"learnpulse::{user_id.strip().lower()}::{pin.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_minutes(duration_str: str) -> int:
    text = str(duration_str or "").lower()
    hours = re.search(r"(\d+(?:\.\d+)?)\s*(?:hr|hour|h)\b", text)
    mins = re.search(r"(\d+)\s*(?:min|m)\b", text)
    total = 0
    if hours:
        total += int(float(hours.group(1)) * 60)
    if mins:
        total += int(mins.group(1))
    return total if total > 0 else 45


def time_to_minutes(t_str: str, fallback: int = 540) -> int:
    m = re.match(r"^(\d{1,2}):(\d{2})$", str(t_str or "").strip())
    if not m:
        return fallback
    hh, mm = int(m.group(1)), int(m.group(2))
    return max(360, min(1350, hh * 60 + mm))


def minutes_to_time(total_mins: int) -> str:
    clamped = max(360, min(1350, int(total_mins)))
    return f"{clamped // 60:02d}:{clamped % 60:02d}"


def update_streak(doc: dict) -> tuple[int, str]:
    today = date.today()
    today_str = today.isoformat()
    last_str = doc.get("last_active_date", "")
    streak = int(doc.get("streak", 0))
    if last_str == today_str:
        return max(streak, 1), today_str
    yesterday_str = (today - timedelta(days=1)).isoformat()
    if last_str == yesterday_str:
        return streak + 1, today_str
    return 1, today_str


def normalize_plan_tasks(plan: dict, settings: dict) -> dict:
    start_floor = time_to_minutes(settings.get("study_start", "07:00"), 420)
    buf = int(settings.get("buffer_minutes", 15)) if settings.get("auto_buffers", True) else 0

    for d_idx, day in enumerate(plan.get("days", [])):
        if "day" not in day:
            day["day"] = d_idx + 1
        cursor = start_floor + 60  # Default 8:00 AM if legacy tasks lack times
        for t_idx, task in enumerate(day.get("tasks", [])):
            if not task.get("id"):
                task["id"] = f"d{day['day']}-t{t_idx + 1}-{uuid.uuid4().hex[:4]}"
            dur_min = int(task.get("duration_min") or parse_minutes(task.get("duration", "45 min")))
            dur_min = max(15, min(240, dur_min))
            task["duration_min"] = dur_min
            task["duration"] = f"{dur_min} min"

            if not re.match(r"^\d{2}:\d{2}$", str(task.get("start_time", ""))):
                task["start_time"] = minutes_to_time(cursor)
                cursor += dur_min + buf
            else:
                cursor = max(cursor, time_to_minutes(task["start_time"]) + dur_min + buf)

            if task.get("priority") not in ("P1", "P2", "P3", "P4"):
                task["priority"] = "P1" if t_idx == 0 else "P2"
            if task.get("block_type") not in ("task", "focus", "habit", "fixed"):
                task["block_type"] = "task"
            if task.get("defense") not in ("busy", "free"):
                task["defense"] = "busy" if task["priority"] in ("P1", "P2") else "free"
            task["locked"] = bool(task.get("locked", False))
            task["done"] = bool(task.get("done", False))
    return plan


def sanitize_account(doc: dict) -> dict:
    settings = {**DEFAULT_SETTINGS, **(doc.get("settings") or {})}
    plans = [normalize_plan_tasks(p, settings) for p in doc.get("plans", [])]
    return {
        "user_id": doc["user_id"],
        "streak": doc.get("streak", 0),
        "last_active_date": doc.get("last_active_date", ""),
        "logged_minutes": doc.get("logged_minutes", 0),
        "settings": settings,
        "habits": doc.get("habits", []),
        "plans": plans,
        "chat_history": doc.get("chat_history", [])[-30:],
    }


def require_verified_user(user_id: str, pin: str) -> dict:
    if accounts_col is None:
        raise HTTPException(status_code=500, detail="MONGO_URI not configured on Render")
    clean_user = user_id.strip().lower()
    doc = accounts_col.find_one({"user_id": clean_user})
    if not doc:
        raise HTTPException(status_code=404, detail="Account not found. Please sign in first.")
    if doc.get("pin_hash") != hash_pin(clean_user, pin):
        raise HTTPException(status_code=401, detail="Invalid PIN.")
    return doc


def call_groq_json(system_prompt: str, user_prompt: str) -> dict:
    if groq_client is None:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not configured on Render")
    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.35,
            response_format={"type": "json_object"},
        )
        raw_text = completion.choices[0].message.content or "{}"
        match = re.search(r"\{.*\}", raw_text, re.S)
        return json.loads(match.group(0) if match else raw_text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI request failed: {str(e)}")


def build_student_context(doc: dict, active_plan_id: str) -> str:
    settings = {**DEFAULT_SETTINGS, **(doc.get("settings") or {})}
    plans = doc.get("plans", [])
    plan = next((p for p in plans if p.get("plan_id") == active_plan_id), None) or (plans[0] if plans else None)
    habits = [h for h in doc.get("habits", []) if h.get("active", True)]
    streak = doc.get("streak", 0)
    hours = round(int(doc.get("logged_minutes", 0)) / 60, 1)

    lines = [
        f"Student: {doc['user_id']} | Streak: {streak}d | Logged: {hours}h / Weekly Focus Goal: {settings['focus_goal_hours']}h ({settings['defense_mode']} defense)",
        f"Study Hours: {settings['study_start']} - {settings['study_end']} | Auto-Buffers: {settings['auto_buffers']}",
    ]
    if habits:
        lines.append("Active Habits: " + ", ".join(f"{h['title']} ({h['duration_min']}m around {h['ideal_time']})" for h in habits))

    if not plan:
        lines.append("Active Plan: None yet.")
        return "\n".join(lines)

    pending = []
    done_count = 0
    total = 0
    for day in plan.get("days", []):
        for t in day.get("tasks", []):
            total += 1
            if t.get("done"):
                done_count += 1
            elif len(pending) < 14:
                lock_tag = " [LOCKED]" if t.get("locked") else ""
                pending.append(
                    f"Day {day.get('day')} @ {t.get('start_time', '09:00')} ({t.get('duration_min', 45)}m, {t.get('priority', 'P2')}{lock_tag}): [{t.get('subject')}] {t.get('topic')}"
                )
    lines.append(f"Active Plan: {plan.get('plan_name')} ({done_count}/{total} done) | Weak Topics: {plan.get('weak_topics') or 'None'}")
    lines.append("Upcoming Scheduled Blocks:\n" + ("\n".join("- " + p for p in pending) if pending else "- All complete!"))
    return "\n".join(lines)


# -------------------- Request Models --------------------
class AuthRequest(BaseModel):
    user_id: str
    pin: str


class GeneratePlanRequest(BaseModel):
    user_id: str
    pin: str
    plan_name: str
    subjects: str
    days: int = 7
    hours_per_day: float = 3.5
    weak_topics: str = ""
    start_date: str = ""


class RebalancePreviewRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str
    remaining_days: int = 5
    hours_per_day: float = 3.5


class ApplyPreviewRequest(BaseModel):
    user_id: str
    pin: str
    plan: dict


class DeletePlanRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str


class AddTaskRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str
    day: int
    subject: str
    topic: str
    start_time: str = "09:00"
    duration_min: int = 60
    priority: str = "P2"
    block_type: str = "task"
    defense: str = "busy"
    locked: bool = False


class UpdateTaskRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str
    task_id: str
    done: bool | None = None
    locked: bool | None = None
    defense: str | None = None
    priority: str | None = None
    start_time: str | None = None
    duration_min: int | None = None
    block_type: str | None = None
    delete: bool = False


class HabitSaveRequest(BaseModel):
    user_id: str
    pin: str
    id: str = ""
    title: str
    subject: str = "General"
    duration_min: int = 45
    window_start: str = "17:00"
    window_end: str = "21:00"
    ideal_time: str = "18:00"
    defense: str = "busy"
    active: bool = True


class HabitDeleteRequest(BaseModel):
    user_id: str
    pin: str
    habit_id: str


class SettingsUpdateRequest(BaseModel):
    user_id: str
    pin: str
    study_start: str = "07:00"
    study_end: str = "22:30"
    focus_goal_hours: int = 14
    defense_mode: str = "proactive"
    auto_buffers: bool = True
    buffer_minutes: int = 15


class FocusLogRequest(BaseModel):
    user_id: str
    pin: str
    minutes: int


class TopicRequest(BaseModel):
    subject: str
    topic: str


class ChatSendRequest(BaseModel):
    user_id: str
    pin: str
    message: str
    active_plan_id: str = ""


class ChatClearRequest(BaseModel):
    user_id: str
    pin: str


# -------------------- Endpoints --------------------
@app.get("/health")
def health():
    return {"status": "ok", "app": "LearnPulse OS v3", "model": GROQ_MODEL}


@app.post("/api/auth")
def auth_user(req: AuthRequest):
    if accounts_col is None:
        raise HTTPException(status_code=500, detail="MONGO_URI not configured on Render")
    clean_user = req.user_id.strip().lower()
    clean_pin = req.pin.strip()
    if len(clean_user) < 2:
        raise HTTPException(status_code=400, detail="Username must be at least 2 characters.")
    if len(clean_pin) < 4:
        raise HTTPException(status_code=400, detail="PIN must be at least 4 characters.")

    pin_hash = hash_pin(clean_user, clean_pin)
    doc = accounts_col.find_one({"user_id": clean_user})
    if doc:
        if doc.get("pin_hash") != pin_hash:
            raise HTTPException(status_code=401, detail="Wrong PIN for this username.")
        return {"ok": True, "created": False, "account": sanitize_account(doc)}

    new_doc = {
        "user_id": clean_user,
        "pin_hash": pin_hash,
        "streak": 0,
        "last_active_date": "",
        "logged_minutes": 0,
        "settings": dict(DEFAULT_SETTINGS),
        "habits": [
            {
                "id": f"hab-{uuid.uuid4().hex[:6]}",
                "title": "Daily Active Recall & Notes Review",
                "subject": "Revision",
                "duration_min": 30,
                "window_start": "20:00",
                "window_end": "22:00",
                "ideal_time": "20:30",
                "defense": "free",
                "active": True,
            }
        ],
        "plans": [],
        "chat_history": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    accounts_col.insert_one(new_doc)
    return {"ok": True, "created": True, "account": sanitize_account(new_doc)}


@app.post("/api/plans/generate")
def generate_plan(req: GeneratePlanRequest):
    doc = require_verified_user(req.user_id, req.pin)
    settings = {**DEFAULT_SETTINGS, **(doc.get("settings") or {})}
    active_habits = [h for h in doc.get("habits", []) if h.get("active", True)]
    start_dt = req.start_date.strip() or date.today().isoformat()
    plan_name = req.plan_name.strip() or "Smart Study Plan"

    habits_text = (
        "\n".join(
            f"- Habit '{h['title']}' ({h['subject']}, {h['duration_min']} min, window {h['window_start']}-{h['window_end']}, ideal {h['ideal_time']})"
            for h in active_habits
        )
        if active_habits
        else "None"
    )

    prompt = f"""Build a Reclaim.ai-style time-blocked {req.days}-day study schedule for a B.Tech engineering student.
Plan Name: {plan_name}
Subjects: {req.subjects}
Target Study Hours/Day: {req.hours_per_day} hours
Allowed Daily Window: {settings['study_start']} to {settings['study_end']} (24-hour HH:MM)
Weak Topics (assign P1 priority & Deep Focus blocks early in the day): {req.weak_topics or "None"}
Recurring Flexible Habits to weave in:
{habits_text}

Rules:
1. Give every block a realistic non-overlapping 24-hour "start_time" (e.g. "08:00", "17:30") leaving at least 15 minutes between consecutive blocks.
2. Mix "block_type" appropriately: "focus" for deep weak-topic mastery, "task" for syllabus topics/problem-solving, and "habit" for included habits.
3. Assign "priority": "P1" (Critical/Weak), "P2" (High), "P3" (Medium), or "P4" (Low).
4. Set "defense": "busy" for P1/P2 blocks and "free" for flexible P3/P4 blocks.

Return ONLY valid JSON:
{{
  "summary": "2-sentence smart scheduling strategy",
  "days": [
    {{
      "day": 1,
      "title": "Focused theme for Day 1",
      "tasks": [
        {{
          "subject": "Subject Name",
          "topic": "Specific concrete study session",
          "start_time": "08:00",
          "duration_min": 60,
          "priority": "P1",
          "block_type": "focus",
          "defense": "busy"
        }}
      ]
    }}
  ]
}}"""

    plan_json = call_groq_json(
        "You are LearnPulse OS AI Scheduler (Reclaim-grade time-blocking engine). Output valid JSON only.",
        prompt,
    )

    days_list = plan_json.get("days", [])
    for d_idx, day in enumerate(days_list, start=1):
        day["day"] = d_idx
        for t_idx, t in enumerate(day.get("tasks", []), start=1):
            t["id"] = f"d{d_idx}-t{t_idx}-{uuid.uuid4().hex[:4]}"
            t["locked"] = False
            t["done"] = False

    new_plan = normalize_plan_tasks(
        {
            "plan_id": uuid.uuid4().hex[:10],
            "plan_name": plan_name,
            "subjects": req.subjects,
            "days_count": req.days,
            "hours_per_day": req.hours_per_day,
            "weak_topics": req.weak_topics,
            "start_date": start_dt,
            "summary": plan_json.get("summary", "High-priority topics are defended early with automatic focus buffers."),
            "days": days_list,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        settings,
    )

    plans = [new_plan] + doc.get("plans", [])
    doc["plans"] = plans
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "plan": new_plan, "account": sanitize_account(doc)}


@app.post("/api/plans/rebalance-preview")
def rebalance_preview(req: RebalancePreviewRequest):
    doc = require_verified_user(req.user_id, req.pin)
    settings = {**DEFAULT_SETTINGS, **(doc.get("settings") or {})}
    plans = doc.get("plans", [])
    target = next((p for p in plans if p["plan_id"] == req.plan_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Plan not found.")

    locked_by_day = {}
    completed_tasks = []
    flexible_pending = []

    for day in target.get("days", []):
        d_num = int(day.get("day", 1))
        for t in day.get("tasks", []):
            if t.get("done"):
                completed_tasks.append(t)
            elif t.get("locked") or t.get("block_type") == "fixed":
                locked_by_day.setdefault(d_num, []).append(t)
            else:
                flexible_pending.append(t)

    if not flexible_pending:
        raise HTTPException(status_code=400, detail="No unlocked pending tasks left to rebalance!")

    locked_desc = []
    for d_num, items in sorted(locked_by_day.items()):
        for it in items:
            locked_desc.append(f"Day {d_num} LOCKED {it.get('start_time')} ({it.get('duration_min')}m): {it.get('subject')} - {it.get('topic')}")

    pending_desc = [
        f"- [{t.get('priority', 'P2')} | {t.get('block_type', 'task')} | {t.get('duration_min', 45)}m] {t.get('subject')}: {t.get('topic')}"
        for t in flexible_pending
    ]

    prompt = f"""Rebalance these UNLOCKED pending study tasks across {req.remaining_days} days ({req.hours_per_day} hrs/day) inside {settings['study_start']} to {settings['study_end']}.
CRITICAL: Do NOT schedule anything overlapping these LOCKED immovable blocks:
{chr(10).join(locked_desc) if locked_desc else "None"}

Unlocked Pending Tasks to Reschedule (schedule P1 before P2/P3/P4):
{chr(10).join(pending_desc)}

Return ONLY valid JSON:
{{
  "summary": "2-sentence recovery & time-defense summary",
  "days": [
    {{
      "day": 1,
      "title": "Rebalanced Day 1 focus",
      "tasks": [
        {{
          "subject": "Subject",
          "topic": "Topic",
          "start_time": "08:30",
          "duration_min": 60,
          "priority": "P1",
          "block_type": "focus",
          "defense": "busy"
        }}
      ]
    }}
  ]
}}"""

    plan_json = call_groq_json(
        "You are LearnPulse OS Adaptive Rebalancer. Avoid all locked block times. Output valid JSON only.",
        prompt,
    )

    rebuilt_days = []
    if completed_tasks:
        rebuilt_days.append({"day": 0, "title": "Completed Earlier (Preserved)", "tasks": completed_tasks})

    ai_days = plan_json.get("days", [])
    for d_idx in range(1, req.remaining_days + 1):
        ai_day = next((d for d in ai_days if int(d.get("day", 0)) == d_idx), None)
        day_tasks = []
        # Re-attach immovable locked blocks for this day
        for lt in locked_by_day.get(d_idx, []):
            day_tasks.append(lt)
        # Attach AI-rebalanced flexible blocks
        if ai_day:
            for t_idx, t in enumerate(ai_day.get("tasks", []), start=1):
                t["id"] = f"rb{d_idx}-t{t_idx}-{uuid.uuid4().hex[:4]}"
                t["locked"] = False
                t["done"] = False
                day_tasks.append(t)
        day_tasks.sort(key=lambda x: time_to_minutes(x.get("start_time", "09:00")))
        rebuilt_days.append(
            {
                "day": d_idx,
                "title": (ai_day.get("title") if ai_day else f"Balanced Study Day {d_idx}"),
                "tasks": day_tasks,
            }
        )

    proposed = normalize_plan_tasks(
        {
            **target,
            "days_count": req.remaining_days,
            "hours_per_day": req.hours_per_day,
            "start_date": date.today().isoformat(),
            "summary": plan_json.get("summary", "Schedule rebalanced around locked events."),
            "days": rebuilt_days,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        },
        settings,
    )
    return {"ok": True, "preview_plan": proposed}


@app.post("/api/plans/apply-preview")
def apply_preview(req: ApplyPreviewRequest):
    doc = require_verified_user(req.user_id, req.pin)
    settings = {**DEFAULT_SETTINGS, **(doc.get("settings") or {})}
    incoming = normalize_plan_tasks(req.plan, settings)
    plans = doc.get("plans", [])
    replaced = False
    for idx, p in enumerate(plans):
        if p.get("plan_id") == incoming.get("plan_id"):
            plans[idx] = incoming
            replaced = True
            break
    if not replaced:
        plans.insert(0, incoming)

    doc["plans"] = plans
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/plans/delete")
def delete_plan(req: DeletePlanRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = [p for p in doc.get("plans", []) if p["plan_id"] != req.plan_id]
    doc["plans"] = plans
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/tasks/add")
def add_task(req: AddTaskRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = doc.get("plans", [])
    target = next((p for p in plans if p["plan_id"] == req.plan_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Plan not found.")

    day_obj = next((d for d in target.get("days", []) if int(d.get("day", -1)) == req.day), None)
    if not day_obj:
        day_obj = {"day": req.day, "title": f"Day {req.day} Schedule", "tasks": []}
        target.setdefault("days", []).append(day_obj)

    dur = max(15, min(300, int(req.duration_min)))
    new_task = {
        "id": f"m-d{req.day}-{uuid.uuid4().hex[:6]}",
        "subject": req.subject.strip() or "Study",
        "topic": req.topic.strip(),
        "start_time": minutes_to_time(time_to_minutes(req.start_time)),
        "duration_min": dur,
        "duration": f"{dur} min",
        "priority": req.priority if req.priority in ("P1", "P2", "P3", "P4") else "P2",
        "block_type": req.block_type if req.block_type in ("task", "focus", "habit", "fixed") else "task",
        "defense": "busy" if req.locked or req.block_type == "fixed" else req.defense,
        "locked": bool(req.locked or req.block_type == "fixed"),
        "done": False,
    }
    day_obj.setdefault("tasks", []).append(new_task)
    day_obj["tasks"].sort(key=lambda x: time_to_minutes(x.get("start_time", "09:00")))
    target["updated_at"] = datetime.now(timezone.utc).isoformat()

    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/tasks/update")
def update_task(req: UpdateTaskRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = doc.get("plans", [])
    target = next((p for p in plans if p["plan_id"] == req.plan_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Plan not found.")

    found_day = None
    found_task = None
    for d in target.get("days", []):
        for t in d.get("tasks", []):
            if t.get("id") == req.task_id:
                found_day = d
                found_task = t
                break

    if not found_task:
        raise HTTPException(status_code=404, detail="Block not found.")

    if req.delete:
        found_day["tasks"] = [t for t in found_day["tasks"] if t.get("id") != req.task_id]
    else:
        prev_done = bool(found_task.get("done", False))
        if req.done is not None:
            found_task["done"] = req.done
            mins = int(found_task.get("duration_min") or parse_minutes(found_task.get("duration", "45 min")))
            logged = int(doc.get("logged_minutes", 0))
            if req.done and not prev_done:
                logged += mins
                streak, last_active = update_streak(doc)
                doc["streak"] = streak
                doc["last_active_date"] = last_active
            elif not req.done and prev_done:
                logged = max(0, logged - mins)
            doc["logged_minutes"] = logged

        if req.locked is not None:
            found_task["locked"] = req.locked
            if req.locked:
                found_task["defense"] = "busy"
        if req.defense in ("busy", "free"):
            found_task["defense"] = req.defense
        if req.priority in ("P1", "P2", "P3", "P4"):
            found_task["priority"] = req.priority
        if req.block_type in ("task", "focus", "habit", "fixed"):
            found_task["block_type"] = req.block_type
        if req.start_time:
            found_task["start_time"] = minutes_to_time(time_to_minutes(req.start_time))
        if req.duration_min:
            dur = max(15, min(300, int(req.duration_min)))
            found_task["duration_min"] = dur
            found_task["duration"] = f"{dur} min"
        found_day["tasks"].sort(key=lambda x: time_to_minutes(x.get("start_time", "09:00")))

    target["updated_at"] = datetime.now(timezone.utc).isoformat()
    accounts_col.update_one(
        {"user_id": doc["user_id"]},
        {
            "$set": {
                "plans": plans,
                "logged_minutes": doc.get("logged_minutes", 0),
                "streak": doc.get("streak", 0),
                "last_active_date": doc.get("last_active_date", ""),
            }
        },
    )
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/habits/save")
def save_habit(req: HabitSaveRequest):
    doc = require_verified_user(req.user_id, req.pin)
    habits = doc.get("habits", [])
    hid = req.id.strip() or f"hab-{uuid.uuid4().hex[:6]}"
    entry = {
        "id": hid,
        "title": req.title.strip(),
        "subject": req.subject.strip() or "General",
        "duration_min": max(15, min(180, int(req.duration_min))),
        "window_start": minutes_to_time(time_to_minutes(req.window_start, 1020)),
        "window_end": minutes_to_time(time_to_minutes(req.window_end, 1260)),
        "ideal_time": minutes_to_time(time_to_minutes(req.ideal_time, 1080)),
        "defense": req.defense if req.defense in ("busy", "free") else "busy",
        "active": bool(req.active),
    }

    updated = False
    for i, h in enumerate(habits):
        if h.get("id") == hid:
            habits[i] = entry
            updated = True
            break
    if not updated:
        habits.append(entry)

    doc["habits"] = habits
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"habits": habits}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/habits/delete")
def delete_habit(req: HabitDeleteRequest):
    doc = require_verified_user(req.user_id, req.pin)
    habits = [h for h in doc.get("habits", []) if h.get("id") != req.habit_id]
    doc["habits"] = habits
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"habits": habits}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/settings/update")
def update_settings(req: SettingsUpdateRequest):
    doc = require_verified_user(req.user_id, req.pin)
    new_settings = {
        "study_start": minutes_to_time(time_to_minutes(req.study_start, 420)),
        "study_end": minutes_to_time(time_to_minutes(req.study_end, 1350)),
        "focus_goal_hours": max(1, min(60, int(req.focus_goal_hours))),
        "defense_mode": req.defense_mode if req.defense_mode in ("proactive", "reactive") else "proactive",
        "auto_buffers": bool(req.auto_buffers),
        "buffer_minutes": max(5, min(30, int(req.buffer_minutes))),
    }
    doc["settings"] = new_settings
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"settings": new_settings}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/focus/log")
def log_focus(req: FocusLogRequest):
    doc = require_verified_user(req.user_id, req.pin)
    add_mins = max(1, min(req.minutes, 240))
    doc["logged_minutes"] = int(doc.get("logged_minutes", 0)) + add_mins
    streak, last_active = update_streak(doc)
    doc["streak"] = streak
    doc["last_active_date"] = last_active
    accounts_col.update_one(
        {"user_id": doc["user_id"]},
        {"$set": {"logged_minutes": doc["logged_minutes"], "streak": streak, "last_active_date": last_active}},
    )
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/ai/topic-help")
def topic_help(req: TopicRequest):
    prompt = f"""Explain this B.Tech engineering topic clearly for quick exam revision.
Subject: {req.subject}
Topic: {req.topic}

Return ONLY valid JSON:
{{
  "overview": "Clear 2-3 sentence intuitive explanation",
  "key_points": ["Key point 1", "Key point 2", "Key point 3", "Key point 4"],
  "formulas_or_code": ["Important formula, law, or short code syntax 1", "Important formula or syntax 2"],
  "exam_tip": "One high-scoring exam tip or common mistake to avoid"
}}"""
    data = call_groq_json(
        "You are an engineering professor helping a B.Tech student revise quickly. Output valid JSON only.",
        prompt,
    )
    return {"ok": True, "data": data}


@app.post("/api/ai/topic-quiz")
def topic_quiz(req: TopicRequest):
    prompt = f"""Create 3 conceptual multiple-choice practice questions for an engineering student.
Subject: {req.subject}
Topic: {req.topic}

Return ONLY valid JSON:
{{
  "questions": [
    {{
      "question": "Clear question text",
      "options": ["Option A", "Option B", "Option C", "Option D"],
      "answer_index": 0,
      "explanation": "1-sentence explanation of why this option is correct"
    }}
  ]
}}"""
    data = call_groq_json("You are an engineering exam quiz generator. Output valid JSON only.", prompt)
    return {"ok": True, "questions": data.get("questions", [])}


@app.post("/api/chat/send")
def chat_send(req: ChatSendRequest):
    doc = require_verified_user(req.user_id, req.pin)
    if groq_client is None:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not configured on Render")
    user_msg = req.message.strip()
    if not user_msg:
        raise HTTPException(status_code=400, detail="Message cannot be empty.")

    student_ctx = build_student_context(doc, req.active_plan_id)
    history = doc.get("chat_history", [])
    system_prompt = (
        "You are PulseBot, the exclusive AI Scheduling & Study Mentor inside LearnPulse OS "
        "(developed by Viswesh & Team, Dept of CSE). "
        "You understand time-blocking, P1-P4 priorities, locked blocks, focus time defense, and B.Tech subjects. "
        "Give sharp, actionable, well-structured answers.\n\n"
        f"LIVE STUDENT CONTEXT:\n{student_ctx}"
    )

    messages = [{"role": "system", "content": system_prompt}]
    for item in history[-10:]:
        if item.get("role") in ("user", "assistant") and item.get("content"):
            messages.append({"role": item["role"], "content": item["content"]})
    messages.append({"role": "user", "content": user_msg})

    try:
        completion = groq_client.chat.completions.create(model=GROQ_MODEL, messages=messages, temperature=0.5)
        reply_text = (completion.choices[0].message.content or "").strip()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"PulseBot error: {str(e)}")

    now_iso = datetime.now(timezone.utc).isoformat()
    history.append({"role": "user", "content": user_msg, "ts": now_iso})
    history.append({"role": "assistant", "content": reply_text, "ts": now_iso})
    trimmed = history[-30:]
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"chat_history": trimmed}})
    return {"ok": True, "reply": reply_text, "chat_history": trimmed}


@app.post("/api/chat/clear")
def chat_clear(req: ChatClearRequest):
    doc = require_verified_user(req.user_id, req.pin)
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"chat_history": []}})
    return {"ok": True, "chat_history": []}
