"""
LearnPulse OS - Backend API
Developed by Viswesh & Team, Dept of CSE

FastAPI + MongoDB Atlas + Groq (openai/gpt-oss-120b).
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

DAY_MIN_START = 6 * 60      # 6:00 AM
DAY_MAX_END = 23 * 60       # 11:00 PM
MAX_PLANS = 12
HABIT_HORIZON = 14

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

app = FastAPI(title="LearnPulse OS API", version="6.0")


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
        "weak_topics": [],
    }


def normalize(doc: Dict[str, Any]) -> Dict[str, Any]:
    for k, v in doc_defaults().items():
        if k not in doc or doc[k] is None and v is not None:
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
    # keep the activity map small
    if len(act) > 400:
        for k in sorted(act.keys())[:-400]:
            act.pop(k, None)


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
    return Groq(api_key=key, timeout=50.0, max_retries=1)


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
            if v.get("extra_body"):
                kwargs["extra_body"] = v["extra_body"]
            try:
                r = client.chat.completions.create(**kwargs)
                txt = (r.choices[0].message.content or "").strip()
                if txt:
                    return txt
            except Exception as e:  # noqa: BLE001
                last = e
    bad("AI is unavailable right now: " + str(last)[:160], 502)


def parse_json(txt: str) -> Any:
    txt = (txt or "").strip()
    txt = re.sub(r"^```(?:json)?", "", txt, flags=re.M)
    txt = re.sub(r"```$", "", txt, flags=re.M).strip()
    try:
        return json.loads(txt)
    except Exception:  # noqa: BLE001
        pass
    m = re.search(r"\{.*\}", txt, re.S)
    if m:
        try:
            return json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            pass
    return None


# --------------------------------------------------------------------------
# Models (request bodies)
# --------------------------------------------------------------------------
class AuthIn(BaseModel):
    username: str
    pin: str


class SubjectIn(BaseModel):
    name: str
    level: str = "medium"   # weak | medium | strong


class GenerateIn(BaseModel):
    name: str = ""
    subjects: List[SubjectIn]
    goal: str = ""
    start_date: str
    days: int = 7
    hours_per_day: float = 3
    session_minutes: int = 50
    exam_date: Optional[str] = None
    today: Optional[str] = None
    now_min: Optional[int] = None

    @field_validator("subjects", mode="before")
    @classmethod
    def _subjects(cls, v):
        out = []
        for s in v or []:
            out.append({"name": s} if isinstance(s, str) else s)
        return out


class BlankPlanIn(BaseModel):
    name: str = "My Study Plan"


class RenameIn(BaseModel):
    name: str


class BlockIn(BaseModel):
    title: str
    type: str = "task"
    subject: str = ""
    topic: str = ""
    priority: str = "P3"
    date: str
    start: str
    duration: int = 50
    locked: Optional[bool] = None
    defense: Optional[str] = None
    repeat_weeks: int = 0


class BlockPatch(BaseModel):
    title: Optional[str] = None
    subject: Optional[str] = None
    topic: Optional[str] = None
    priority: Optional[str] = None
    date: Optional[str] = None
    start: Optional[str] = None
    duration: Optional[int] = None
    locked: Optional[bool] = None
    defense: Optional[str] = None


class DoneIn(BaseModel):
    done: bool = True
    today: Optional[str] = None


class RebalanceIn(BaseModel):
    today: str
    now_min: Optional[int] = None


class Move(BaseModel):
    id: str
    date: str
    start: str


class ApplyIn(BaseModel):
    moves: List[Move]


class SettingsIn(BaseModel):
    study_start: Optional[str] = None
    study_end: Optional[str] = None
    buffer_min: Optional[int] = None
    max_daily_hours: Optional[float] = None
    weekly_goal_hours: Optional[float] = None
    defense_mode: Optional[str] = None
    default_session: Optional[int] = None


class FocusIn(BaseModel):
    minutes: int
    subject: str = ""
    today: Optional[str] = None
    plan_id: Optional[str] = None
    block_id: Optional[str] = None


class SyncIn(BaseModel):
    today: Optional[str] = None


class NotesIn(BaseModel):
    topic: str
    subject: str = ""
    plan_id: Optional[str] = None
    block_id: Optional[str] = None
    refresh: bool = False


class QuizIn(BaseModel):
    topic: str
    subject: str = ""


class QuizResultIn(BaseModel):
    topic: str
    subject: str = ""
    score: int
    total: int


class ChatIn(BaseModel):
    message: str
    today: Optional[str] = None
    now: Optional[str] = None   # "HH:MM"


# --------------------------------------------------------------------------
# Health
# --------------------------------------------------------------------------
@app.get("/")
def root():
    return {"app": "LearnPulse OS API", "status": "ok"}


@app.get("/health")
def health():
    return {"status": "ok", "app": "LearnPulse OS", "time": now_iso()}


# --------------------------------------------------------------------------
# Auth
# --------------------------------------------------------------------------
@app.post("/api/auth")
def auth(body: AuthIn):
    name = re.sub(r"\s+", " ", body.username.strip())
    if not re.fullmatch(r"[A-Za-z0-9_. \-]{2,24}", name):
        bad("Username must be 2-24 characters (letters, numbers, space, . _ -)")
    if not re.fullmatch(r"\d{4}", body.pin):
        bad("PIN must be exactly 4 digits")
    uid = uid_of(name)
    pin_hash = sha("learnpulse:" + uid + ":" + body.pin)
    token = secrets.token_urlsafe(32)
    doc = col().find_one({"_id": uid})
    new_account = False
    if doc is None:
        doc = doc_defaults()
        doc.update({"_id": uid, "username": name, "pin_hash": pin_hash,
                    "tokens": [sha(token)]})
        col().insert_one(doc)
        new_account = True
    else:
        doc = normalize(doc)
        if time.time() < float(doc.get("locked_until", 0) or 0):
            mins = int((float(doc["locked_until"]) - time.time()) // 60) + 1
            bad("Too many wrong PINs. Try again in %d min." % mins, 429)
        stored = doc.get("pin_hash", "")
        ok = hmac.compare_digest(stored, pin_hash) or hmac.compare_digest(stored, sha(body.pin))
        if not ok:
            doc["fails"] = int(doc.get("fails", 0)) + 1
            if doc["fails"] >= 5:
                doc["fails"] = 0
                doc["locked_until"] = time.time() + 300
            save(doc, "fails", "locked_until")
            bad("Wrong PIN for this username", 401)
        doc["pin_hash"] = pin_hash
        doc["fails"] = 0
        doc["locked_until"] = 0.0
        doc["tokens"] = (doc["tokens"] + [sha(token)])[-5:]
        if not doc.get("username"):
            doc["username"] = name
        save(doc, "pin_hash", "fails", "locked_until", "tokens", "username")
    return {"token": token, "username": doc["username"], "new_account": new_account}


@app.post("/api/logout")
def logout(
    x_username: Optional[str] = Header(None),
    x_token: Optional[str] = Header(None),
):
    if x_username and x_token:
        col().update_one({"_id": uid_of(x_username)}, {"$pull": {"tokens": sha(x_token)}})
    return {"ok": True}


@app.get("/api/me")
def me(today: Optional[str] = Query(None), doc=Depends(auth_user)):
    t = today_or_default(today)
    return {
        "username": doc["username"],
        "streak": streak_now(doc, t.isoformat()),
        "settings": doc["settings"],
        "habits": doc["habits"],
        "active_plan_id": doc["active_plan_id"],
        "plans": [plan_summary(p) for p in doc["plans"]],
        "weekly_minutes": week_minutes(doc, t),
    }


# --------------------------------------------------------------------------
# Settings
# --------------------------------------------------------------------------
@app.get("/api/settings")
def get_settings(doc=Depends(auth_user)):
    return {"settings": doc["settings"]}


@app.put("/api/settings")
def put_settings(body: SettingsIn, doc=Depends(auth_user)):
    doc["settings"] = clean_settings(body.model_dump(exclude_none=True), doc["settings"])
    save(doc, "settings")
    return {"settings": doc["settings"]}


# --------------------------------------------------------------------------
# Plans
# --------------------------------------------------------------------------
@app.get("/api/plans")
def list_plans(doc=Depends(auth_user)):
    return {"plans": [plan_summary(p) for p in doc["plans"]],
            "active_plan_id": doc["active_plan_id"]}


@app.get("/api/plans/{pid}")
def read_plan(pid: str, doc=Depends(auth_user)):
    return plan_payload(doc, get_plan(doc, pid))


@app.post("/api/plans/blank")
def blank_plan(body: BlankPlanIn, doc=Depends(auth_user)):
    if len(doc["plans"]) >= MAX_PLANS:
        bad("You have %d plans. Delete an old one first." % MAX_PLANS)
    plan = {"id": uuid.uuid4().hex[:10], "name": (body.name.strip() or "My Study Plan")[:60],
            "goal": "", "created_at": now_iso(), "blocks": []}
    doc["plans"].append(plan)
    doc["active_plan_id"] = plan["id"]
    sync_plan_habits(doc, plan, date.today())
    save(doc, "plans", "active_plan_id")
    return plan_payload(doc, plan)


@app.put("/api/plans/{pid}")
def rename_plan(pid: str, body: RenameIn, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    name = body.name.strip()
    if not name:
        bad("Name is required")
    plan["name"] = name[:60]
    save(doc, "plans")
    return {"ok": True, "plan": plan_summary(plan)}


@app.put("/api/plans/{pid}/activate")
def activate_plan(pid: str, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    doc["active_plan_id"] = pid
    save(doc, "active_plan_id")
    return plan_payload(doc, plan)


@app.delete("/api/plans/{pid}")
def delete_plan(pid: str, doc=Depends(auth_user)):
    get_plan(doc, pid)
    doc["plans"] = [p for p in doc["plans"] if p["id"] != pid]
    if doc["active_plan_id"] == pid:
        doc["active_plan_id"] = doc["plans"][0]["id"] if doc["plans"] else None
    save(doc, "plans", "active_plan_id")
    return {"ok": True, "active_plan_id": doc["active_plan_id"],
            "plans": [plan_summary(p) for p in doc["plans"]]}


def ai_plan_tasks(body: GenerateIn, subjects, weak) -> List[Dict[str, Any]]:
    total_min = int(body.days * body.hours_per_day * 60)
    approx = max(4, min(80, total_min // max(20, body.session_minutes - 10)))
    sub_txt = "; ".join("%s (%s)" % (s["name"], s["level"]) for s in subjects)
    weak_txt = ", ".join(w.get("topic", "") for w in weak[:8]) or "none"
    system = (
        "You are an expert study-planning engine. Reply with ONE JSON object only, "
        "no prose, no markdown fences."
    )
    user = (
        "Create study tasks for a student.\n"
        "Subjects (with strength): " + sub_txt + "\n"
        "Goal: " + (body.goal or "general mastery") + "\n"
        "Exam date: " + (body.exam_date or "not set") + "\n"
        "Plan length: %d days, about %.1f study hours per day.\n" % (body.days, body.hours_per_day) +
        "Known weak topics to revisit: " + weak_txt + "\n"
        "Give about %d tasks. Weak subjects get more and earlier tasks. Mix deep "
        "'focus' sessions (~%d min) with shorter 'task' items (practice problems, "
        "revision, mock tests, flashcards, 20-45 min).\n" % (approx, body.session_minutes) +
        'JSON shape: {"plan_name": "short name", "tasks": [{"title": "specific action", '
        '"subject": "subject name", "topic": "specific topic", "kind": "focus" or "task", '
        '"duration": minutes multiple of 5 between 20 and 90, "priority": "P1".."P4" '
        "(P1 most urgent), \"day\": day number 1-%d}]}" % body.days
    )
    txt = llm([{"role": "system", "content": system}, {"role": "user", "content": user}],
              json_mode=True, temperature=0.5)
    data = parse_json(txt)
    raw = data.get("tasks") if isinstance(data, dict) else data
    if not isinstance(raw, list):
        return []
    tasks = []
    for i, t in enumerate(raw[:80]):
        if not isinstance(t, dict):
            continue
        title = str(t.get("title") or t.get("topic") or "").strip()
        if not title:
            continue
        kind = "focus" if str(t.get("kind", "task")).lower() == "focus" else "task"
        pr = str(t.get("priority", "P2")).upper()
        tasks.append({
            "title": title[:100],
            "subject": str(t.get("subject", ""))[:60],
            "topic": str(t.get("topic", ""))[:120],
            "type": kind,
            "duration": clamp(round(float(t.get("duration", 45) or 45) / 5) * 5, 15, 120, 45),
            "priority": pr if pr in PRIORITIES else "P2",
            "pref": clamp(t.get("day", 1), 1, body.days, 1) - 1,
        })
    name = data.get("plan_name") if isinstance(data, dict) else None
    if tasks and name:
        tasks[0]["_plan_name"] = str(name)[:60]
    return tasks if len(tasks) >= 3 else []


def fallback_tasks(body: GenerateIn, subjects) -> List[Dict[str, Any]]:
    total = int(body.days * body.hours_per_day * 60)
    order = sorted(subjects, key=lambda s: {"weak": 0, "medium": 1, "strong": 2}.get(s["level"], 1))
    pr = {"weak": "P1", "medium": "P2", "strong": "P3"}
    patterns = [
        ("Deep study", "focus", body.session_minutes),
        ("Practice problems", "task", 30),
        ("Quick revision", "task", 25),
    ]
    items, minutes, rnd = [], 0, 0
    while minutes < total and len(items) < 80:
        for s in order:
            label, kind, dur = patterns[rnd % len(patterns)]
            items.append({
                "title": "%s: %s" % (label, s["name"]), "subject": s["name"], "topic": "",
                "type": kind, "duration": dur, "priority": pr.get(s["level"], "P2"),
            })
            minutes += dur
            if minutes >= total or len(items) >= 80:
                break
        rnd += 1
    for i, it in enumerate(items):
        it["pref"] = min(body.days - 1, (i * body.days) // max(1, len(items)))
    return items


@app.post("/api/plans/generate")
def generate_plan(body: GenerateIn, doc=Depends(auth_user)):
    if len(doc["plans"]) >= MAX_PLANS:
        bad("You have %d plans. Delete an old one first." % MAX_PLANS)
    start = parse_date(body.start_date)
    if body.exam_date:
        parse_date(body.exam_date)
    body.days = clamp(body.days, 1, 21, 7)
    body.hours_per_day = max(0.5, min(10.0, float(body.hours_per_day)))
    body.session_minutes = clamp(body.session_minutes, 20, 120, 50)
    subjects = []
    for s in body.subjects:
        nm = s.name.strip()
        if nm:
            subjects.append({"name": nm[:60],
                             "level": s.level if s.level in ("weak", "medium", "strong") else "medium"})
    if not subjects:
        bad("Add at least one subject")
    subjects = subjects[:10]

    tasks, warning, ai_used = [], None, False
    try:
        tasks = ai_plan_tasks(body, subjects, doc["weak_topics"])
        ai_used = bool(tasks)
        if not tasks:
            warning = "AI returned an unusable plan, so a standard plan was created instead."
    except HTTPException as e:
        warning = "AI unavailable (" + str(e.detail)[:100] + "); a standard plan was created."
    except Exception as e:  # noqa: BLE001
        warning = "AI error (" + type(e).__name__ + "); a standard plan was created."
    if not tasks:
        tasks = fallback_tasks(body, subjects)

    plan_name = body.name.strip() or ""
    for t in tasks:
        if t.get("_plan_name") and not plan_name:
            plan_name = t["_plan_name"]
        t.pop("_plan_name", None)
    plan = {
        "id": uuid.uuid4().hex[:10],
        "name": (plan_name or "Plan from " + start.isoformat())[:60],
        "goal": body.goal.strip()[:200], "created_at": now_iso(), "blocks": [],
    }
    doc["plans"].append(plan)
    doc["active_plan_id"] = plan["id"]
    sync_plan_habits(doc, plan, start, max(HABIT_HORIZON, body.days + 1))

    st = doc["settings"]
    now_min = body.now_min if (body.today and body.today == body.start_date) else None
    placed, unplaced = schedule(tasks, plan["blocks"], start, body.days, st,
                                int(body.hours_per_day * 60), now_min=now_min, wrap=True)
    for it, ds, t in placed:
        plan["blocks"].append(make_block(it["title"], it["type"], ds, t, it["duration"], st,
                                         subject=it["subject"], topic=it["topic"],
                                         priority=it["priority"]))
    save(doc, "plans", "active_plan_id")
    out = plan_payload(doc, plan)
    out.update({"ai_used": ai_used, "warning": warning, "unplaced": len(unplaced)})
    return out


# --------------------------------------------------------------------------
# Blocks
# --------------------------------------------------------------------------
def check_fit(start_min: int, dur: int):
    if start_min < DAY_MIN_START:
        bad("Blocks cannot start before 6:00 AM")
    if start_min + dur > DAY_MAX_END:
        bad("Blocks must end by 11:00 PM")


@app.post("/api/plans/{pid}/blocks")
def add_block(pid: str, body: BlockIn, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    title = body.title.strip()
    if not title:
        bad("Title is required")
    if body.type not in BLOCK_TYPES:
        bad("Invalid block type")
    if body.priority not in PRIORITIES:
        bad("Priority must be P1-P4")
    if body.defense is not None and body.defense not in ("busy", "free"):
        bad("defense must be 'busy' or 'free'")
    d0 = parse_date(body.date)
    s = parse_hm(body.start)
    dur = clamp(body.duration, 5, 480, 50)
    check_fit(s, dur)
    reps = clamp(body.repeat_weeks, 0, 15, 0)
    added = []
    for i in range(reps + 1):
        ds = (d0 + timedelta(days=7 * i)).isoformat()
        blk = make_block(title, body.type, ds, s, dur, doc["settings"], subject=body.subject,
                         topic=body.topic, priority=body.priority, locked=body.locked,
                         defense=body.defense)
        plan["blocks"].append(blk)
        added.append(blk["id"])
    save(doc, "plans")
    out = plan_payload(doc, plan)
    out["added"] = added
    return out


@app.put("/api/plans/{pid}/blocks/{bid}")
def update_block(pid: str, bid: str, body: BlockPatch, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    b = find_block(plan, bid)
    p = body.model_dump(exclude_none=True)
    if "title" in p:
        t = p["title"].strip()
        if not t:
            bad("Title cannot be empty")
        b["title"] = t[:120]
    if "subject" in p:
        b["subject"] = p["subject"].strip()[:60]
    if "topic" in p:
        b["topic"] = p["topic"].strip()[:120]
    if "priority" in p:
        if p["priority"] not in PRIORITIES:
            bad("Priority must be P1-P4")
        b["priority"] = p["priority"]
    if "defense" in p:
        if p["defense"] not in ("busy", "free"):
            bad("defense must be 'busy' or 'free'")
        b["defense"] = p["defense"]
    if "locked" in p:
        b["locked"] = bool(p["locked"])
    timing = False
    if "date" in p:
        b["date"] = parse_date(p["date"]).isoformat()
        timing = True
    if "start" in p:
        b["start"] = min_to_hm(parse_hm(p["start"]))
        timing = True
    if "duration" in p:
        b["duration"] = clamp(p["duration"], 5, 480, b["duration"])
        timing = True
    if timing:
        check_fit(parse_hm(b["start"]), int(b["duration"]))
        if b["type"] == "habit":
            b["manual"] = True
    save(doc, "plans")
    return plan_payload(doc, plan)


@app.delete("/api/plans/{pid}/blocks/{bid}")
def delete_block(pid: str, bid: str, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    b = find_block(plan, bid)
    if b["type"] == "habit":
        skips = doc["habit_skips"]
        if bid not in skips:
            skips.append(bid)
        doc["habit_skips"] = skips[-400:]
    plan["blocks"] = [x for x in plan["blocks"] if x["id"] != bid]
    save(doc, "plans", "habit_skips")
    return plan_payload(doc, plan)


@app.post("/api/plans/{pid}/blocks/{bid}/done")
def mark_done(pid: str, bid: str, body: DoneIn, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    b = find_block(plan, bid)
    today_s = today_or_default(body.today).isoformat()
    dur = int(b["duration"])
    if body.done and not b.get("done"):
        b["done"] = True
        b["done_date"] = today_s
        log_minutes(doc, today_s, dur, "study")
        bump_streak(doc, today_s)
    elif not body.done and b.get("done"):
        b["done"] = False
        log_minutes(doc, b.get("done_date") or today_s, -dur, "study")
        b.pop("done_date", None)
    save(doc, "plans", "activity", "streak", "last_done_date")
    out = plan_payload(doc, plan)
    out["streak"] = streak_now(doc, today_s)
    out["weekly_minutes"] = week_minutes(doc, today_or_default(today_s))
    return out


# --------------------------------------------------------------------------
# Rebalance (preview + apply)
# --------------------------------------------------------------------------
def is_movable(b: Dict[str, Any]) -> bool:
    return b["type"] in ("task", "focus") and not b.get("locked") and not b.get("done")


@app.post("/api/plans/{pid}/rebalance/preview")
def rebalance_preview(pid: str, body: RebalanceIn, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    st = doc["settings"]
    today = parse_date(body.today)
    blocks = plan["blocks"]
    movable = [b for b in blocks if is_movable(b)]
    mids = {b["id"] for b in movable}
    kept = [b for b in blocks if b["id"] not in mids]
    last = max([parse_date(b["date"]) for b in blocks] + [today])
    num_days = min(60, max(14, (last - today).days + 8))
    items = []
    for b in movable:
        pref = max(0, (parse_date(b["date"]) - today).days)
        items.append({"id": b["id"], "duration": int(b["duration"]), "pref": pref,
                      "key": (pref, prio_rank(b["priority"]), b["date"], b["start"])})
    items.sort(key=lambda i: i["key"])
    placed, unplaced = schedule(items, kept, today, num_days, st,
                                int(float(st["max_daily_hours"]) * 60),
                                now_min=body.now_min, wrap=False)
    pos = {it["id"]: (ds, t) for it, ds, t in placed}
    out_blocks, changed = [], []
    for b in blocks:
        nb = dict(b)
        if b["id"] in pos:
            ds, t = pos[b["id"]]
            nb["date"], nb["start"] = ds, min_to_hm(t)
            if ds != b["date"] or nb["start"] != b["start"]:
                changed.append(b["id"])
        out_blocks.append(nb)
    out_blocks.sort(key=lambda b: (b["date"], b["start"]))
    return {
        "blocks": out_blocks,
        "buffers": compute_buffers(out_blocks, int(st["buffer_min"])),
        "moves": [{"id": i, "date": pos[i][0], "start": min_to_hm(pos[i][1])} for i in changed],
        "changed": changed,
        "unplaced": [u["id"] for u in unplaced],
    }


@app.post("/api/plans/{pid}/rebalance/apply")
def rebalance_apply(pid: str, body: ApplyIn, doc=Depends(auth_user)):
    plan = get_plan(doc, pid)
    by_id = {b["id"]: b for b in plan["blocks"]}
    applied = 0
    for m in body.moves:
        b = by_id.get(m.id)
        if not b or not is_movable(b):
            continue
        ds = parse_date(m.date).isoformat()
        s = parse_hm(m.start)
        check_fit(s, int(b["duration"]))
        b["date"], b["start"] = ds, min_to_hm(s)
        applied += 1
    save(doc, "plans")
    out = plan_payload(doc, plan)
    out["applied"] = applied
    return out


# --------------------------------------------------------------------------
# Habits
# --------------------------------------------------------------------------
@app.get("/api/habits")
def list_habits(doc=Depends(auth_user)):
    return {"habits": doc["habits"]}


@app.post("/api/habits")
def create_habit(body: HabitIn, doc=Depends(auth_user)):
    if len(doc["habits"]) >= 15:
        bad("Maximum 15 habits")
    doc["habits"].append(clean_habit(body))
    sync_habits(doc, today_or_default(body.today))
    save(doc, "habits", "plans")
    return {"habits": doc["habits"]}


@app.put("/api/habits/{hid}")
def update_habit(hid: str, body: HabitIn, doc=Depends(auth_user)):
    for i, h in enumerate(doc["habits"]):
        if h["id"] == hid:
            doc["habits"][i] = clean_habit(body, hid)
            sync_habits(doc, today_or_default(body.today))
            save(doc, "habits", "plans")
            return {"habits": doc["habits"]}
    bad("Habit not found", 404)


@app.delete("/api/habits/{hid}")
def delete_habit(hid: str, today: Optional[str] = Query(None), doc=Depends(auth_user)):
    if hid not in [h["id"] for h in doc["habits"]]:
        bad("Habit not found", 404)
    doc["habits"] = [h for h in doc["habits"] if h["id"] != hid]
    sync_habits(doc, today_or_default(today))
    save(doc, "habits", "plans")
    return {"habits": doc["habits"]}


@app.post("/api/habits/sync")
def habits_sync(body: SyncIn, doc=Depends(auth_user)):
    sync_habits(doc, today_or_default(body.today))
    save(doc, "plans")
    plan = active_plan(doc)
    return plan_payload(doc, plan) if plan else {"plan": None, "blocks": [], "buffers": []}


# --------------------------------------------------------------------------
# Focus sessions
# --------------------------------------------------------------------------
@app.post("/api/focus")
def log_focus(body: FocusIn, doc=Depends(auth_user)):
    mins = clamp(body.minutes, 1, 240, 0)
    if mins < 1:
        bad("Minutes must be between 1 and 240")
    t = today_or_default(body.today)
    today_s = t.isoformat()
    log_minutes(doc, today_s, mins, "focus")
    bump_streak(doc, today_s)
    sessions = doc["focus_sessions"]
    sessions.append({"date": today_s, "minutes": mins, "subject": body.subject[:60],
                     "at": now_iso()})
    doc["focus_sessions"] = sessions[-200:]
    save(doc, "activity", "streak", "last_done_date", "focus_sessions")
    return {"logged": mins, "streak": streak_now(doc, today_s),
            "weekly_minutes": week_minutes(doc, t)}


# --------------------------------------------------------------------------
# Analytics
# --------------------------------------------------------------------------
@app.get("/api/analytics")
def analytics(today: Optional[str] = Query(None), doc=Depends(auth_user)):
    t = today_or_default(today)
    today_s = t.isoformat()
    st = doc["settings"]
    plan = active_plan(doc)
    blocks = plan["blocks"] if plan else []
    wk_start = t - timedelta(days=t.weekday())
    wk_days = {(wk_start + timedelta(days=i)).isoformat() for i in range(7)}
    defended = sum(int(b["duration"]) for b in blocks
                   if b["date"] in wk_days and b.get("defense") == "busy")
    cat = {"Focus": 0, "Tasks": 0, "Habits": 0, "Classes": 0}
    key = {"focus": "Focus", "task": "Tasks", "habit": "Habits", "fixed": "Classes"}
    subj = defaultdict(lambda: [0, 0])
    for b in blocks:
        cat[key.get(b["type"], "Tasks")] += int(b["duration"])
        if b["type"] in ("task", "focus"):
            s = b.get("subject") or "General"
            subj[s][0] += 1
            if b.get("done"):
                subj[s][1] += 1
    buffers = compute_buffers(blocks, int(st["buffer_min"]))
    cat["Buffers"] = sum(x["duration"] for x in buffers)
    labels = list(cat.keys())
    subjects = [{"subject": k, "total": v[0], "done": v[1],
                 "pct": round(100.0 * v[1] / v[0]) if v[0] else 0}
                for k, v in sorted(subj.items(), key=lambda kv: -kv[1][0])[:8]]
    goal_min = int(float(st["weekly_goal_hours"]) * 60)
    logged = week_minutes(doc, t)
    return {
        "streak": streak_now(doc, today_s),
        "weekly_goal_hours": st["weekly_goal_hours"],
        "weekly_logged_minutes": logged,
        "weekly_progress_pct": min(100, round(100.0 * logged / goal_min)) if goal_min else 0,
        "defended_minutes": defended,
        "defended_hours": round(defended / 60.0, 1),
        "allocation": {"labels": labels, "hours": [round(cat[l] / 60.0, 1) for l in labels]},
        "subjects": subjects,
        "tasks_done": sum(1 for b in blocks if b["type"] in ("task", "focus") and b.get("done")),
        "tasks_total": sum(1 for b in blocks if b["type"] in ("task", "focus")),
    }


# --------------------------------------------------------------------------
# AI: notes, quiz, weak topics
# --------------------------------------------------------------------------
@app.post("/api/ai/notes")
def ai_notes(body: NotesIn, doc=Depends(auth_user)):
    topic = body.topic.strip()
    if not topic:
        bad("Topic is required")
    block = None
    plan = None
    if body.plan_id and body.block_id:
        plan = get_plan(doc, body.plan_id)
        block = find_block(plan, body.block_id)
        if block.get("notes") and not body.refresh:
            return {"notes": block["notes"], "cached": True}
    system = ("You are a concise, accurate study tutor. Write clear Markdown study notes: "
              "a short overview, key concepts as bullets, one worked example, common mistakes, "
              "and a 3-line quick recap. Use fenced code blocks for code. Keep under 450 words.")
    user = "Subject: %s\nTopic: %s\nWrite revision notes for a student." % (
        body.subject.strip() or "General", topic)
    txt = llm([{"role": "system", "content": system}, {"role": "user", "content": user}],
              temperature=0.4, max_tokens=4096)
    if block is not None and plan is not None:
        block["notes"] = txt[:6000]
        save(doc, "plans")
    return {"notes": txt, "cached": False}


@app.post("/api/ai/quiz")
def ai_quiz(body: QuizIn, doc=Depends(auth_user)):
    topic = body.topic.strip()
    if not topic:
        bad("Topic is required")
    system = "You write quiz questions. Reply with ONE JSON object only, no prose."
    user = (
        "Subject: %s\nTopic: %s\nWrite exactly 3 multiple-choice questions of increasing "
        "difficulty. Each has exactly 4 options and one correct answer.\n"
        'JSON shape: {"questions": [{"q": "...", "options": ["A","B","C","D"], '
        '"answer": 0, "explanation": "one or two sentences"}]} where answer is the '
        "0-based index of the correct option." % (body.subject.strip() or "General", topic)
    )
    txt = llm([{"role": "system", "content": system}, {"role": "user", "content": user}],
              json_mode=True, temperature=0.5)
    data = parse_json(txt)
    raw = data.get("questions") if isinstance(data, dict) else data
    qs = []
    if isinstance(raw, list):
        for q in raw:
            if not isinstance(q, dict):
                continue
            opts = q.get("options")
            if not isinstance(opts, list) or len(opts) != 4:
                continue
            ans = q.get("answer")
            if isinstance(ans, str):
                a = ans.strip().upper()[:1]
                ans = "ABCD".find(a) if a in "ABCD" and a else -1
            if not isinstance(ans, int) or not 0 <= ans <= 3:
                continue
            qs.append({"q": str(q.get("q", "")).strip()[:400],
                       "options": [str(o)[:200] for o in opts],
                       "answer": ans,
                       "explanation": str(q.get("explanation", ""))[:400]})
    qs = [q for q in qs if q["q"]][:3]
    if len(qs) < 3:
        bad("AI could not build a full quiz. Please try again.", 502)
    return {"topic": topic, "questions": qs}


@app.post("/api/quiz/result")
def quiz_result(body: QuizResultIn, doc=Depends(auth_user)):
    topic = body.topic.strip()[:120]
    if not topic:
        bad("Topic is required")
    total = clamp(body.total, 1, 20, 3)
    score = clamp(body.score, 0, total, 0)
    weak = [w for w in doc["weak_topics"] if w.get("topic", "").lower() != topic.lower()]
    if score < total:
        weak.append({"topic": topic, "subject": body.subject.strip()[:60],
                     "last_score": "%d/%d" % (score, total), "updated": now_iso()})
    doc["weak_topics"] = weak[-30:]
    save(doc, "weak_topics")
    return {"weak_topics": doc["weak_topics"]}


@app.get("/api/weak-topics")
def weak_topics(doc=Depends(auth_user)):
    return {"weak_topics": doc["weak_topics"]}


# --------------------------------------------------------------------------
# PulseBot
# --------------------------------------------------------------------------
def build_context(doc, today_s: str, now_hm: Optional[str]) -> str:
    t = today_or_default(today_s)
    st = doc["settings"]
    plan = active_plan(doc)
    lines = [
        "Student: %s" % doc["username"],
        "Today: %s%s" % (t.isoformat(), (" " + now_hm) if now_hm else ""),
        "Streak: %d days" % streak_now(doc, t.isoformat()),
        "Weekly focus goal: %.1f h, logged so far: %.1f h" % (
            float(st["weekly_goal_hours"]), week_minutes(doc, t) / 60.0),
        "Study window: %s-%s, buffer %d min, defense mode: %s" % (
            st["study_start"], st["study_end"], st["buffer_min"], st["defense_mode"]),
    ]
    if plan:
        lines.append("Active plan: " + plan.get("name", "Plan"))
        today_blocks = sorted([b for b in plan["blocks"] if b["date"] == t.isoformat()],
                              key=lambda b: b["start"])
        if today_blocks:
            lines.append("Today's schedule:")
            for b in today_blocks[:15]:
                end = min_to_hm(parse_hm(b["start"]) + int(b["duration"]))
                flags = [b["type"], b["priority"]]
                if b.get("locked"):
                    flags.append("locked")
                if b.get("done"):
                    flags.append("done")
                lines.append("- %s-%s %s [%s]" % (b["start"], end, b["title"], ", ".join(flags)))
        else:
            lines.append("Nothing scheduled today.")
        week_end = (t + timedelta(days=7)).isoformat()
        pending = [b for b in plan["blocks"]
                   if b["type"] in ("task", "focus") and not b.get("done")
                   and t.isoformat() <= b["date"] <= week_end]
        lines.append("Pending study blocks in next 7 days: %d" % len(pending))
        locked = sorted([b for b in plan["blocks"]
                         if b.get("locked") and b["date"] >= t.isoformat()],
                        key=lambda b: (b["date"], b["start"]))[:8]
        if locked:
            lines.append("Upcoming locked blocks: " + "; ".join(
                "%s %s %s" % (b["date"], b["start"], b["title"]) for b in locked))
    else:
        lines.append("No study plan yet.")
    if doc["weak_topics"]:
        lines.append("Weak topics: " + ", ".join(
            "%s (%s)" % (w["topic"], w.get("last_score", "")) for w in doc["weak_topics"][-8:]))
    if doc["habits"]:
        lines.append("Habits: " + ", ".join(h["name"] for h in doc["habits"]))
    return "\n".join(lines)


@app.get("/api/chat")
def chat_history(doc=Depends(auth_user)):
    return {"messages": doc["chat"][-60:]}


@app.delete("/api/chat")
def chat_clear(doc=Depends(auth_user)):
    doc["chat"] = []
    save(doc, "chat")
    return {"ok": True, "messages": []}


@app.post("/api/chat")
def chat(body: ChatIn, doc=Depends(auth_user)):
    msg = body.message.strip()
    if not msg:
        bad("Message is empty")
    msg = msg[:2000]
    t = today_or_default(body.today).isoformat()
    system = (
        "You are PulseBot, the exclusive AI study coach inside LearnPulse OS, built by "
        "Viswesh & Team, Dept of CSE. Be warm, concise and practical. Format with Markdown "
        "(short lists, **bold**, fenced code blocks for code). Ground your advice in the "
        "student context below. You cannot edit the calendar yourself; when a schedule change "
        "is needed, tell the student to tap the block (inspector) or use AI Rebalance. "
        "If you do not know something, say so.\n\n--- STUDENT CONTEXT ---\n"
        + build_context(doc, t, body.now)
    )
    history = [{"role": m["role"], "content": m["content"]}
               for m in doc["chat"][-12:] if m.get("role") in ("user", "assistant")]
    reply = llm([{"role": "system", "content": system}] + history +
                [{"role": "user", "content": msg}], temperature=0.6, max_tokens=4096)
    stamp = now_iso()
    doc["chat"].append({"role": "user", "content": msg, "ts": stamp})
    doc["chat"].append({"role": "assistant", "content": reply, "ts": now_iso()})
    doc["chat"] = doc["chat"][-60:]
    save(doc, "chat")
    return {"reply": reply, "messages": doc["chat"][-60:]}