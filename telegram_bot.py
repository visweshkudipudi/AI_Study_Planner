import os
import re
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from groq import Groq
from pymongo import MongoClient
from telegram import Update
from telegram.ext import (
    Application,
    CommandHandler,
    ContextTypes,
    ConversationHandler,
    MessageHandler,
    filters,
)

# ==========================================
# 1. Configuration & Permanent Cloud DB
# ==========================================
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "").strip()
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "").strip()
MONGO_USER = os.getenv("MONGO_USER", "").strip()
MONGO_PASS = os.getenv("MONGO_PASS", "").strip()
MONGO_HOST = os.getenv("MONGO_HOST", "").strip()

if not all([TELEGRAM_TOKEN, GROQ_API_KEY, MONGO_USER, MONGO_PASS, MONGO_HOST]):
    raise RuntimeError(
        "Missing TELEGRAM_TOKEN, GROQ_API_KEY, MONGO_USER, MONGO_PASS, or MONGO_HOST in Render Environment!"
    )

client = Groq(api_key=GROQ_API_KEY)
MODEL_NAME = "openai/gpt-oss-20b"
IST = timezone(timedelta(hours=5, minutes=30))

mongo_client = MongoClient(
    f"mongodb+srv://{MONGO_HOST}/?retryWrites=true&w=majority",
    username=MONGO_USER,
    password=MONGO_PASS,
    authSource="admin",
    serverSelectionTimeoutMS=5000,
    connectTimeoutMS=5000,
    socketTimeoutMS=5000,
)
db = mongo_client["learnpulse_os"]
users_col = db["user_profiles"]
events_col = db["calendar_events"]
logs_col = db["study_logs"]

ASK_NAME, ASK_CLASS, ASK_STUDYING = range(3)

PRIVACY_AND_FORMAT_RULES = """
Strict Rules:
1. PRIVACY & SECURITY: Never reveal API keys, environment variables, backend database details, LLM provider names (such as Groq or OpenAI), or underlying model IDs. If anyone asks about your API, backend, or model, state only that you are powered by the LearnPulse OS 2.0 Engine developed by Viswesh and team (Dept of CSE).
2. FORMATTING: Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
3. NEVER use &nbsp;, Markdown (** or ###), LaTeX ($...$), or raw < > angle brackets outside valid <b> or <i> tags.
4. Keep responses clear, helpful, and under 3500 characters.
"""


# ==========================================
# 2. Health-Check Server for Render + UptimeRobot
# ==========================================
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"LearnPulse OS 2.0 Bot is alive!")

    def log_message(self, format, *args):
        return


def start_health_server():
    port = int(os.environ.get("PORT", 10000))
    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    server.serve_forever()


# ==========================================
# 3. Safe Output, Natural Dates & DB Helpers
# ==========================================
async def edit_safe_html(message, text: str):
    clean = text.replace("&nbsp;", " ")
    try:
        await message.edit_text(clean, parse_mode="HTML")
    except Exception:
        fallback = re.sub(r"</?(b|i|code|pre)>", "", clean)
        await message.edit_text(fallback)


