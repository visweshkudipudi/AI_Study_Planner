import os
import threading
from datetime import datetime, timezone
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

ASK_NAME, ASK_CLASS, ASK_STUDYING = range(3)


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
# 3. Safe Database Helper Functions
# ==========================================
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
    today = datetime.now(timezone.utc).date()
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


# ==========================================
# 4. Onboarding Conversation (/start & /setup)
# ==========================================
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
                "<b>Commands:</b>\n"
                "• <code>/addevent 2026-12-05 | C Programming Mid Exam</code> — Save exam/deadline\n"
                "• <code>/calendar</code> — View saved calendar & countdown\n"
                "• <code>/delevent 1</code> — Delete event #1\n"
                "• <code>/plan DBMS:5:4, OS:3:7 | 4</code> — Weighted timetable\n"
                "• <code>/profile</code> — View saved profile\n"
                "• <code>/setup</code> — Update name, class & subjects",
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
            "✅ <b>Profile Saved Permanently in MongoDB Cloud!</b>\n\n"
            f"👤 <b>Name:</b> {name}\n"
            f"🎓 <b>Class:</b> {user_class}\n"
            f"📚 <b>Studying:</b> {studying}\n\n"
            "Try saving an exam date next:\n"
            "<code>/addevent 2026-12-05 | C Programming Mid Exam</code>",
            parse_mode="HTML",
        )
    else:
        await update.message.reply_text(
            f"⚠️ <b>MongoDB Save Failed:</b>\n<code>{err}</code>",
            parse_mode="HTML",
        )
    return ConversationHandler.END


async def cancel_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Setup cancelled. Type /setup anytime.")
    return ConversationHandler.END


# ==========================================
# 5. Cloud Calendar Commands (/addevent, /calendar, /delevent)
# ==========================================
async def add_event(update: Update, context: ContextTypes.DEFAULT_TYPE):
    raw = " ".join(context.args).strip()
    if "|" not in raw:
        await update.message.reply_text(
            "⚠️ <b>Format:</b> <code>/addevent YYYY-MM-DD | Event Title</code>\n"
            "<i>Example:</i> <code>/addevent 2026-12-05 | Linear Algebra Mid Exam</code>",
            parse_mode="HTML",
        )
        return

    date_str, title = [part.strip() for part in raw.split("|", 1)]
    try:
        datetime.strptime(date_str, "%Y-%m-%d")
    except ValueError:
        await update.message.reply_text(
            "⚠️ Invalid date format. Use <b>YYYY-MM-DD</b> (e.g., <code>2026-12-05</code>).",
            parse_mode="HTML",
        )
        return

    if not title:
        await update.message.reply_text("⚠️ Please provide an event name after <code>|</code>.", parse_mode="HTML")
        return

    try:
        events_col.insert_one(
            {
                "user_id": update.effective_user.id,
                "date": date_str,
                "title": title,
            }
        )
        await update.message.reply_text(
            "📅 <b>Saved to Cloud Calendar!</b>\n"
            f"🗓️ <b>Date:</b> {date_str}\n"
            f"📌 <b>Event:</b> {title}\n\n"
            "Type <code>/calendar</code> anytime to view all your dates.",
            parse_mode="HTML",
        )
    except Exception as e:
        await update.message.reply_text(f"❌ <b>Calendar Save Error:</b>\n<code>{e}</code>", parse_mode="HTML")


async def view_calendar(update: Update, context: ContextTypes.DEFAULT_TYPE):
    events = get_user_events(update.effective_user.id)
    if not events:
        await update.message.reply_text(
            "📅 <b>Your Cloud Calendar is empty!</b>\n\n"
            "Add your first exam or deadline with:\n"
            "<code>/addevent 2026-12-05 | C Programming Lab Exam</code>",
            parse_mode="HTML",
        )
        return

    today = datetime.now(timezone.utc).date()
    lines = ["📅 <b>Your Saved Cloud Calendar:</b>\n"]
    for idx, ev in enumerate(events, start=1):
        ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        days_left = (ev_date - today).days
        if days_left == 0:
            badge = "🔥 <b>TODAY</b>"
        elif days_left > 0:
            badge = f"⏳ <i>{days_left} days left</i>"
        else:
            badge = f"✅ <i>{abs(days_left)} days ago</i>"
        lines.append(f"<b>{idx}.</b> <code>{ev['date']}</code> — {ev['title']} ({badge})")

    lines.append("\n<i>Tip: Use</i> <code>/delevent 1</code> <i>to remove an event.</i>")
    await update.message.reply_text("\n".join(lines), parse_mode="HTML")


