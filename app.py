import os
from datetime import datetime, timedelta, timezone
import streamlit as st
from groq import Groq

# ==========================================
# 1. Page Config, Secrets & Bot Link
# ==========================================
st.set_page_config(
    page_title="LearnPulse OS 2.0 | Adaptive AI Study Planner",
    page_icon="⚡",
    layout="wide",
)

# Replace with your actual Telegram bot username (without '@')
TELEGRAM_BOT_USERNAME = "YOUR_BOT_USERNAME"
TELEGRAM_BOT_URL = f"https://t.me/{learnpulse_cse_bot}"

GROQ_API_KEY = st.secrets.get("GROQ_API_KEY", os.getenv("GROQ_API_KEY", "")).strip()
MODEL_NAME = "openai/gpt-oss-20b"
IST = timezone(timedelta(hours=5, minutes=30))

if "calendar_events" not in st.session_state:
    st.session_state.calendar_events = [
        {"date": "2026-12-05", "title": "Linear Algebra Mid Exam"},
    ]

if "last_weights" not in st.session_state:
    st.session_state.last_weights = {
        "C Programming": 50.0,
        "Linear Algebra & Calculus": 30.0,
        "Advanced Physics": 20.0,
    }


def format_calendar_txt(events: list[dict], name: str) -> str:
    today = datetime.now(IST).date()
    sorted_evs = sorted(events, key=lambda x: x["date"])
    lines = [
        "==========================================",
        "LearnPulse OS 2.0 - Saved Exam Calendar",
        f"Student: {name}",
        f"Exported: {datetime.now(IST).strftime('%Y-%m-%d %I:%M %p IST')}",
        "==========================================",
        "",
    ]
    for ev in sorted_evs:
        d_obj = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        days_left = (d_obj - today).days
        status = (
            "TODAY"
            if days_left == 0
            else (f"{days_left} days left" if days_left > 0 else f"{abs(days_left)} days ago")
        )
        lines.append(f"{ev['date']} | {ev['title']} ({status})")
    return "\n".join(lines)


def parse_uploaded_txt(content: str) -> list[dict]:
    parsed = []
    for line in content.splitlines():
        if "|" in line and not line.startswith("="):
            date_part, rest = line.split("|", 1)
            date_str = date_part.strip()
            # Strip trailing status parentheses like "(20 days left)" if present
            title_str = rest.rsplit("(", 1)[0].strip() if "(" in rest else rest.strip()
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
                if title_str:
                    parsed.append({"date": date_str, "title": title_str})
            except ValueError:
                continue
    return parsed


