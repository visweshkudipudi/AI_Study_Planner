import os
import threading
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
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
MONGO_URI = os.getenv("MONGO_URI")

if not TELEGRAM_TOKEN or not GROQ_API_KEY or not MONGO_URI:
    raise RuntimeError(
        "Missing TELEGRAM_TOKEN, GROQ_API_KEY, or MONGO_URI in Render Environment!"
    )

client = Groq(api_key=GROQ_API_KEY)
MODEL_NAME = "openai/gpt-oss-20b"

# Fast 3-second timeout so bot NEVER freezes silently if DB has an issue
mongo_client = MongoClient(
    MONGO_URI,
    serverSelectionTimeoutMS=3000,
    connectTimeoutMS=3000,
    socketTimeoutMS=3000,
)
db = mongo_client["learnpulse_os"]
users_col = db["user_profiles"]

ASK_NAME, ASK_CLASS, ASK_STUDYING = range(3)


# ==========================================
# 2. Health-Check Server for Render + UptimeRobot
# ==========================================
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"LearnPulse OS 2.0 Bot is alive!")


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
                "• <code>/plan DBMS:5:4, OS:3:7 | 4</code> — Weighted timetable\n"
                "• <code>/profile</code> — View saved profile\n"
                "• <code>/setup</code> — Update name, class & subjects\n"
                "• <code>/dbcheck</code> — Test MongoDB cloud connection",
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
            "Now ask me anything like:\n"
            "<i>\"Create a 3-hour evening study plan for my subjects\"</i>",
            parse_mode="HTML",
        )
    else:
        await update.message.reply_text(
            f"⚠️ <b>MongoDB Save Failed:</b>\n<code>{err}</code>\n\n"
            "Check your <code>MONGO_URI</code> password and Network Access (0.0.0.0/0).",
            parse_mode="HTML",
        )
    return ConversationHandler.END


async def cancel_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Setup cancelled. Type /setup anytime.")
    return ConversationHandler.END


# ==========================================
# 5. Diagnostic, Profile & Study Commands
# ==========================================
async def db_check(update: Update, context: ContextTypes.DEFAULT_TYPE):
    try:
        mongo_client.admin.command("ping")
        await update.message.reply_text("✅ <b>MongoDB Cloud Connected!</b> Ping succeeded.", parse_mode="HTML")
    except Exception as e:
        await update.message.reply_text(f"❌ <b>MongoDB Error:</b>\n<code>{e}</code>", parse_mode="HTML")


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

    profile = get_user_profile(update.effective_user.id)
    student_context = (
        f"Student Name: {profile['name']}, Class: {profile['class']}, Subjects: {profile['studying']}."
        if profile
        else "Student profile not set yet."
    )

    status_msg = await update.message.reply_text("⚡ Generating personalized schedule...")

    try:
        subjects_part, hours_part = text.split("|", 1)
        daily_hours = int(hours_part.strip())
        weights = calculate_weights(subjects_part)

        prompt = f"""
        Act as an academic coach for LearnPulse OS.
        {student_context}
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
    user_text = update.message.text
    profile = get_user_profile(update.effective_user.id)

    student_context = (
        f"Name: {profile['name']}, Class: {profile['class']}, Studying: {profile['studying']}"
        if profile
        else "Profile not set yet (remind user they can run /setup)."
    )

    status_msg = await update.message.reply_text("⚡ Thinking...")

    prompt = f"""
    You are LearnPulse OS 2.0 (by Viswesh and team | Dept of CSE), an AI Study Planner & Tutor.
    Student Profile: {student_context}
    User message: "{user_text}"

    Formatting rules (STRICT):
    - Personalize using the student's name, class, and subjects naturally.
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
# 6. Main Entry Point
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
    app.add_handler(CommandHandler("dbcheck", db_check))
    app.add_handler(CommandHandler("profile", view_profile))
    app.add_handler(CommandHandler("plan", generate_plan_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_natural_message))

    print("🤖 LearnPulse OS 2.0 is running...")
    app.run_polling(drop_pending_updates=True)


if __name__ == "__main__":
    main()
