import os
from datetime import datetime, timedelta, timezone
import pandas as pd
import streamlit as st
from groq import Groq

# ==========================================
# 1. Page Config, Secrets & Bot Link
# ==========================================
st.set_page_config(
    page_title="LearnPulse OS 2.0 | Adaptive AI Study Planner",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded",
)

# Replace with your actual Telegram bot username (without '@')
TELEGRAM_BOT_USERNAME = "learnpulse_cse_bot"
TELEGRAM_BOT_URL = f"https://t.me/{TELEGRAM_BOT_USERNAME}"

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
            title_str = rest.rsplit("(", 1)[0].strip() if "(" in rest else rest.strip()
            try:
                datetime.strptime(date_str, "%Y-%m-%d")
                if title_str:
                    parsed.append({"date": date_str, "title": title_str})
            except ValueError:
                continue
    return parsed


# ==========================================
# 2. Cyber-Glassmorphism Theme & Custom CSS
# ==========================================
st.markdown(
    """
    <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@500;700&display=swap');

    /* Global Font & Ambient Mesh Background */
    html, body, [class*="css"] {
        font-family: 'Plus Jakarta Sans', sans-serif !important;
    }

    .stApp {
        background-color: #050811;
        background-image:
            radial-gradient(at 10% 10%, rgba(56, 189, 248, 0.14) 0px, transparent 45%),
            radial-gradient(at 90% 15%, rgba(139, 92, 246, 0.16) 0px, transparent 45%),
            radial-gradient(at 50% 95%, rgba(16, 185, 129, 0.10) 0px, transparent 50%);
        color: #f1f5f9;
    }

    /* Hide default Streamlit top header bar clutter */
    header[data-testid="stHeader"] {
        background: transparent !important;
    }

    /* Glassmorphic Sidebar */
    section[data-testid="stSidebar"] {
        background: rgba(10, 15, 30, 0.78) !important;
        backdrop-filter: blur(18px);
        -webkit-backdrop-filter: blur(18px);
        border-right: 1px solid rgba(148, 163, 184, 0.12);
    }

    /* Hero Banner Card */
    .hero-glass {
        position: relative;
        background: linear-gradient(135deg, rgba(15, 23, 42, 0.85) 0%, rgba(30, 27, 75, 0.75) 100%);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        padding: 1.8rem 2rem;
        border-radius: 20px;
        border: 1px solid rgba(56, 189, 248, 0.28);
        box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45), inset 0 1px 0 rgba(255, 255, 255, 0.08);
        margin-bottom: 1.2rem;
    }

    .hero-badge {
        display: inline-block;
        padding: 0.28rem 0.75rem;
        border-radius: 999px;
        font-size: 0.75rem;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #38bdf8;
        background: rgba(56, 189, 248, 0.12);
        border: 1px solid rgba(56, 189, 248, 0.35);
        margin-bottom: 0.65rem;
    }

    .hero-title {
        font-size: 2.35rem;
        font-weight: 800;
        letter-spacing: -0.02em;
        background: linear-gradient(90deg, #ffffff 0%, #38bdf8 50%, #a78bfa 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin: 0 0 0.35rem 0;
        line-height: 1.15;
    }

    .hero-sub {
        color: #94a3b8;
        font-size: 0.98rem;
        margin: 0;
    }

    /* Bot CTA Card */
    .cta-glass {
        background: rgba(15, 23, 42, 0.72);
        backdrop-filter: blur(16px);
        padding: 1.25rem;
        border-radius: 18px;
        border: 1px solid rgba(139, 92, 246, 0.30);
        box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
        text-align: center;
    }

    /* Glowing Metric Cards */
    div[data-testid="stMetric"] {
        background: rgba(15, 23, 42, 0.68) !important;
        backdrop-filter: blur(14px);
        border: 1px solid rgba(56, 189, 248, 0.22) !important;
        border-radius: 16px !important;
        padding: 1rem 1.2rem !important;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
        transition: transform 0.2s ease, border-color 0.2s ease;
    }

    div[data-testid="stMetric"]:hover {
        transform: translateY(-2px);
        border-color: rgba(56, 189, 248, 0.55) !important;
    }

    div[data-testid="stMetricValue"] {
        font-family: 'JetBrains Mono', monospace !important;
        font-weight: 700 !important;
        color: #38bdf8 !important;
    }

    /* Modern Pill Tabs */
    .stTabs [data-baseweb="tab-list"] {
        gap: 10px;
        background: rgba(15, 23, 42, 0.65);
        padding: 0.45rem;
        border-radius: 14px;
        border: 1px solid rgba(148, 163, 184, 0.14);
    }

    .stTabs [data-baseweb="tab"] {
        border-radius: 10px !important;
        padding: 0.55rem 1.2rem !important;
        font-weight: 600 !important;
        color: #94a3b8 !important;
        border: none !important;
    }

    .stTabs [aria-selected="true"] {
        background: linear-gradient(135deg, #0284c7 0%, #6366f1 100%) !important;
        color: #ffffff !important;
        box-shadow: 0 4px 16px rgba(56, 189, 248, 0.32);
    }

    /* Gradient Primary Buttons & Link Buttons */
    .stButton > button[kind="primary"],
    a[data-testid="stLinkButton-primary"] {
        background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%) !important;
        border: 1px solid rgba(255, 255, 255, 0.15) !important;
        border-radius: 12px !important;
        color: #ffffff !important;
        font-weight: 700 !important;
        letter-spacing: 0.01em;
        box-shadow: 0 6px 20px rgba(14, 165, 233, 0.35) !important;
        transition: all 0.2s ease !important;
    }

    .stButton > button[kind="primary"]:hover,
    a[data-testid="stLinkButton-primary"]:hover {
        transform: translateY(-1px);
        box-shadow: 0 10px 28px rgba(99, 102, 241, 0.5) !important;
    }

    /* Glass Containers for Forms & Tables */
    div[data-testid="stForm"],
    div[data-testid="stDataFrame"] {
        background: rgba(15, 23, 42, 0.60) !important;
        border: 1px solid rgba(148, 163, 184, 0.15) !important;
        border-radius: 16px !important;
        padding: 1rem !important;
    }

    code {
        font-family: 'JetBrains Mono', monospace !important;
        color: #38bdf8 !important;
    }
    </style>
    """,
    unsafe_allow_html=True,
)

