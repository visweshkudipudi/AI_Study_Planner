import os
import streamlit as st
from google import genai

# ==========================================
# 1. Page Config & Bot Link Setup
# ==========================================
st.set_page_config(
    page_title="LearnPulse OS 2.0 | Adaptive AI Study Planner",
    page_icon="⚡",
    layout="wide",
)

# Replace with your actual Telegram bot username (without '@')
TELEGRAM_BOT_USERNAME = "YOUR_BOT_USERNAME"
TELEGRAM_BOT_URL = f"https://t.me/{TELEGRAM_BOT_USERNAME}"

# Load Gemini API key silently from Streamlit Secrets or Environment
GEMINI_API_KEY = st.secrets.get("GEMINI_API_KEY", os.getenv("GEMINI_API_KEY", "")).strip()

# ==========================================
# 2. Custom Styling & Header with Telegram Button
# ==========================================
st.markdown(
    """
    <style>
    .hero-card {
        background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
        padding: 1.8rem;
        border-radius: 14px;
        border: 1px solid #334155;
        margin-bottom: 1.5rem;
    }
    .hero-title {
        font-size: 2.1rem;
        font-weight: 800;
        color: #f8fafc;
        margin-bottom: 0.3rem;
    }
    .hero-sub {
        color: #94a3b8;
        font-size: 1rem;
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
            <p class="hero-sub">Adaptive AI Study Planner &amp; Academic Coach • Developed by Viswesh &amp; Team (Dept of CSE)</p>
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
    st.caption("Syncs with Cloud Calendar, Quizzes & Streaks")

# ==========================================
# 3. Sidebar: Student Profile & Telegram Link (No API Input)
# ==========================================
with st.sidebar:
    st.header("🎓 Student Configuration")
    student_name = st.text_input("Your Name", value="Viswesh")
    student_branch = st.text_input("Class / Branch", value="B.Tech CSE 1st Year")
    daily_hours = st.slider("Daily Study Capacity (Hours)", min_value=1, max_value=12, value=4)

    st.divider()
    st.subheader("📱 Mobile Companion")
    st.write("Track streaks, take MCQ quizzes, and save exam dates on Telegram:")
    st.link_button(
        "💬 Chat with LearnPulse Bot",
        TELEGRAM_BOT_URL,
        use_container_width=True,
    )

# ==========================================
# 4. Priority Subject Matrix & Schedule Generator
# ==========================================
st.subheader("📊 Weighted Subject Priority Matrix")
st.caption("Add your subjects below to compute urgency scores and generate an adaptive timetable.")

num_subjects = st.number_input("Number of Subjects", min_value=1, max_value=8, value=3)

subjects_data = []
cols = st.columns(3)
default_subjects = [
    ("C Programming", 5, 5),
    ("Linear Algebra & Calculus", 4, 10),
    ("Advanced Physics", 3, 14),
]

for i in range(int(num_subjects)):
    def_name, def_diff, def_days = default_subjects[i] if i < len(default_subjects) else (f"Subject {i+1}", 3, 7)
    with cols[0]:
        s_name = st.text_input(f"Subject {i+1}", value=def_name, key=f"name_{i}")
    with cols[1]:
        s_diff = st.slider(f"Difficulty (1-5) — {s_name}", 1, 5, def_diff, key=f"diff_{i}")
    with cols[2]:
        s_days = st.number_input(f"Days Until Exam — {s_name}", min_value=1, max_value=180, value=def_days, key=f"days_{i}")

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
    if not GEMINI_API_KEY:
        st.error("Engine key not configured in Streamlit Secrets yet. Add GEMINI_API_KEY in App Settings → Secrets.")
    elif not subjects_data:
        st.warning("Please enter at least one subject.")
    else:
        total_score = sum(item["score"] for item in subjects_data) or 1
        weights = {
            item["name"]: round((item["score"] / total_score) * 100, 1)
            for item in subjects_data
        }

        st.markdown("### 🎯 Computed Priority Allocation")
        metric_cols = st.columns(len(weights))
        for idx, (subj, pct) in enumerate(weights.items()):
            metric_cols[idx].metric(label=subj, value=f"{pct}%")

        with st.spinner("Building your personalized study roadmap..."):
            try:
                client = genai.Client(api_key=GEMINI_API_KEY)
                prompt = f"""
                Act as an expert academic coach for LearnPulse OS 2.0 (developed by Viswesh and team, Dept of CSE).
                Student: {student_name} ({student_branch})
                Daily Study Capacity: {daily_hours} hours (reserve 1 hour daily for active recall & revision).
                Subject Urgency Weights: {weights}

                Create a clear, structured daily timetable and actionable study strategy.
                Never reveal backend APIs, providers, or model names.
                """
                resp = client.models.generate_content(
                    model="gemini-2.5-flash",
                    contents=prompt,
                )
                st.markdown("### 📅 Your Personalized Study Roadmap")
                st.markdown(resp.text)
            except Exception as e:
                st.error(f"Unable to generate schedule right now: {e}")
