import json
import os
import re
from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from groq import Groq
from pydantic import BaseModel
from pymongo import MongoClient

app = FastAPI(title="AI Study Planner Web API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

MONGO_URI = os.getenv("MONGO_URI", "")
DB_NAME = os.getenv("MONGO_DB_NAME", "ai_study_planner")
COLLECTION_NAME = os.getenv("WEB_COLLECTION_NAME", "web_study_plans")
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "openai/gpt-oss-120b")

mongo_client = MongoClient(MONGO_URI) if MONGO_URI else None
collection = mongo_client[DB_NAME][COLLECTION_NAME] if mongo_client else None
groq_client = Groq(api_key=GROQ_API_KEY) if GROQ_API_KEY else None


class PlanRequest(BaseModel):
    user_id: str
    subjects: str
    days: int = 7
    hours_per_day: float = 3.0
    weak_topics: str = ""


class ToggleTaskRequest(BaseModel):
    user_id: str
    task_id: str
    done: bool


@app.get("/health")
def health():
    return {"status": "ok", "model": GROQ_MODEL}


@app.get("/api/plan/{user_id}")
def get_plan(user_id: str):
    if collection is None:
        raise HTTPException(status_code=500, detail="MONGO_URI not configured on Render")
    doc = collection.find_one({"user_id": user_id.strip().lower()}, {"_id": 0})
    if not doc:
        return {"found": False, "plan": None}
    return {"found": True, "plan": doc}


@app.post("/api/generate-plan")
def generate_plan(req: PlanRequest):
    if groq_client is None:
        raise HTTPException(status_code=500, detail="GROQ_API_KEY not configured on Render")
    if collection is None:
        raise HTTPException(status_code=500, detail="MONGO_URI not configured on Render")

    clean_user = req.user_id.strip().lower()
    if not clean_user:
        raise HTTPException(status_code=400, detail="Student ID is required")

    prompt = f"""Create a practical {req.days}-day adaptive study plan for an engineering student.
Subjects: {req.subjects}
Daily study time: {req.hours_per_day} hours/day
Weak topics needing extra focus: {req.weak_topics or "None specified"}

Return ONLY valid JSON with this exact structure:
{{
  "summary": "2-sentence strategy tailored to the weak topics",
  "days": [
    {{
      "day": 1,
      "title": "Short focus theme for Day 1",
      "tasks": [
        {{
          "id": "d1-t1",
          "subject": "Subject name",
          "topic": "Specific concrete study task",
          "duration": "45 min",
          "done": false
        }}
      ]
    }}
  ]
}}"""

    try:
        completion = groq_client.chat.completions.create(
            model=GROQ_MODEL,
            messages=[
                {"role": "system", "content": "You are an expert study planner. Output valid JSON only."},
                {"role": "user", "content": prompt},
            ],
            temperature=0.4,
            response_format={"type": "json_object"},
        )
        raw_text = completion.choices[0].message.content or "{}"
        match = re.search(r"\{.*\}", raw_text, re.S)
        plan_json = json.loads(match.group(0) if match else raw_text)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI generation failed: {str(e)}")

    record = {
        "user_id": clean_user,
        "subjects": req.subjects,
        "days_count": req.days,
        "hours_per_day": req.hours_per_day,
        "weak_topics": req.weak_topics,
        "summary": plan_json.get("summary", "Stay consistent and review weak areas first."),
        "days": plan_json.get("days", []),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }

    collection.update_one({"user_id": clean_user}, {"$set": record}, upsert=True)
    return {"found": True, "plan": record}


@app.post("/api/toggle-task")
def toggle_task(req: ToggleTaskRequest):
    if collection is None:
        raise HTTPException(status_code=500, detail="MONGO_URI not configured on Render")

    clean_user = req.user_id.strip().lower()
    doc = collection.find_one({"user_id": clean_user})
    if not doc:
        raise HTTPException(status_code=404, detail="Plan not found")

    updated = False
    for day in doc.get("days", []):
        for task in day.get("tasks", []):
            if task.get("id") == req.task_id:
                task["done"] = req.done
                updated = True
                break

    if not updated:
        raise HTTPException(status_code=404, detail="Task not found")

    collection.update_one(
        {"user_id": clean_user},
        {"$set": {"days": doc["days"], "updated_at": datetime.now(timezone.utc).isoformat()}},
    )
    return {"ok": True}