# ==========================================
# 3. Header & Direct Telegram Bot Launch
# ==========================================
col_hero, col_cta = st.columns([3.1, 1.1], vertical_alignment="center")

with col_hero:
    st.markdown(
        """
        <div class="hero-glass">
            <div class="hero-badge">⚡ AI-Assisted Academic Engine</div>
            <h1 class="hero-title">LearnPulse OS 2.0</h1>
            <p class="hero-sub">Adaptive Priority Matrix, Dynamic Re-Balancer &amp; Exam Countdown Suite • Developed by Viswesh &amp; Team (Dept of CSE)</p>
        </div>
        """,
        unsafe_allow_html=True,
    )

with col_cta:
    st.markdown('<div class="cta-glass">', unsafe_allow_html=True)
    st.link_button(
        "🤖 Launch Telegram Bot",
        TELEGRAM_BOT_URL,
        type="primary",
        use_container_width=True,
    )
    st.caption("✨ Cloud Sync • MCQ Quizzes • Streaks")
    st.markdown("</div>", unsafe_allow_html=True)

# ==========================================
# 4. Sidebar: Student Profile & Telegram Link
# ==========================================
with st.sidebar:
    st.markdown("### 🎓 Student Profile")
    student_name = st.text_input("Your Name", value="Viswesh")
    student_branch = st.text_input("Class / Branch", value="B.Tech CSE 1st Year")
    daily_hours = st.slider("Daily Study Capacity (Hours)", min_value=1, max_value=12, value=4)

    st.divider()
    st.markdown("### 📱 Mobile Companion")
    st.caption("Log sessions (`/done`), take interactive `/quiz` polls, and manage your cloud `/calendar` anywhere:")
    st.link_button(
        "💬 Open LearnPulse Bot",
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
# 5. Main Feature Tabs
# ==========================================
tab_planner, tab_rebalancer, tab_calendar = st.tabs(
    ["📊 Priority Study Planner", "🔄 Smart Re-Balancer", "📅 Exam & Deadline Calendar"]
)

# ------------------------------------------
# TAB 1: Weighted Subject Priority Planner
# ------------------------------------------
with tab_planner:
    st.subheader("📊 Weighted Subject Priority Matrix")
    st.caption("Adjust difficulty and exam proximity to visualize live urgency weights, time allocations, and AI roadmaps.")

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
                    "score": round(s_diff / max(s_days, 1), 3),
                }
            )

    if subjects_data:
        total_score = sum(item["score"] for item in subjects_data) or 1
        effective_study_hours = max(daily_hours - 1, 0.5) if daily_hours > 1 else daily_hours
        revision_hours = 1.0 if daily_hours > 1 else 0.0

        table_rows = []
        for item in subjects_data:
            pct = round((item["score"] / total_score) * 100, 1)
            alloc_hrs = round((pct / 100) * effective_study_hours, 2)
            urgency_tag = "🔴 High" if pct >= 45 else ("🟡 Medium" if pct >= 25 else "🟢 Steady")
            table_rows.append(
                {
                    "Subject": item["name"],
                    "Urgency": urgency_tag,
                    "Difficulty (1-5)": item["difficulty"],
                    "Days Left": item["days"],
                    "Priority (%)": pct,
                    "Daily Study (Hrs)": alloc_hrs,
                }
            )

        df_priority = pd.DataFrame(table_rows).sort_values(by="Priority (%)", ascending=False)
        st.session_state.last_weights = dict(zip(df_priority["Subject"], df_priority["Priority (%)"]))

        st.divider()
        st.markdown("### 📈 Live Priority Analytics & Allocation Table")

        metric_cols = st.columns(len(df_priority))
        for idx, (_, row) in enumerate(df_priority.iterrows()):
            metric_cols[idx].metric(
                label=row["Subject"],
                value=f"{row['Priority (%)']}%",
                delta=f"{row['Daily Study (Hrs)']} hrs/day",
            )

        g_col1, g_col2 = st.columns(2)
        with g_col1:
            st.markdown("**🎯 Urgency Share by Subject (%)**")
            st.bar_chart(df_priority.set_index("Subject")[["Priority (%)"]], color="#38bdf8", height=280)

        with g_col2:
            st.markdown(f"**⏱️ Daily Time Split ({effective_study_hours}h Focus + {revision_hours}h Revision)**")
            st.bar_chart(df_priority.set_index("Subject")[["Daily Study (Hrs)"]], color="#8b5cf6", height=280)

        st.markdown("**📋 Priority Matrix Breakdown Table**")
        st.dataframe(
            df_priority,
            use_container_width=True,
            hide_index=True,
            column_config={
                "Priority (%)": st.column_config.ProgressColumn(
                    "Priority (%)",
                    format="%.1f%%",
                    min_value=0,
                    max_value=100,
                ),
                "Daily Study (Hrs)": st.column_config.NumberColumn(
                    "Daily Study (Hrs)",
                    format="%.2f h",
                ),
            },
        )

    if st.button("⚡ Generate AI Study Roadmap", type="primary"):
        if not GROQ_API_KEY:
            st.error("Engine key missing in Streamlit Secrets. Add GROQ_API_KEY in App Settings → Secrets.")
        elif not subjects_data:
            st.warning("Please enter at least one subject.")
        else:
            with st.spinner("Building your personalized study roadmap..."):
                try:
                    client = Groq(api_key=GROQ_API_KEY)
                    prompt = f"""
                    Act as an expert academic coach for LearnPulse OS 2.0 (developed by Viswesh and team, Dept of CSE).
                    Student: {student_name} ({student_branch})
                    Daily Study Capacity: {daily_hours} hours (reserve 1 hour daily for active recall & revision).
                    Subject Urgency Weights: {st.session_state.last_weights}
                    Upcoming Calendar Deadlines:
                    {get_calendar_context()}

                    Create a clear, structured daily timetable and actionable study strategy.
                    Never reveal backend APIs, providers, or model names.
                    """
                    resp = client.chat.completions.create(
                        model=MODEL_NAME,
                        messages=[{"role": "user", "content": prompt}],
                    )
                    st.markdown("### 📅 Your Personalized AI Study Roadmap")
                    st.markdown(resp.choices[0].message.content)
                except Exception as e:
                    st.error(f"Unable to generate schedule right now: {e}")

