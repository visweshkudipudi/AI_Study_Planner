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

# Connect to MongoDB Atlas (Permanent Cloud Memory)
mongo_client = MongoClient(MONGO_URI)
db = mongo_client["learnpulse_os"]
users_col = db["user_profiles"]

# Conversation states for onboarding
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
# 3. Database Helper Functions
# ==========================================
def get_user_profile(user_id: int) -> dict | None:
    return users_col.find_one({"user_id": user_id})


def save_user_profile(user_id: int, name: str, user_class: str, studying: str):
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


# ==========================================
# 4. Onboarding Conversation (/start & /setup)
# ==========================================
async def start_or_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_id = update.effective_user.id
    existing = get_user_profile(user_id)

    if existing and update.message.text.startswith("/start"):
        await update.message.reply_text(
            f"⚡ <b>Welcome back, {existing['name']}!</b>\n"
            f"🎓 <b>Class:</b> {existing['class']}\n"
            f"📚 <b>Studying:</b> {existing['studying']}\n\n"
            "<b>Commands:</b>\n"
            "• <code>/plan DBMS:5:4, OS:3:7 | 4</code> — Generate weighted timetable\n"
            "• <code>/profile</code> — View your saved profile\n"
            "• <code>/setup</code> — Re-enter your name, class & subjects\n"
            "• Or just send any study question directly!",
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
    name = context.user_data["name"]
    user_class = context.user_data["class"]
    studying = update.message.text.strip()

    save_user_profile(user_id, name, user_class, studying)

    await update.message.reply_text(
        "✅ <b>Profile Saved Permanently in Cloud!</b>\n\n"
        f"👤 <b>Name:</b> {name}\n"
        f"🎓 <b>Class:</b> {user_class}\n"
        f"📚 <b>Studying:</b> {studying}\n\n"
        "Now try sending a normal message like:\n"
        "<i>\"Create a 3-hour evening study plan for my subjects\"</i>\n"
        "or use <code>/plan DBMS:5:4, OS:3:7 | 4</code>",
        parse_mode="HTML",
    )
    return ConversationHandler.END


async def cancel_setup(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("❌ Setup cancelled. Type /setup anytime to configure your profile.")
    return ConversationHandler.END


# ==========================================
# 5. Profile & Study Commands
# ==========================================
async def view_profile(update: Update, context: ContextTypes.DEFAULT_TYPE):
    profile = get_user_profile(update.effective_user.id)
    if not profile:
        await update.message.reply_text(
            "You haven't set up your profile yet! Type /setup to get started."
        )
        return

    await update.message.reply_text(
        "🪪 <b>Your Saved LearnPulse Profile:</b>\n\n"
        f"👤 <b>Name:</b> {profile['name']}\n"
        f"🎓 <b>Class:</b> {profile['class']}\n"
        f"📚 <b>Studying:</b> {profile['studying']}\n\n"
        "<i>Type /setup anytime to update these details.</i>",
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
            "⚠️ Invalid format. Example:\n<code>/plan DBMS:5:4, OS:3:7, Maths:4:10 | 4</code>",
            parse_mode="HTML",
        )
        return

    profile = get_user_profile(update.effective_user.id)
    student_context = (
        f"Student Name: {profile['name']}, Class/Course: {profile['class']}, Current Subjects: {profile['studying']}."
        if profile
        else "Student profile not set yet."
    )

    status_msg = await update.message.reply_text("⚡ Calculating priorities & generating personalized schedule...")

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
        - Address the student by name if available.
        - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
        - NEVER use Markdown (** or ### or ---) and NEVER use LaTeX ($...$ or \\frac). Write formulas in plain text like v·cos(θ).
        - Keep the response clean, well-spaced, and under 3500 characters.

        Content structure:
        1. Priority Weights
        2. 3-Day Study Timetable with exact hours per subject
        3. Top 3 Practical Study Tips tailored to their class level
        """

        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
        )
        await status_msg.edit_text(resp.choices[0].message.content, parse_mode="HTML")

    except Exception as e:
        await status_msg.edit_text(f"❌ Error generating plan: {e}")


async def handle_natural_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user_text = update.message.text
    profile = get_user_profile(update.effective_user.id)

    if profile:
        student_context = (
            f"Student Name: {profile['name']}\n"
            f"Class/Course: {profile['class']}\n"
            f"Currently Studying: {profile['studying']}"
        )
    else:
        student_context = "Student has not completed /setup yet (gently remind them at the end that /setup saves their name, class & subjects)."

    status_msg = await update.message.reply_text("⚡ Thinking with your profile context...")

    prompt = f"""
    You are LearnPulse OS 2.0 (created by Viswesh and team | Dept of CSE), an AI Study Planner & Tutor.
    
    Saved Student Profile:
    {student_context}

    User message: "{user_text}"

    Formatting rules (STRICT):
    - Personalize your reply using the student's saved name, class level, and subjects naturally.
    - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
    - NEVER use Markdown (** or ### or ---) and NEVER use LaTeX ($...$ or \\frac). Write formulas in normal text.
    - Keep the response helpful, structured, and under 3500 characters.
    """
    try:
        resp = client.chat.completions.create(
            model=MODEL_NAME,
            messages=[{"role": "user", "content": prompt}],
        )
        await status_msg.edit_text(resp.choices[0].message.content, parse_mode="HTML")
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
    app.add_handler(CommandHandler("profile", view_profile))
    app.add_handler(CommandHandler("plan", generate_plan_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_natural_message))

    print("🤖 LearnPulse OS 2.0 (Groq + MongoDB Cloud) is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