async def delete_event(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args or not context.args[0].isdigit():
        await update.message.reply_text(
            "⚠️ Usage: <code>/delevent 1</code> (check numbers using <code>/calendar</code>)",
            parse_mode="HTML",
        )
        return

    index = int(context.args[0]) - 1
    events = get_user_events(update.effective_user.id)
    if index < 0 or index >= len(events):
        await update.message.reply_text("⚠️ Invalid event number. Run <code>/calendar</code> to check.", parse_mode="HTML")
        return

    target = events[index]
    try:
        events_col.delete_one({"_id": target["_id"]})
        await update.message.reply_text(
            f"🗑️ Removed: <b>{target['title']}</b> (<code>{target['date']}</code>)",
            parse_mode="HTML",
        )
    except Exception as e:
        await update.message.reply_text(f"❌ Error deleting event: <code>{e}</code>", parse_mode="HTML")


# ==========================================
# 6. Diagnostic, Profile & AI Study Commands
# ==========================================
async def db_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        mongo_client.admin.command("ping")
        await update.message.reply_text(
            "✅ <b>MongoDB Cloud Connected!</b> Profile & Calendar storage active.",
            parse_mode="HTML",
        )
    except Exception as e:
        await update.message.reply_text(
            f"❌ <b>MongoDB Error:</b>\n<code>{e}</code>",
            parse_mode="HTML",
        )


async def view_profile(update: Update, context: ContextTypes.DEFAULT_TYPE):
    profile = get_user_profile(update.effective_user.id)
    if not profile:
        await update.message.reply_text("No profile found yet! Send /setup to save your details.")
        return

    await update.message.reply_text(
        "🪪 <b>Your Saved LearnPulse Profile:</b>\n\n"
        f"👤 <b>Name:</b> {profile['name']}\n"
        f"🎓 <b>Class:</b> {profile['class']}\n"
        f"📚 <b>Studying:</b> {profile['studying']}",
        parse_mode="HTML",
    )


def calculate_weights(subjects_raw: str) -> dict:
    items = []
    for entry in subjects_raw.split(","):
        parts = [p.strip() for p in entry.split(":")]
        if len(parts) == 3:
            name, diff, days = parts[0], float(parts[1]), max(int(parts[2]), 1)
            items.append({"name": name, "score": diff / days})
    total = sum(i["score"] for i in items) or 1
    return {i["name"]: round((i["score"] / total) * 100, 1) for i in items}


async def generate_plan_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = " ".join(context.args)
    if "|" not in text:
        await update.message.reply_text(
            "⚠️ Example:\n<code>/plan DBMS:5:4, OS:3:7, Maths:4:10 | 4</code>",
            parse_mode="HTML",
        )
        return

    user_id = update.effective_user.id
    profile = get_user_profile(user_id)
    events = get_user_events(user_id)

    student_context = (
        f"Student Name: {profile['name']}, Class: {profile['class']}, Subjects: {profile['studying']}."
        if profile
        else "Student profile not set yet."
    )
    calendar_context = format_events_summary(events)

    status_msg = await update.message.reply_text("⚡ Generating personalized schedule...")

    try:
        subjects_part, hours_part = text.split("|", 1)
        daily_hours = int(hours_part.strip())
        weights = calculate_weights(subjects_part)

        prompt = f"""
        Act as an academic coach for LearnPulse OS.
        {student_context}
        Upcoming Saved Calendar Events:
        {calendar_context}
        Subject priority weights: {weights}
        Daily study capacity: {daily_hours} hours (reserve 1 hour daily for revision).

        Formatting rules (STRICT):
        - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
        - NEVER use &nbsp;, Markdown (** or ###), or LaTeX ($...$). Use plain spaces and normal text.
        - Keep under 3500 characters.
        """

        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
        )
        clean_reply = resp.choices[0].message.content.replace("&nbsp;", " ")
        await status_msg.edit_text(clean_reply, parse_mode="HTML")
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {e}")


async def handle_natural_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    user_text = update.message.text
    profile = get_user_profile(user_id)
    events = get_user_events(user_id)

    student_context = (
        f"Name: {profile['name']}, Class: {profile['class']}, Studying: {profile['studying']}"
        if profile
        else "Profile not set yet (remind user they can run /setup)."
    )
    calendar_context = format_events_summary(events)

    status_msg = await update.message.reply_text("⚡ Thinking...")

    prompt = f"""
    You are LearnPulse OS 2.0 (by Viswesh and team | Dept of CSE), an AI Study Planner & Tutor.
    Student Profile: {student_context}
    Upcoming Saved Calendar Events:
    {calendar_context}
    User message: "{user_text}"

    Formatting rules (STRICT):
    - Personalize using the student's name, class, subjects, and upcoming calendar dates naturally.
    - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
    - NEVER use &nbsp;, Markdown (** or ###), or LaTeX ($...$). Use plain spaces and normal text.
    - Keep under 3500 characters.
    """
    try:
        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
        )
        clean_reply = resp.choices[0].message.content.replace("&nbsp;", " ")
        await status_msg.edit_text(clean_reply, parse_mode="HTML")
    except Exception as e:
        await status_msg.edit_text(f"❌ Error: {e}")


# ==========================================
# 7. Main Entry Point
# ==========================================
def main():
    threading.Thread(target=start_health_server, daemon=True).start()

    app = Application.builder().token(TELEGRAM_TOKEN).build()

    onboarding_conv = ConversationHandler(
        entry_points=[
            CommandHandler("start", start_or_setup),
            CommandHandler("setup", start_or_setup),
        ],
        states={
            ASK_NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_name)],
            ASK_CLASS: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_class)],
            ASK_STUDYING: [MessageHandler(filters.TEXT & ~filters.COMMAND, receive_studying)],
        },
        fallbacks=[CommandHandler("cancel", cancel_setup)],
    )

    app.add_handler(onboarding_conv)
    app.add_handler(CommandHandler("addevent", add_event))
    app.add_handler(CommandHandler("calendar", view_calendar))
    app.add_handler(CommandHandler("delevent", delete_event))
    app.add_handler(CommandHandler("dbcheck", db_check))
    app.add_handler(CommandHandler("profile", view_profile))
    app.add_handler(CommandHandler("plan", generate_plan_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_natural_message))

    print("🤖 LearnPulse OS 2.0 with Cloud Calendar is running...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