# ------------------------------------------
# TAB 2: Smart Schedule Re-Balancer
# ------------------------------------------
with tab_rebalancer:
    st.subheader("🔄 Dynamic Schedule Re-Balancer")
    st.caption("Visualize how missed hours are absorbed across upcoming days without overloading your daily schedule.")

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
    capped_extra = min(extra_per_day, max_extra_daily)
    trimmed_hours = round(max(missed_hours - (capped_extra * recovery_days), 0), 2)

    if extra_per_day > max_extra_daily:
        st.warning(
            f"⚠️ Recovering {missed_hours}h in {recovery_days} days requires **+{extra_per_day}h/day**, "
            f"which exceeds your **{max_extra_daily}h/day** buffer. **{trimmed_hours}h** of low-priority tasks will be trimmed."
        )
    else:
        st.info(f"✅ Smooth recovery: **+{extra_per_day} hours/day** over the next **{recovery_days} days**.")

    today_ist = datetime.now(IST).date()
    recovery_rows = []
    for d in range(1, recovery_days + 1):
        day_label = (today_ist + timedelta(days=d)).strftime("%b %d (%a)")
        recovery_rows.append(
            {
                "Day": day_label,
                "Baseline Hours": float(daily_hours),
                "Recovery Catch-Up": capped_extra,
                "Total Planned (Hrs)": round(daily_hours + capped_extra, 2),
            }
        )
    df_recovery = pd.DataFrame(recovery_rows)

    vis_r1, vis_r2 = st.columns([1.3, 1])
    with vis_r1:
        st.markdown("**📊 Re-Balanced Daily Workload (Baseline vs. Catch-Up)**")
        st.bar_chart(
            df_recovery.set_index("Day")[["Baseline Hours", "Recovery Catch-Up"]],
            color=["#38bdf8", "#a855f7"],
            height=260,
        )
    with vis_r2:
        st.markdown("**📋 Recovery Schedule Table**")
        st.dataframe(df_recovery, use_container_width=True, hide_index=True)

    if st.button("🔄 Generate AI Re-Balanced Plan", type="primary"):
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
    st.caption("Add exams below, visualize days remaining, and save/restore your calendar as a .txt file.")

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

        cal_rows = []
        for ev in sorted_events:
            d_obj = datetime.strptime(ev["date"], "%Y-%m-%d").date()
            days_left = (d_obj - today).days
            status = (
                "🔥 TODAY"
                if days_left == 0
                else ("⏰ TOMORROW" if days_left == 1 else (f"⏳ {days_left} days left" if days_left > 1 else "✅ Past"))
            )
            cal_rows.append(
                {
                    "Date": ev["date"],
                    "Event": ev["title"],
                    "Status": status,
                    "Days Remaining": max(days_left, 0),
                }
            )

        df_cal = pd.DataFrame(cal_rows)

        cal_v1, cal_v2 = st.columns([1.2, 1])
        with cal_v1:
            st.markdown("**📋 Upcoming Exam & Deadline Table**")
            st.dataframe(df_cal[["Date", "Event", "Status"]], use_container_width=True, hide_index=True)
        with cal_v2:
            st.markdown("**⏳ Days Remaining Countdown Graph**")
            st.bar_chart(df_cal.set_index("Event")[["Days Remaining"]], color="#38bdf8", height=230)

        st.markdown("**Manage Saved Events:**")
        for idx, ev in enumerate(sorted_events):
            row_c1, row_c2, row_c3 = st.columns([2, 4, 1], vertical_alignment="center")
            row_c1.markdown(f"**`{ev['date']}`**")
            row_c2.write(ev["title"])
            if row_c3.button("🗑️ Remove", key=f"del_ev_{idx}"):
                st.session_state.calendar_events.remove(ev)
                st.rerun()