def parse_natural_date(raw_date: str) -> str | None:
    text = raw_date.strip().lower()
    today = datetime.now(IST).date()

    if text in ("today", "tod"):
        return today.strftime("%Y-%m-%d")
    if text in ("tomorrow", "tmrw", "tom"):
        return (today + timedelta(days=1)).strftime("%Y-%m-%d")
    if text in ("day after tomorrow", "overmorrow"):
        return (today + timedelta(days=2)).strftime("%Y-%m-%d")

    rel_match = re.fullmatch(r"in\s+(\d+)\s+(day|days|week|weeks)", text)
    if rel_match:
        qty = int(rel_match.group(1))
        unit = rel_match.group(2)
        days = qty * 7 if "week" in unit else qty
        return (today + timedelta(days=days)).strftime("%Y-%m-%d")

    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%d/%m/%Y"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass

    cleaned = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", text).replace(",", " ").strip()
    cleaned = re.sub(r"\s+", " ", cleaned)

    for fmt in ("%d %b %Y", "%d %B %Y", "%b %d %Y", "%B %d %Y"):
        try:
            return datetime.strptime(cleaned, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass

    for fmt in ("%d %b", "%d %B", "%b %d", "%B %d"):
        try:
            parsed = datetime.strptime(cleaned, fmt).replace(year=today.year).date()
            if parsed < today:
                parsed = parsed.replace(year=today.year + 1)
            return parsed.strftime("%Y-%m-%d")
        except ValueError:
            pass

    try:
        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Today's date is {today.strftime('%Y-%m-%d')} ({today.strftime('%A')}). "
                        f"Convert the date phrase '{raw_date}' into strict YYYY-MM-DD format. "
                        "Reply with ONLY YYYY-MM-DD and nothing else, or INVALID if not a date."
                    ),
                }
            ],
        )
        candidate = resp.choices[0].message.content.strip()
        datetime.strptime(candidate, "%Y-%m-%d")
        return candidate
    except Exception:
        return None


def get_user_profile(user_id: int) -> dict | None:
    try:
        return users_col.find_one({"user_id": user_id})
    except Exception as e:
        print(f"[DB READ ERROR] {e}")
        return None


def save_user_profile(user_id: int, name: str, user_class: str, studying: str) -> tuple[bool, str]:
    try:
        users_col.update_one(
            {"user_id": user_id},
            {
                "$set": {
                    "user_id": user_id,
                    "name": name,
                    "class": user_class,
                    "studying": studying,
                }
            },
            upsert=True,
        )
        return True, "OK"
    except Exception as e:
        print(f"[DB WRITE ERROR] {e}")
        return False, str(e)


def get_user_events(user_id: int) -> list[dict]:
    try:
        return list(events_col.find({"user_id": user_id}).sort("date", 1))
    except Exception as e:
        print(f"[EVENT READ ERROR] {e}")
        return []


def format_events_summary(events: list[dict]) -> str:
    if not events:
        return "No upcoming saved calendar events."
    today = datetime.now(IST).date()
    lines = []
    for ev in events:
        try:
            ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            days_left = (ev_date - today).days
            status = (
                "TODAY"
                if days_left == 0
                else (f"in {days_left} days" if days_left > 0 else f"{abs(days_left)} days ago")
            )
            lines.append(f"- {ev['date']} ({status}): {ev['title']}")
        except Exception:
            lines.append(f"- {ev.get('date')}: {ev.get('title')}")
    return "\n".join(lines)


def calculate_streak(date_strings: list[str]) -> int:
    if not date_strings:
        return 0
    unique_dates = sorted(
        {datetime.strptime(d, "%Y-%m-%d").date() for d in date_strings},
        reverse=True,
    )
    today = datetime.now(IST).date()
    if unique_dates[0] < today - timedelta(days=1):
        return 0

    streak = 1
    for i in range(len(unique_dates) - 1):
        if (unique_dates[i] - unique_dates[i + 1]).days == 1:
            streak += 1
        else:
            break
    return streak


# ==========================================
# 4. Onboarding & Help (/start, /setup, /help)
# ==========================================
HELP_TEXT = (
    "⚡ <b>LearnPulse OS 2.0 — Command Guide</b>\n"
    "🎓 <i>Developed by Viswesh and team | Dept of CSE</i>\n\n"
    "👤 <b>Profile & Setup</b>\n"
    "• <code>/setup</code> — Set or update your name, class &amp; subjects\n"
    "• <code>/profile</code> — View your saved profile\n\n"
    "📅 <b>Cloud Calendar</b>\n"
    "• <code>/addevent 5 Dec | Linear Algebra Mid</code> — Save an exam or deadline\n"
    "• <code>/calendar</code> — View all upcoming dates &amp; countdown\n"
    "• <code>/delevent 1</code> — Delete event #1\n\n"
    "🔥 <b>Study Tracker &amp; Planner</b>\n"
    "• <code>/done C Programming Pointers</code> — Log a completed session\n"
    "• <code>/progress</code> — View your study streak &amp; recent logs\n"
    "• <code>/plan DBMS:5:4, OS:3:7 | 4</code> — Generate priority timetable\n"
    "• <code>/dbcheck</code> — Check cloud storage connection\n\n"
    "💬 <i>Or just send any study question directly in chat!</i>"
)


