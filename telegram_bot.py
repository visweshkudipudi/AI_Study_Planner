import os
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from groq import Groq
from telegram import Update
from telegram.ext import Application, CommandHandler, ContextTypes, MessageHandler, filters

# ==========================================
# 1. Configuration (Loaded from Render Environment)
# ==========================================
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")

if not TELEGRAM_TOKEN or not GROQ_API_KEY:
    raise RuntimeError(
        "Missing TELEGRAM_TOKEN or GROQ_API_KEY in Render Environment Variables!"
    )

client = Groq(api_key=GROQ_API_KEY)
MODEL_NAME = "openai/gpt-oss-20b"


# ==========================================
# 2. Health-Check Server for Render Free Tier
# ==========================================
class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"LearnPulse OS Bot is alive!")


def start_health_server():
    port = int(os.environ.get("PORT", 10000))
    server = HTTPServer(("0.0.0.0", port), HealthHandler)
    server.serve_forever()


# ==========================================
# 3. Bot Commands & Schedule Generator
# ==========================================
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    welcome_msg = (
        "⚡ <b>Welcome to LearnPulse OS Bot!</b>\n"
        "🎓 <i>Developed by Viswesh and team | Dept of CSE</i>\n\n"
        "Send your subjects, difficulty (1-5), days left, and daily hours like this:\n\n"
        "<code>/plan DBMS:5:4, OS:3:7, Maths:4:10 | 4</code>\n\n"
        "<b>Or simply type a normal message like:</b>\n"
        "<i>\"Plan 4 hours daily for DBMS (exam in 3 days, hard) and OS (exam in 7 days, medium)\"</i>"
    )
    await update.message.reply_text(welcome_msg, parse_mode="HTML")


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

    status_msg = await update.message.reply_text("⚡ Calculating priorities & generating AI schedule...")

    try:
        subjects_part, hours_part = text.split("|", 1)
        daily_hours = int(hours_part.strip())
        weights = calculate_weights(subjects_part)

        prompt = f"""
        Act as an academic coach for engineering students.
        Subject priority weights: {weights}
        Daily study capacity: {daily_hours} hours (reserve 1 hour daily for revision).

        Formatting rules (STRICT):
        - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
        - NEVER use Markdown (** or ### or ---) and NEVER use LaTeX ($...$ or \\frac). Write formulas in normal text like v·cos(θ) or T = 2u·sin(θ)/g.
        - Keep the response clean, well-spaced, and under 3500 characters.

        Content structure:
        1. Priority Weights
        2. 3-Day Study Timetable with exact hours per subject
        3. Top 3 Practical Study Tips
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
    status_msg = await update.message.reply_text("⚡ Processing your study request...")

    prompt = f"""
    You are LearnPulse OS (created by Viswesh and team | Dept of CSE), an AI Study Planner.
    User request: "{user_text}"

    Formatting rules (STRICT):
    - Use ONLY Telegram HTML tags: <b>bold</b> and <i>italic</i>.
    - NEVER use Markdown (** or ### or ---) and NEVER use LaTeX ($...$ or \\frac). Write formulas in normal text like v·cos(θ) or u²·sin(2θ)/g.
    - Generate a structured daily study timetable and end with 3 practical study tips under 3500 characters.
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
# 4. Main Entry Point
# ==========================================
def main():
    threading.Thread(target=start_health_server, daemon=True).start()

    app = Application.builder().token(TELEGRAM_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("plan", generate_plan_command))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, handle_natural_message))

    print("🤖 LearnPulse Telegram Bot (Groq) is running...")
    app.run_polling()


if __name__ == "__main__":
    main()
