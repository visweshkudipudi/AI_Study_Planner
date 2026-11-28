"""
LearnPulse OS - Backend API (v7 with AI Question Scanner)
Developed by Viswesh & Team, Dept of CSE

FastAPI + MongoDB Atlas + Groq (openai/gpt-oss-120b + qwen/qwen3.8-27b vision).
Everything lives in one MongoDB document per student inside the isolated
collection `learnpulse_os_accounts`.

Auth: every request after /api/auth sends two headers:
    X-Username: <username>
    X-Token:    <token returned by /api/auth>
"""

import hashlib
import hmac
import json
import os
import re
import secrets
import time
import uuid
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, field_validator
from pymongo import MongoClient

# --------------------------------------------------------------------------
# Config
# --------------------------------------------------------------------------
DB_NAME = os.environ.get("MONGO_DB", "ai_study_planner")
COLLECTION = "learnpulse_os_accounts"
MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]
VISION_MODEL = os.environ.get("VISION_MODEL", "qwen/qwen3.8-27b")

DAY_MIN_START = 6 * 60      # 6:00 AM
DAY_MAX_END = 23 * 60       # 11:00 PM
MAX_PLANS = 12
HABIT_HORIZON = 14
MAX_SCAN_IMAGE_CHARS = 7_500_000  # ~5.5 MB base64 image limit

DEFAULT_SETTINGS = {
    "study_start": "09:00",
    "study_end": "21:00",
    "buffer_min": 15,
    "max_daily_hours": 6,
    "weekly_goal_hours": 10,
    "defense_mode": "proactive",   # proactive | reactive
    "default_session": 50,
}

BLOCK_TYPES = {"focus", "task", "habit", "fixed"}
PRIORITIES = ["P1", "P2", "P3", "P4"]

app = FastAPI(title="LearnPulse OS API", version="7.0")


@app.middleware("http")
async def catch_all_errors(request, call_next):
    # Keeps unexpected errors as JSON so CORS headers are still attached.
    try:
        return await call_next(request)
    except Exception as e:  # noqa: BLE001
        return JSONResponse(
            {"detail": "Server error: " + type(e).__name__ + " - " + str(e)[:160]},
            status_code=500,
        )


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --------------------------------------------------------------------------
# Small helpers
# --------------------------------------------------------------------------
_mongo = None


def col():
    global _mongo
    if _mongo is None:
        uri = os.environ.get("MONGO_URI")
        if not uri:
            raise HTTPException(500, "MONGO_URI is not configured on the server")
        _mongo = MongoClient(uri, serverSelectionTimeoutMS=8000)
    return _mongo[DB_NAME][COLLECTION]


def bad(msg: str, code: int = 400):
    raise HTTPException(code, msg)


def sha(s: str) -> str:
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def uid_of(username: str) -> str:
    return re.sub(r"\s+", " ", (username or "").strip()).lower()


def parse_hm(s: Any) -> int:
    m = re.fullmatch(r"(\d{1,2}):(\d{2})", str(s).strip())
    if not m:
        bad("Invalid time '" + str(s) + "' (use HH:MM)")
    h, mi = int(m.group(1)), int(m.group(2))
    if h > 23 or mi > 59:
        bad("Invalid time '" + str(s) + "'")
    return h * 60 + mi