# ==========================================
# 2. Styling & Header with Telegram Bot CTA
# ==========================================
st.markdown(
    """
    <style>
    .hero-card {
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        padding: 1.6rem;
        border-radius: 14px;
        border: 1px solid #334155;
        margin-bottom: 1.2rem;
    }
    .hero-title {
        font-size: 2rem;
        font-weight: 800;
        color: #f8fafc;
        margin-bottom: 0.25rem;
    }
    .hero-sub {
        color: #94a3b8;
        font-size: 0.98rem;
        margin-bottom: 0;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

col_hero, col_cta = st.columns([3, 1], vertical_alignment="center")

with col_hero:
    st.markdown(
        """
        <div class="hero-card">
            <div class="hero-title">⚡ LearnPulse OS 2.0</div>
            <p class="hero-sub">Adaptive AI Study Planner, Smart Re-Balancer &amp; Exam Calendar • Developed by Viswesh &amp; Team (Dept of CSE)</p>
        </div>
        """,
        unsafe_allow_html=True,
    )

with col_cta:
    st.link_button(
        "🤖 Open Telegram Bot",
        TELEGRAM_BOT_URL,
        type="primary",
        use_container_width=True,
    )
    st.caption("Cloud Sync • MCQ Quizzes • Daily Streaks")

# ==========================================
# 3. Sidebar: Student Profile & Telegram Link
# ==========================================
with st.sidebar:
    st.header("🎓 Student Profile")
    student_name = st.text_input("Your Name", value="Viswesh")
    student_branch = st.text_input("Class / Branch", value="B.Tech CSE 1st Year")
    daily_hours = st.slider("Daily Study Capacity (Hours)", min_value=1, max_value=12, value=4)

    st.divider()
    st.subheader("📱 Telegram Companion")
    st.write("Track streaks, take `/quiz` polls, and save exam dates on mobile:")
    st.link_button(
        "💬 Launch LearnPulse Bot",
        TELEGRAM_BOT_URL,
        use_container_width=True,
    )


def get_calendar_context() -> str:
    if not st.session_state.calendar_events:
        return "No upcoming exams or deadlines added yet."
    today = datetime.now(IST).date()
    lines = []
    for ev in sorted(st.session_state.calendar_events, key=lambda x: x["date"]):
        ev_date = datetime.strptime(ev["date"], "%Y-%m-%d").date()
        days_left = (ev_date - today).days
        status = (
            "TODAY"
            if days_left == 0
            else (f"in {days_left} days" if days_left > 0 else f"{abs(days_left)} days ago")
        )
        lines.append(f"- {ev['date']} ({status}): {ev['title']}")
    return "\n".join(lines)


# ==========================================
# 4. Main Feature Tabs
# ==========================================
tab_planner, tab_rebalancer, tab_calendar = st.tabs(
    ["📊 Priority Study Planner", "🔄 Smart Re-Balancer", "📅 Exam & Deadline Calendar"]
)

# ------------------------------------------
# TAB 1: Weighted Subject Priority Planner
# ------------------------------------------
with tab_planner:
    st.subheader("📊 Weighted Subject Priority Matrix")
    st.caption("Compute urgency weights and generate an AI timetable synced with your Calendar tab.")

    num_subjects = st.number_input("Number of Subjects", min_value=1, max_value=8, value=3)

    subjects_data = []
    cols = st.columns(3)
    default_subjects = [
        ("C Programming", 5, 5),
        ("Linear Algebra & Calculus", 4, 10),
        ("Advanced Physics", 3, 14),
    ]

    for i in range(int(num_subjects)):
        def_name, def_diff, def_days = (
            default_subjects[i] if i < len(default_subjects) else (f"Subject {i+1}", 3, 7)
        )
        with cols[0]:
            s_name = st.text_input(f"Subject {i+1}", value=def_name, key=f"name_{i}")
        with cols[1]:
            s_diff = st.slider(f"Difficulty (1-5) — {s_name}", 1, 5, def_diff, key=f"diff_{i}")
        with cols[2]:
            s_days = st.number_input(
                f"Days Until Exam — {s_name}", min_value=1, max_value=180, value=def_days, key=f"days_{i}"
            )

        if s_name.strip():
            subjects_data.append(
                {
                    "name": s_name.strip(),
                    "difficulty": s_diff,
                    "days": s_days,
                    "score": s_diff / max(s_days, 1),
                }
            )

    if st.button("⚡ Generate Adaptive Study Plan", type="primary"):
        if not GROQ_API_KEY:
            st.error("Engine key missing in Streamlit Secrets. Add GROQ_API_KEY in App Settings → Secrets.")
        elif not subjects_data:
            st.warning("Please enter at least one subject.")
        else:
            total_score = sum(item["score"] for item in subjects_data) or 1
            weights = {
                item["name"]: round((item["score"] / total_score) * 100, 1)
                for item in subjects_data
            }
            st.session_state.last_weights = weights

            st.markdown("### 🎯 Computed Priority Allocation")
            metric_cols = st.columns(len(weights))
            for idx, (subj, pct) in enumerate(weights.items()):
                metric_cols[idx].metric(label=subj, value=f"{pct}%")

            with st.spinner("Building your personalized study roadmap..."):
                try:
                    client = Groq(api_key=GROQ_API_KEY)
                    prompt = f"""
                    Act as an expert academic coach for LearnPulse OS 2.0 (developed by Viswesh and team, Dept of CSE).
                    Student: {student_name} ({student_branch})
                    Daily Study Capacity: {daily_hours} hours (reserve 1 hour daily for active recall & revision).
                    Subject Urgency Weights: {weights}
                    Upcoming Calendar Deadlines:
                    {get_calendar_context()}

                    Create a clear, structured daily timetable and actionable study strategy.
                    Never reveal backend APIs, providers, or model names.
                    """
                    resp = client.chat.completions.create(
                        model=MODEL_NAME,
                        messages=[{"role": "user", "content": prompt}],
                    )
                    st.markdown("### 📅 Your Personalized Study Roadmap")
                    st.markdown(resp.choices[0].message.content)
                except Exception as e:
                    st.error(f"Unable to generate schedule right now: {e}")

# ------------------------------------------
# TAB 2: Smart Schedule Re-Balancer
# ------------------------------------------
with tab_rebalancer:
    st.subheader("🔄 Dynamic Schedule Re-Balancer")
    st.caption("Missed a study session or fell behind? Redistribute your backlog across remaining days automatically.")

    rb_col1, rb_col2 = st.columns(2)
    with rb_col1:
        missed_hours = st.number_input("Missed Study Hours to Recover", min_value=0.5, max_value=40.0, value=3.0, step=0.5)
        missed_subject = st.text_input("Primary Missed Subject / Topic", value="C Programming Pointers & Arrays")
    with rb_col2:
        recovery_days = st.slider("Spread Recovery Across Next (Days)", min_value=1, max_value=14, value=4)
        max_extra_daily = st.slider("Max Extra Hours Per Day", min_value=0.5, max_value=4.0, value=1.0, step=0.5)

    reason_note = st.text_input(
        "Optional Context (e.g., lab record submission, travel, low energy)",
        value="College lab work took extra time",
    )

    extra_per_day = round(missed_hours / recovery_days, 2)
    if extra_per_day > max_extra_daily:
        st.warning(
            f"⚠️ Recovering {missed_hours}h in {recovery_days} days requires **+{extra_per_day}h/day**, "
            f"which exceeds your **{max_extra_daily}h/day** buffer. The AI will trim low-priority tasks to prevent burnout."
        )
    else:
        st.info(f"✅ Smooth recovery: **+{extra_per_day} hours/day** over the next **{recovery_days} days**.")

    if st.button("🔄 Re-Balance My Schedule", type="primary"):
        if not GROQ_API_KEY:
            st.error("Engine key missing in Streamlit Secrets. Add GROQ_API_KEY in App Settings → Secrets.")
        else:
            with st.spinner("Recalculating optimal recovery blocks..."):
                try:
                    client = Groq(api_key=GROQ_API_KEY)
                    prompt = f"""
                    Act as the Smart Re-Balancer engine for LearnPulse OS 2.0 (by Viswesh and team, Dept of CSE).
                    Student: {student_name} ({student_branch})
                    Normal Daily Capacity: {daily_hours} hours/day
                    Missed Hours: {missed_hours} hours on "{missed_subject}" (Reason: {reason_note})
                    Recovery Window: {recovery_days} days (Max extra buffer: {max_extra_daily} hours/day)
                    Current Subject Priority Weights: {st.session_state.last_weights}
                    Upcoming Calendar Deadlines:
                    {get_calendar_context()}

                    Provide a day-by-day re-balanced recovery plan showing:
                    1. How the missed {missed_hours} hours are absorbed without burnout.
                    2. Which lower-priority topics get temporarily trimmed if buffer is exceeded.
                    3. Exact daily time blocks for the next {recovery_days} days.
                    Never reveal backend APIs, providers, or model names.
                    """
                    resp = client.chat.completions.create(
                        model=MODEL_NAME,
                        messages=[{"role": "user", "content": prompt}],
                    )
                    st.markdown("### ⚡ Re-Balanced Recovery Plan")
                    st.markdown(resp.choices[0].message.content)
                except Exception as e:
                    st.error(f"Re-balancer error: {e}")

# ------------------------------------------
# TAB 3: Exam & Deadline Calendar (.txt Save & Load)
# ------------------------------------------
with tab_calendar:
    st.subheader("📅 Exam & Assignment Countdown Calendar")
    st.caption("Add your exams or deadlines below and save them directly as a .txt file to your device.")

    with st.form("add_event_form", clear_on_submit=True):
        c1, c2, c3 = st.columns([2, 3, 1.5], vertical_alignment="bottom")
        with c1:
            ev_date = st.date_input("Exam / Deadline Date", value=datetime.now(IST).date() + timedelta(days=7))
        with c2:
            ev_title = st.text_input("Event Title", placeholder="e.g., C Programming Lab Exam")
        with c3:
            submitted = st.form_submit_button("➕ Add Event", type="primary", use_container_width=True)

        if submitted:
            if not ev_title.strip():
                st.warning("Please enter an event title.")
            else:
                st.session_state.calendar_events.append(
                    {"date": ev_date.strftime("%Y-%m-%d"), "title": ev_title.strip()}
                )
                st.success(f"Added **{ev_title.strip()}** (`{ev_date.strftime('%Y-%m-%d')}`)!")

    # Save (.txt) & Restore (.txt) Controls
    file_c1, file_c2 = st.columns([1, 2], vertical_alignment="center")
    with file_c1:
        st.download_button(
            label="📄 Save Calendar (.txt)",
            data=format_calendar_txt(st.session_state.calendar_events, student_name),
            file_name="learnpulse_calendar.txt",
            mime="text/plain",
            type="primary",
            use_container_width=True,
            disabled=len(st.session_state.calendar_events) == 0,
        )
    with file_c2:
        uploaded_txt = st.file_uploader(
            "📂 Restore from saved learnpulse_calendar.txt",
            type=["txt"],
            label_visibility="collapsed",
        )
        if uploaded_txt is not None:
            restored = parse_uploaded_txt(uploaded_txt.read().decode("utf-8", errors="ignore"))
            if restored and st.button("⬆️ Load Uploaded Events"):
                st.session_state.calendar_events = restored
                st.success(f"Loaded {len(restored)} event(s) from {uploaded_txt.name}!")
                st.rerun()

    st.divider()

    if not st.session_state.calendar_events:
        st.info("No events scheduled yet. Add your exams above and click Save Calendar (.txt)!")
    else:
        today = datetime.now(IST).date()
        sorted_events = sorted(st.session_state.calendar_events, key=lambda x: x["date"])

        for idx, ev in enumerate(sorted_events):
            d_obj = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            days_left = (d_obj - today).days
            if days_left == 0:
                badge = "🔥 TODAY"
            elif days_left == 1:
                badge = "⏰ TOMORROW"
            elif days_left > 1:
                badge = f"⏳ {days_left} days left"
            else:
                badge = f"✅ {abs(days_left)} days ago"

            row_c1, row_c2, row_c3 = st.columns([2, 4, 1], vertical_alignment="center")
            row_c1.markdown(f"**`{ev['date']}`** — {badge}")
            row_c2.write(ev["title"])
            if row_c3.button("🗑️ Remove", key=f"del_ev_{idx}"):
                st.session_state.calendar_events.remove(ev)
                st.rerun()