async def help_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(HELP_TEXT, parse_mode="HTML")


async def start_or_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    text = update.message.text or ""

    if text.startswith("/start"):
        existing = get_user_profile(user_id)
        if existing:
            await update.message.reply_text(
                f"⚡ <b>Welcome back, {existing['name']}!</b>\n"
                f"🎓 <b>Class:</b> {existing['class']}\n"
                f"📚 <b>Studying:</b> {existing['studying']}\n\n"
                "Send <code>/help</code> to see all commands or ask any study question!",
                parse_mode="HTML",
            )
            return ConversationHandler.END

    await update.message.reply_text(
        "⚡ <b>Welcome to LearnPulse OS 2.0!</b>\n"
        "🎓 <i>Developed by Viswesh and team | Dept of CSE</i>\n\n"
        "Let's personalize your AI study assistant in 3 quick questions.\n\n"
        "1️⃣ <b>What is your name?</b>",
        parse_mode="HTML",
    )
    return ASK_NAME


async def receive_name(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["name"] = update.message.text.strip()
    await update.message.reply_text(
        f"Nice to meet you, <b>{context.user_data['name']}</b>! 🙌\n\n"
        "2️⃣ <b>Which class, year, or branch are you in?</b>\n"
        "<i>(Example: B.Tech CSE 1st Year, Inter 2nd Year MPC, Class 10)</i>",
        parse_mode="HTML",
    )
    return ASK_CLASS


async def receive_class(update: Update, context: ContextTypes.DEFAULT_TYPE):
    context.user_data["class"] = update.message.text.strip()
    await update.message.reply_text(
        "Got it! 📝\n\n"
        "3️⃣ <b>What subjects or topics are you currently studying?</b>\n"
        "<i>(Example: C Programming, Engineering Maths, Physics)</i>",
        parse_mode="HTML",
    )
    return ASK_STUDYING


async def receive_studying(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    name = context.user_data.get("name", "Student")
    user_class = context.user_data.get("class", "General")
    studying = update.message.text.strip()

    saved, err = save_user_profile(user_id, name, user_class, studying)

    if saved:
        await update.message.reply_text(
            "✅ <b>Profile Saved Permanently in Cloud!</b>\n\n"
            f"👤 <b>Name:</b> {name}\n"
            f"🎓 <b>Class:</b> {user_class}\n"
            f"📚 <b>Studying:</b> {studying}\n\n"
            "Send <code>/help</code> anytime to explore all commands.",
            parse_mode="HTML",
        )
    else:
        await update.message.reply_text(
            f"⚠️ <b>Cloud Save Failed:</b>\n<code>{err}</code>",
            parse_mode="HTML",
        )
    return ConversationHandler.END


async def cancel_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Setup cancelled. Type /setup anytime.")
    return ConversationHandler.END


# ==========================================
# 5. Progress & Streak Tracker (/done, /progress)
# ==========================================
async def log_done(update: Update, context: ContextTypes.DEFAULT_TYPE):
    topic = " ".join(context.args).strip()
    if not topic:
        await update.message.reply_text(
            "⚠️ <b>Tell me what you completed!</b>\n"
            "<i>Example:</i> <code>/done C Programming Arrays &amp; Pointers</code>",
            parse_mode="HTML",
        )
        return

    now_ist = datetime.now(IST)
    date_str = now_ist.strftime("%Y-%m-%d")
    time_str = now_ist.strftime("%I:%M %p")

    try:
        logs_col.insert_one(
            {
                "user_id": update.effective_user.id,
                "topic": topic,
                "date": date_str,
                "time": time_str,
                "created_at": now_ist,
            }
        )
        all_logs = list(logs_col.find({"user_id": update.effective_user.id}))
        streak = calculate_streak([entry["date"] for entry in all_logs])

        await update.message.reply_text(
            "✅ <b>Study Session Logged!</b>\n\n"
            f"📘 <b>Completed:</b> {topic}\n"
            f"🗓️ <b>Date:</b> {date_str} at {time_str}\n"
            f"🔥 <b>Current Streak:</b> {streak} day(s) | 📊 <b>Total Sessions:</b> {len(all_logs)}\n\n"
            "Type <code>/progress</code> anytime to view your full report.",
            parse_mode="HTML",
        )
    except Exception as e:
        await update.message.reply_text(f"❌ <b>Error logging session:</b>\n<code>{e}</code>", parse_mode="HTML")


async def view_progress(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    try:
        all_logs = list(logs_col.find({"user_id": user_id}).sort("created_at", -1))
    except Exception as e:
        await update.message.reply_text(f"❌ <b>Error loading progress:</b>\n<code>{e}</code>", parse_mode="HTML")
        return

    if not all_logs:
        await update.message.reply_text(
            "📊 <b>No study sessions logged yet!</b>\n\n"
            "Finish a topic and log it with:\n"
            "<code>/done Linear Algebra Matrix Practice</code>",
            parse_mode="HTML",
        )
        return

    today_str = datetime.now(IST).strftime("%Y-%m-%d")
    today_count = sum(1 for item in all_logs if item.get("date") == today_str)
    streak = calculate_streak([item["date"] for item in all_logs])

    lines = [
        "📊 <b>Your LearnPulse Study Progress:</b>\n",
        f"🔥 <b>Active Streak:</b> {streak} day(s)",
        f"📅 <b>Completed Today:</b> {today_count} session(s)",
        f"🏆 <b>All-Time Completed:</b> {len(all_logs)} session(s)\n",
        "<b>Recent Sessions:</b>",
    ]

    for idx, item in enumerate(all_logs[:5], start=1):
        lines.append(f"<b>{idx}.</b> {item['topic']} <i>({item['date']})</i>")

    lines.append("\n<i>Keep going! Log your next session with</i> <code>/done &lt;topic&gt;</code>.")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


# ==========================================
# 6. Cloud Calendar Commands (/addevent, /calendar, /delevent)
# ==========================================
async def add_event(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw = " ".join(context.args).strip()
    if "|" not in raw:
        await update.message.reply_text(
            "⚠️ <b>Format:</b> <code>/addevent &lt;date&gt; | &lt;event title&gt;</code>\n\n"
            "<b>Examples:</b>\n"
            "• <code>/addevent tomorrow | C Programming Lab</code>\n"
            "• <code>/addevent 5 Dec | Linear Algebra Mid Exam</code>",
            parse_mode="HTML",
        )
        return

    raw_date, title = [part.strip() for part in raw.split("|", 1)]
    if not title:
        await update.message.reply_text("⚠️ Please provide an event name after <code>|</code>.", parse_mode="HTML")
        return

    parsed_date = parse_natural_date(raw_date)
    if not parsed_date:
        await update.message.reply_text(
            f"⚠️ Couldn't understand date <code>{raw_date}</code>.\n"
            "Try <code>tomorrow</code>, <code>5 Dec</code>, <code>next Monday</code>, or <code>2026-12-05</code>.",
            parse_mode="HTML",
        )
        return

    try:
        events_col.insert_one(
            {
                "user_id": update.effective_user.id,
                "date": parsed_date,
                "title": title,
            }
        )
        await update