def min_to_hm(m: int) -> str:
    return "%02d:%02d" % (m // 60, m % 60)


def parse_date(s: Any) -> date:
    try:
        return date.fromisoformat(str(s))
    except Exception:  # noqa: BLE001
        bad("Invalid date '" + str(s) + "' (use YYYY-MM-DD)")


def today_or_default(s: Optional[str]) -> date:
    if s:
        try:
            return date.fromisoformat(s)
        except Exception:  # noqa: BLE001
            pass
    return date.today()


def clamp(v: Any, lo: int, hi: int, default: int) -> int:
    try:
        v = int(round(float(v)))
    except Exception:  # noqa: BLE001
        return default
    return max(lo, min(hi, v))


def parse_duration(v: Any, default: int = 45) -> int:
    if isinstance(v, (int, float)):
        raw = float(v)
    else:
        txt = str(v or "").lower()
        h = re.search(r"(\d+(?:\.\d+)?)\s*(?:hr|hour|h)\b", txt)
        m = re.search(r"(\d+(?:\.\d+)?)\s*(?:min|m)\b", txt)
        if h or m:
            raw = (float(h.group(1)) * 60 if h else 0.0) + (float(m.group(1)) if m else 0.0)
        else:
            num = re.search(r"\d+(?:\.\d+)?", txt)
            raw = float(num.group(0)) if num else float(default)
    rounded = int(round(raw / 5.0) * 5)
    return max(15, min(120, rounded if rounded > 0 else default))


def prio_rank(p: str) -> int:
    return {"P1": 0, "P2": 1, "P3": 2, "P4": 3}.get(p, 2)


# --------------------------------------------------------------------------
# Document handling
# --------------------------------------------------------------------------
def doc_defaults() -> Dict[str, Any]:
    return {
        "username": "",
        "pin_hash": "",
        "created_at": now_iso(),
        "tokens": [],
        "fails": 0,
        "locked_until": 0.0,
        "streak": 0,
        "last_done_date": None,
        "activity": {},
        "plans": [],
        "active_plan_id": None,
        "habits": [],
        "habit_skips": [],
        "settings": dict(DEFAULT_SETTINGS),
        "focus_sessions": [],
        "chat": [],
        "scans": [],
        "weak_topics": [],
    }


def normalize(doc: Dict[str, Any]) -> Dict[str, Any]:
    for k, v in doc_defaults().items():
        if k not in doc or (doc[k] is None and v is not None):
            doc[k] = v
        elif v is not None and not isinstance(doc[k], type(v)):
            if isinstance(v, float) and isinstance(doc[k], int):
                continue
            doc[k] = v
    doc["settings"] = {**DEFAULT_SETTINGS, **doc["settings"]}
    good = []
    for p in doc["plans"]:
        if isinstance(p, dict) and p.get("id") and isinstance(p.get("blocks"), list):
            p["blocks"] = [b for b in p["blocks"] if isinstance(b, dict) and b.get("id")]
            for b in p["blocks"]:
                b.setdefault("subject", "")
                b.setdefault("topic", "")
                b.setdefault("priority", "P3")
                b.setdefault("locked", False)
                b.setdefault("defense", "busy")
                b.setdefault("done", False)
                b.setdefault("notes", "")
                b.setdefault("type", "task")
            good.append(p)
    doc["plans"] = good
    if doc["active_plan_id"] not in [p["id"] for p in good]:
        doc["active_plan_id"] = good[0]["id"] if good else None
    return doc


def save(doc: Dict[str, Any], *fields: str):
    col().update_one({"_id": doc["_id"]}, {"$set": {f: doc[f] for f in fields}})


def auth_user(
    x_username: Optional[str] = Header(None),
    x_token: Optional[str] = Header(None),
) -> Dict[str, Any]:
    if not x_username or not x_token:
        bad("Not signed in", 401)
    doc = col().find_one({"_id": uid_of(x_username)})
    if not doc:
        bad("Session expired. Please sign in again.", 401)
    if sha(x_token) not in (doc.get("tokens") or []):
        bad("Session expired. Please sign in again.", 401)
    return normalize(doc)


def get_plan(doc: Dict[str, Any], pid: str) -> Dict[str, Any]:
    for p in doc["plans"]:
        if p["id"] == pid:
            return p
    bad("Plan not found", 404)


def find_block(plan: Dict[str, Any], bid: str) -> Dict[str, Any]:
    for b in plan["blocks"]:
        if b["id"] == bid:
            return b
    bad("Block not found", 404)


def active_plan(doc: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    for p in doc["plans"]:
        if p["id"] == doc["active_plan_id"]:
            return p
    return None


# --------------------------------------------------------------------------
# Settings, blocks, buffers
# --------------------------------------------------------------------------
def clean_settings(inp: Dict[str, Any], base: Dict[str, Any]) -> Dict[str, Any]:
    s = dict(base)
    for k in ("study_start", "study_end"):
        if k in inp and inp[k] is not None:
            m = parse_hm(inp[k])
            s[k] = min_to_hm(max(DAY_MIN_START, min(DAY_MAX_END, m)))
    if inp.get("buffer_min") is not None:
        s["buffer_min"] = clamp(inp["buffer_min"], 0, 60, 15)
    if inp.get("max_daily_hours") is not None:
        s["max_daily_hours"] = max(1, min(14, float(inp["max_daily_hours"])))
    if inp.get("weekly_goal_hours") is not None:
        s["weekly_goal_hours"] = max(1, min(100, float(inp["weekly_goal_hours"])))
    if inp.get("defense_mode") is not None:
        if inp["defense_mode"] not in ("proactive", "reactive"):
            bad("defense_mode must be 'proactive' or 'reactive'")
        s["defense_mode"] = inp["defense_mode"]
    if inp.get("default_session") is not None:
        s["default_session"] = clamp(inp["default_session"], 15, 120, 50)
    if parse_hm(s["study_end"]) - parse_hm(s["study_start"]) < 60:
        bad("Study end must be at least 1 hour after study start")
    return s


def default_defense(st: Dict[str, Any], btype: str) -> str:
    if btype in ("fixed", "focus") or st.get("defense_mode") == "proactive":
        return "busy"
    return "free"


def make_block(title, btype, date_s, start_min, dur, st, subject="", topic="",
               priority="P3", locked=None, defense=None, habit_id=None, bid=None):
    return {
        "id": bid or uuid.uuid4().hex[:12],
        "title": str(title)[:120],
        "type": btype,
        "subject": str(subject)[:60],
        "topic": str(topic)[:120],
        "priority": priority if priority in PRIORITIES else "P3",
        "date": date_s,
        "start": min_to_hm(start_min),
        "duration": int(dur),
        "locked": (btype == "fixed") if locked is None else bool(locked),
        "defense": defense or default_defense(st, btype),
        "done": False,
        "habit_id": habit_id,
        "notes": "",
        "manual": False,
    }


def compute_buffers(blocks: List[Dict[str, Any]], buf: int) -> List[Dict[str, Any]]:
    if buf <= 0:
        return []
    by_day = defaultdict(list)
    for b in blocks:
        by_day[b["date"]].append(b)
    out = []
    for ds, items in by_day.items():
        items.sort(key=lambda x: x["start"])
        for i in range(len(items) - 1):
            cur, nxt = items[i], items[i + 1]
            end = parse_hm(cur["start"]) + cur["duration"]
            gap = parse_hm(nxt["start"]) - end
            if buf <= gap <= buf * 2:
                out.append({
                    "id": "buf_" + cur["id"], "type": "buffer", "title": "Buffer",
                    "date": ds, "start": min_to_hm(end), "duration": buf,
                })
    return out


def plan_payload(doc: Dict[str, Any], plan: Dict[str, Any]) -> Dict[str, Any]:
    blocks = sorted(plan["blocks"], key=lambda b: (b["date"], b["start"]))
    return {
        "plan": {k: plan.get(k) for k in ("id", "name", "goal", "created_at")},
        "blocks": blocks,
        "buffers": compute_buffers(blocks, int(doc["settings"]["buffer_min"])),
        "active": doc["active_plan_id"] == plan["id"],
    }


def plan_summary(p: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "id": p["id"], "name": p.get("name", "Plan"), "goal": p.get("goal", ""),
        "created_at": p.get("created_at"),
        "block_count": len(p["blocks"]),
        "done_count": sum(1 for b in p["blocks"] if b.get("done")),
    }


# --------------------------------------------------------------------------
# Scheduling engine
# --------------------------------------------------------------------------
def conflicts(t: int, dur: int, occ: List[Any], buf: int) -> bool:
    return any(t < e + buf and t + dur + buf > s for s, e in occ)


def find_slot(occ: List[Any], dur: int, earliest: int, latest: int, buf: int) -> Optional[int]:
    cur = earliest
    for s, e in sorted(occ):
        if e + buf <= cur:
            continue
        if cur + dur + buf <= s:
            break
        cur = max(cur, e + buf)
    if cur + dur <= latest:
        return cur
    return None


def schedule(items, kept, base_date, num_days, st, cap_min, now_min=None, wrap=True):
    """items: dicts with 'duration' and 'pref' (day offset). Returns (placed, unplaced)."""
    buf = int(st["buffer_min"])
    ws = max(DAY_MIN_START, parse_hm(st["study_start"]))
    we = min(DAY_MAX_END, parse_hm(st["study_end"]))
    occ = defaultdict(list)
    load = defaultdict(int)
    for b in kept:
        s = parse_hm(b["start"])
        occ[b["date"]].append((s, s + int(b["duration"])))
        if b.get("type") in ("task", "focus"):
            load[b["date"]] += int(b["duration"])
    placed, unplaced = [], []
    for it in items:
        dur = int(it["duration"])
        pref = max(0, min(num_days - 1, int(it.get("pref", 0))))
        order = list(range(pref, num_days))
        if wrap:
            order += list(range(0, pref))
        ok = False
        for off in order:
            ds = (base_date + timedelta(days=off)).isoformat()
            if load[ds] > 0 and load[ds] + dur > cap_min:
                continue
            earliest = ws
            if off == 0 and now_min is not None:
                earliest = max(ws, ((int(now_min) + 14) // 15) * 15)
            t = find_slot(occ[ds], dur, earliest, we, buf)
            if t is None:
                continue
            occ[ds].append((t, t + dur))
            load[ds] += dur
            placed.append((it, ds, t))
            ok = True
            break
        if not ok:
            unplaced.append(it)
    return placed, unplaced


# --------------------------------------------------------------------------
# Habits
# --------------------------------------------------------------------------
class HabitIn(BaseModel):
    name: str
    duration: int = 30
    earliest: str = "07:00"
    ideal: str = "08:00"
    latest: str = "10:00"
    days: List[int] = [0, 1, 2, 3, 4, 5, 6]
    defense: str = "busy"
    today: Optional[str] = None


def clean_habit(h: HabitIn, hid: Optional[str] = None) -> Dict[str, Any]:
    name = h.name.strip()
    if not name:
        bad("Habit name is required")
    dur = clamp(h.duration, 5, 240, 30)
    e, l, i = parse_hm(h.earliest), parse_hm(h.latest), parse_hm(h.ideal)
    if e < DAY_MIN_START or l > DAY_MAX_END:
        bad("Habit window must be between 6:00 AM and 11:00 PM")
    if l - e < dur:
        bad("Habit window is shorter than its duration")
    i = max(e, min(i, l - dur))
    days = sorted({d for d in h.days if isinstance(d, int) and 0 <= d <= 6})
    if not days:
        bad("Pick at least one day")
    if h.defense not in ("busy", "free"):
        bad("defense must be 'busy' or 'free'")
    return {
        "id": hid or uuid.uuid4().hex[:10], "name": name[:60], "duration": dur,
        "earliest": min_to_hm(e), "ideal": min_to_hm(i), "latest": min_to_hm(l),
        "days": days, "defense": h.defense,
    }


def place_habit(h: Dict[str, Any], occ: List[Any], buf: int) -> Optional[int]:
    e, l, ideal = parse_hm(h["earliest"]), parse_hm(h["latest"]), parse_hm(h["ideal"])
    dur = h["duration"]
    best = None
    t = e
    while t + dur <= l:
        if not conflicts(t, dur, occ, buf):
            if best is None or abs(t - ideal) < abs(best - ideal):
                best = t
        t += 5
    return best


def sync_plan_habits(doc, plan, today_d: date, horizon: int = HABIT_HORIZON):
    today_s = today_d.isoformat()
    habits = doc["habits"]
    skips = set(doc.get("habit_skips", []))
    buf = int(doc["settings"]["buffer_min"])
    days = [today_d + timedelta(days=i) for i in range(horizon)]
    keep = []
    for b in plan["blocks"]:
        if (b["type"] == "habit" and b["date"] >= today_s
                and not (b.get("done") or b.get("locked") or b.get("manual"))):
            continue
        keep.append(b)
    existing = {b["id"] for b in keep}
    occ = defaultdict(list)
    for b in keep:
        s = parse_hm(b["start"])
        occ[b["date"]].append((s, s + int(b["duration"])))
    for h in habits:
        for d in days:
            if d.weekday() not in h["days"]:
                continue
            ds = d.isoformat()
            bid = "h_%s_%s" % (h["id"], ds)
            if bid in existing or bid in skips:
                continue
            t = place_habit(h, occ[ds], buf)
            if t is None:
                continue
            blk = make_block(h["name"], "habit", ds, t, h["duration"], doc["settings"],
                             habit_id=h["id"], defense=h["defense"], bid=bid, priority="P3")
            keep.append(blk)
            occ[ds].append((t, t + h["duration"]))
    plan["blocks"] = keep


def sync_habits(doc, today_d: date, horizon: int = HABIT_HORIZON):
    for p in doc["plans"]:
        sync_plan_habits(doc, p, today_d, horizon)


# --------------------------------------------------------------------------
# Activity / streak
# --------------------------------------------------------------------------
def bump_streak(doc, today_s: str):
    last = doc.get("last_done_date")
    if last == today_s:
        return
    t = parse_date(today_s)
    if last:
        try:
            if (t - date.fromisoformat(last)).days == 1:
                doc["streak"] = int(doc.get("streak", 0)) + 1
            else:
                doc["streak"] = 1
        except Exception:  # noqa: BLE001
            doc["streak"] = 1
    else:
        doc["streak"] = 1
    doc["last_done_date"] = today_s


def streak_now(doc, today_s: str) -> int:
    last = doc.get("last_done_date")
    if not last:
        return 0
    try:
        if (today_or_default(today_s) - date.fromisoformat(last)).days <= 1:
            return int(doc.get("streak", 0))
    except Exception:  # noqa: BLE001
        pass
    return 0


def log_minutes(doc, date_s: str, minutes: int, kind: str):
    act = doc["activity"]
    day = act.get(date_s) or {"study": 0, "focus": 0}
    day[kind] = max(0, int(day.get(kind, 0)) + int(minutes))
    act[date_s] = day
    if len(act) > 400:
        for k in sorted(act.keys())[:-400]:
            act.pop(k, None)


def day_minutes(doc, today_d: date) -> int:
    a = doc["activity"].get(today_d.isoformat())
    if not a:
        return 0
    return int(a.get("study", 0)) + int(a.get("focus", 0))


def week_minutes(doc, today_d: date) -> int:
    start = today_d - timedelta(days=today_d.weekday())
    total = 0
    for i in range(7):
        a = doc["activity"].get((start + timedelta(days=i)).isoformat())
        if a:
            total += int(a.get("study", 0)) + int(a.get("focus", 0))
    return total


# --------------------------------------------------------------------------
# AI helpers (Groq)
# --------------------------------------------------------------------------
def get_groq():
    key = os.environ.get("GROQ_API_KEY")
    if not key:
        bad("AI is not configured (GROQ_API_KEY missing)", 503)
    from groq import Groq
    return Groq(api_key=key, timeout=55.0, max_retries=1)


def llm(messages, json_mode=False, temperature=0.4, max_tokens=4096) -> str:
    client = get_groq()
    last = None
    for model in MODELS:
        variants = [
            {"extra_body": {"reasoning_effort": "low"}, "json": json_mode},
            {"json": json_mode},
            {"json": False},
        ]
        seen = []
        for v in variants:
            key = json.dumps(v, sort_keys=True)
            if key in seen:
                continue
            seen.append(key)
            kwargs = {
                "model": model, "messages": messages,
                "temperature": temperature, "max_tokens": max_tokens,
            }
            if v.get("json"):
                kwargs["response_format"] = {"type": "json_object"}
       