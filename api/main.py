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

app = FastAPI(title="LearnPulse OS API — Viswesh & Team, Dept of CSE")

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


# -------------------- Helpers --------------------
def hash_pin(user_id: str, pin: str) -> str:
    raw = f"learnpulse::{user_id.strip().lower()}::{pin.strip()}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def parse_minutes(duration_str: str) -> int:
    text = (duration_str or "").lower()
    hours = re.search(r"(\d+(?:\.\d+)?)\s*(?:hr|hour|h)\b", text)
    mins = re.search(r"(\d+)\s*(?:min|m)\b", text)
    total = 0
    if hours:
        total += int(float(hours.group(1)) * 60)
    if mins:
        total += int(mins.group(1))
    return total if total > 0 else 45


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


def sanitize_account(doc: dict) -> dict:
    return {
        "user_id": doc["user_id"],
        "telegram_id": doc.get("telegram_id", ""),
        "streak": doc.get("streak", 0),
        "last_active_date": doc.get("last_active_date", ""),
        "logged_minutes": doc.get("logged_minutes", 0),
        "plans": doc.get("plans", []),
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


# -------------------- Request Models --------------------
class AuthRequest(BaseModel):
    user_id: str
    pin: str
    telegram_id: str = ""


class GeneratePlanRequest(BaseModel):
    user_id: str
    pin: str
    plan_name: str
    subjects: str
    days: int = 7
    hours_per_day: float = 3.0
    weak_topics: str = ""
    start_date: str = ""


class RebalancePlanRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str
    remaining_days: int = 5
    hours_per_day: float = 3.0


class DeletePlanRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str


class ToggleTaskRequest(BaseModel):
    user_id: str
    pin: str
    plan_id: str
    task_id: str
    done: bool


class FocusLogRequest(BaseModel):
    user_id: str
    pin: str
    minutes: int


class TopicRequest(BaseModel):
    subject: str
    topic: str


# -------------------- Endpoints --------------------
@app.get("/health")
def health():
    return {"status": "ok", "app": "LearnPulse OS", "model": GROQ_MODEL}


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
        if req.telegram_id.strip() and req.telegram_id.strip() != doc.get("telegram_id", ""):
            doc["telegram_id"] = req.telegram_id.strip()
            accounts_col.update_one(
                {"user_id": clean_user},
                {"$set": {"telegram_id": doc["telegram_id"]}},
            )
        return {"ok": True, "created": False, "account": sanitize_account(doc)}

    new_doc = {
        "user_id": clean_user,
        "pin_hash": pin_hash,
        "telegram_id": req.telegram_id.strip(),
        "streak": 0,
        "last_active_date": "",
        "logged_minutes": 0,
        "plans": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    accounts_col.insert_one(new_doc)
    return {"ok": True, "created": True, "account": sanitize_account(new_doc)}


@app.post("/api/plans/generate")
def generate_plan(req: GeneratePlanRequest):
    doc = require_verified_user(req.user_id, req.pin)
    start_dt = req.start_date.strip() or date.today().isoformat()
    plan_name = req.plan_name.strip() or "My Study Plan"

    prompt = f"""Create a practical {req.days}-day adaptive study schedule for an engineering student.
Plan Title: {plan_name}
Subjects: {req.subjects}
Daily study time: {req.hours_per_day} hours/day
Weak topics needing extra focus: {req.weak_topics or "None specified"}

Return ONLY valid JSON matching this schema:
{{
  "summary": "2-sentence strategy tailored to the student's weak areas",
  "days": [
    {{
      "day": 1,
      "title": "Focused theme for Day 1",
      "tasks": [
        {{
          "id": "d1-t1",
          "subject": "Subject name",
          "topic": "Specific concrete study topic",
          "duration": "45 min",
          "done": false
        }}
      ]
    }}
  ]
}}"""

    plan_json = call_groq_json(
        "You are LearnPulse OS, an expert engineering study planner. Output valid JSON only.",
        prompt,
    )

    # Guarantee unique task IDs
    days_list = plan_json.get("days", [])
    for d_idx, day in enumerate(days_list, start=1):
        day["day"] = d_idx
        for t_idx, task in enumerate(day.get("tasks", []), start=1):
            task["id"] = f"d{d_idx}-t{t_idx}-{uuid.uuid4().hex[:4]}"
            task["done"] = False

    new_plan = {
        "plan_id": uuid.uuid4().hex[:10],
        "plan_name": plan_name,
        "subjects": req.subjects,
        "days_count": req.days,
        "hours_per_day": req.hours_per_day,
        "weak_topics": req.weak_topics,
        "start_date": start_dt,
        "summary": plan_json.get("summary", "Prioritize weak topics early and review daily."),
        "days": days_list,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    plans = [new_plan] + doc.get("plans", [])
    doc["plans"] = plans
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "plan": new_plan, "account": sanitize_account(doc)}


@app.post("/api/plans/rebalance")
def rebalance_plan(req: RebalancePlanRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = doc.get("plans", [])
    target = next((p for p in plans if p["plan_id"] == req.plan_id), None)
    if not target:
        raise HTTPException(status_code=404, detail="Plan not found.")

    completed_tasks = []
    pending_tasks = []
    for day in target.get("days", []):
        for task in day.get("tasks", []):
            if task.get("done"):
                completed_tasks.append(task)
            else:
                pending_tasks.append(
                    f"{task.get('subject')}: {task.get('topic')} ({task.get('duration', '45 min')})"
                )

    if not pending_tasks:
        raise HTTPException(status_code=400, detail="All tasks in this plan are already completed!")

    prompt = f"""The student fell behind schedule and needs to rebalance their remaining tasks.
Remaining Days: {req.remaining_days}
Hours per Day: {req.hours_per_day}
Pending Unfinished Tasks:
{chr(10).join('- ' + t for t in pending_tasks)}

Redistribute ALL pending tasks realistically across {req.remaining_days} days, prioritizing harder topics first.
Return ONLY valid JSON:
{{
  "summary": "2-sentence recovery strategy",
  "days": [
    {{
      "day": 1,
      "title": "Catch-up theme",
      "tasks": [
        {{
          "id": "r1-t1",
          "subject": "Subject name",
          "topic": "Specific topic",
          "duration": "45 min",
          "done": false
        }}
      ]
    }}
  ]
}}"""

    plan_json = call_groq_json(
        "You are LearnPulse OS adaptive rescheduler. Output valid JSON only.",
        prompt,
    )

    rebuilt_days = []
    if completed_tasks:
        rebuilt_days.append(
            {
                "day": 0,
                "title": "Completed Earlier (Preserved Progress)",
                "tasks": completed_tasks,
            }
        )

    for d_idx, day in enumerate(plan_json.get("days", []), start=1):
        day["day"] = d_idx
        for t_idx, task in enumerate(day.get("tasks", []), start=1):
            task["id"] = f"rb{d_idx}-t{t_idx}-{uuid.uuid4().hex[:4]}"
            task["done"] = False
        rebuilt_days.append(day)

    target["days"] = rebuilt_days
    target["days_count"] = req.remaining_days
    target["hours_per_day"] = req.hours_per_day
    target["start_date"] = date.today().isoformat()
    target["summary"] = plan_json.get("summary", "Schedule rebalanced to finish remaining topics on time.")
    target["updated_at"] = datetime.now(timezone.utc).isoformat()

    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "plan": target, "account": sanitize_account(doc)}


@app.post("/api/plans/delete")
def delete_plan(req: DeletePlanRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = [p for p in doc.get("plans", []) if p["plan_id"] != req.plan_id]
    doc["plans"] = plans
    accounts_col.update_one({"user_id": doc["user_id"]}, {"$set": {"plans": plans}})
    return {"ok": True, "account": sanitize_account(doc)}


@app.post("/api/tasks/toggle")
def toggle_task(req: ToggleTaskRequest):
    doc = require_verified_user(req.user_id, req.pin)
    plans = doc.get("plans", [])
    target_plan = next((p for p in plans if p["plan_id"] == req.plan_id), None)
    if not target_plan:
        raise HTTPException(status_code=404, detail="Plan not found.")

    found_task = None
    for day in target_plan.get("days", []):
        for task in day.get("tasks", []):
            if task.get("id") == req.task_id:
                found_task = task
                break

    if not found_task:
        raise HTTPException(status_code=404, detail="Task not found.")

    prev_done = bool(found_task.get("done", False))
    found_task["done"] = req.done

    mins = parse_minutes(found_task.get("duration", "45 min"))
    logged = int(doc.get("logged_minutes", 0))
    if req.done and not prev_done:
        logged += mins
        streak, last_active = update_streak(doc)
        doc["streak"] = streak
        doc["last_active_date"] = last_active
    elif not req.done and prev_done:
        logged = max(0, logged - mins)

    doc["logged_minutes"] = logged
    target_plan["updated_at"] = datetime.now(timezone.utc).isoformat()

    accounts_col.update_one(
        {"user_id": doc["user_id"]},
        {
            "$set": {
                "plans": plans,
                "logged_minutes": doc["logged_minutes"],
                "streak": doc.get("streak", 0),
                "last_active_date": doc.get("last_active_date", ""),
            }
        },
    )
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
        {
            "$set": {
                "logged_minutes": doc["logged_minutes"],
                "streak": streak,
                "last_active_date": last_active,
            }
        },
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

    data = call_groq_json(
        "You are an engineering exam quiz generator. Output valid JSON only.",
        prompt,
    )
    return {"ok": True, "questions": data.get("questions", [])}
