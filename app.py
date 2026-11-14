from datetime import date, datetime
import json
import re
from google import genai
from icalendar import Calendar, Event
import streamlit as st

# ==========================================
# 1. Page Configuration & Dark SaaS Styling
# ==========================================
st.set_page_config(
    page_title="LearnPulse AI | Study Planner",
    page_icon="⚡",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    """
<style>
    .stApp { background-color: #0b0f19; color: #f3f4f6; }
    .main-header {
        font-size: 2.2rem;
        font-weight: 800;
        background: linear-gradient(90deg, #a78bfa 0%, #38bdf8 100%);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        margin-bottom: 0px;
    }
    .sub-header { font-size: 0.95rem; color: #94a3b8; }
    .team-badge {
        background: rgba(139, 92, 246, 0.15);
        border: 1px solid rgba(139, 92, 246, 0.4);
        color: #c4b5fd;
        padding: 6px 16px;
        border-radius: 20px;
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.3px;
        display: inline-block;
    }
    .stTabs [data-baseweb="tab-list"] {
        gap: 8px;
        background-color: #111827;
        padding: 6px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.05);
    }
    .stTabs [aria-selected="true"] {
        background: linear-gradient(90deg, #7c3aed 0%, #6366f1 100%) !important;
        color: #ffffff !important;
    }
    table { width: 100%; border-collapse: separate; border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; }
    th { background-color: #1e293b !important; color: #e2e8f0 !important; padding: 12px 14px !important; }
    td { background-color: #0f172a !important; border-top: 1px solid rgba(255, 255, 255, 0.05) !important; padding: 12px 14px !important; }
    .tip-box {
        background: linear-gradient(135deg, rgba(30, 41, 59, 0.6) 0%, rgba(15, 23, 42, 0.8) 100%);
        border: 1px solid rgba(139, 92, 246, 0.3);
        border-radius: 12px;
        padding: 16px 20px;
        margin-bottom: 12px;
    }
</style>
""",
    unsafe_allow_html=True,
)

# Header Section with Team Badge
st.markdown(
    '<p class="main-header">⚡ LearnPulse OS</p>', unsafe_allow_html=True
)
st.markdown(
    """
    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 24px; flex-wrap: wrap; gap: 10px;">
        <span class="sub-header">AI-Assisted Study Planning & Adaptive Rescheduling</span>
        <span class="team-badge">🎓 Viswesh and team | Dept of CSE</span>
    </div>
    """,
    unsafe_allow_html=True,
)

# Sidebar
with st.sidebar:
    st.markdown("### ⚙️ System Config")
    api_key = st.text_input(
        "Gemini API Key", type="password", placeholder="AIzaSy..."
    )
    daily_hours = st.slider("Daily Focus Capacity (Hours)", 1, 12, 4)
    st.markdown("---")
    st.caption("💻 **Viswesh and team | Dept of CSE**")

if not api_key:
    st.info("👈 Enter your Gemini API key in the sidebar to activate the planner.")
    st.stop()

client = genai.Client(api_key=api_key)

# ==========================================
# 2. Subject Inputs & Priority Math
# ==========================================
st.markdown("#### 🎯 Subject Targets & Examination Windows")
col1, col2, col3 = st.columns([3, 2, 2])
with col1:
    s1 = st.text_input("Subject 1", "DBMS")
    s2 = st.text_input("Subject 2", "Operating Systems")
    s3 = st.text_input("Subject 3", "Engineering Mathematics")

with col2:
    d1 = st.slider(f"{s1} Difficulty", 1, 5, 5, key="d1")
    d2 = st.slider(f"{s2} Difficulty", 1, 5, 3, key="d2")
    d3 = st.slider(f"{s3} Difficulty", 1, 5, 4, key="d3")

with col3:
    today = date.today()
    date1 = st.date_input("Exam 1 Date", today, key="date1")
    date2 = st.date_input("Exam 2 Date", today, key="date2")
    date3 = st.date_input("Exam 3 Date", today, key="date3")

# Deterministic Priority Formula: P_i = D_i / T_i
data = [
    {"name": s1, "diff": d1, "days": max((date1 - today).days, 1)},
    {"name": s2, "diff": d2, "days": max((date2 - today).days, 1)},
    {"name": s3, "diff": d3, "days": max((date3 - today).days, 1)},
]
total_score = sum(item["diff"] / item["days"] for item in data)
weights = {
    item["name"]: round(((item["diff"] / item["days"]) / total_score) * 100, 1)
    for item in data
}

# ==========================================
# 3. Priority Graph (Native Progress Bars)
# ==========================================
st.markdown("#### 📈 Priority Distribution")
col_g1, col_g2, col_g3 = st.columns(3)
columns = [col_g1, col_g2, col_g3]

for idx, (sub, pct) in enumerate(weights.items()):
    with columns[idx % 3]:
        st.markdown(f"**{sub}** — `{pct}% Weight`")
        st.progress(min(max(float(pct) / 100.0, 0.0), 1.0))

# Safe JSON parsing helper
def safe_parse_schedule(raw_response):
    cleaned = re.sub(
        r"^```(?:json)?\s*", "", raw_response.strip(), flags=re.MULTILINE
    )
    cleaned = re.sub(r"^```\s*$", "", cleaned.strip(), flags=re.MULTILINE)
    res = json.loads(cleaned)
    if isinstance(res, list):
        return {"schedule": res, "study_tips": []}
    if isinstance(res, dict) and "schedule" in res:
        if isinstance(res["schedule"], dict):
            converted = [
                {"day": str(k), "slots": v if isinstance(v, list) else []}
                for k, v in res["schedule"].items()
            ]
            return {"schedule": converted, "study_tips": res.get("study_tips", [])}
        return res
    return {"schedule": [], "study_tips": []}

# ==========================================
# 4. Schedule Generation
# ==========================================
if st.button("⚡ Generate AI Schedule", type="primary", use_container_width=True):
    with st.spinner("Generating schedule and actionable study tips..."):
        prompt = f"""
        Act as an academic coach. Return ONLY valid JSON:
        {{
          "schedule": [
            {{
              "day": "Day 1",
              "slots": [
                {{"subject": "{s1}", "topic": "Core foundational topic", "hours": 2}},
                {{"subject": "{s2}", "topic": "Core mechanism or concept", "hours": 1}},
                {{"subject": "Revision", "topic": "Daily recap and practice problems", "hours": 1}}
              ]
            }}
          ],
          "study_tips": [
            "Use active recall for high-weight topics rather than passive re-reading.",
            "Allocate dedicated blocks for formula memorization before daily practice sessions.",
            "Take short 5-minute breaks after each hour to maintain peak focus."
          ]
        }}
        Constraints:
        - Daily study limit: exactly {daily_hours} hours.
        - Subject weights based on priority: {weights}.
        - Always reserve 1 hour daily for revision.
        - Generate 4 to 5 high-impact, practical study tips customized to these subjects.
        """
        try:
            resp = client.models.generate_content(
                model="gemini-3.5-flash-lite", contents=prompt
            )
            st.session_state["plan"] = safe_parse_schedule(resp.text)
        except Exception as e:
            st.error(f"Error: {e}")

# Display Schedule
if "plan" in st.session_state and "schedule" in st.session_state["plan"]:
    plan_data = st.session_state["plan"]
    schedule_list = plan_data.get("schedule", [])
    
    st.divider()
    st.markdown("### 📊 Active Timetable")
    if schedule_list:
        days = [d.get("day", f"Day {i+1}") for i, d in enumerate(schedule_list)]
        tabs = st.tabs(days)
        for i, tab in enumerate(tabs):
            with tab:
                slots = schedule_list[i].get("slots", [])
                table_md = "| Subject | Focus Topic & Tasks | Allocated Time |\n| :--- | :--- | :--- |\n"
                for slot in slots:
                    table_md += f"| <span style='color:#38bdf8; font-weight:600;'>{slot.get('subject', '')}</span> | {slot.get('topic', '')} | <span style='color:#a78bfa;'>{slot.get('hours', '')} Hours</span> |\n"
                st.markdown(table_md, unsafe_allow_html=True)

    # Rebalancer
    st.divider()
    st.markdown("### 🔄 Adaptive Feedback Rebalancer")
    c1, c2, c3 = st.columns([2, 1, 1])
    with c1:
        missed_sub = st.selectbox("Interrupted Subject", [s1, s2, s3])
    with c2:
        missed_hrs = st.number_input("Missed Hours", 1, daily_hours, 2)
    with c3:
        st.write("")
        st.write("")
        if st.button("⚡ Re-Balance Plan", use_container_width=True):
            with st.spinner("Rebalancing..."):
                re_prompt = f"""
                Student missed {missed_hrs}h of {missed_sub}. Current schedule: {json.dumps(schedule_list)}.
                Redistribute these hours without exceeding {daily_hours}h daily. Return ONLY JSON matching schema:
                {{
                  "schedule": [{{"day": "Day 1", "slots": [{{"subject": "...", "topic": "...", "hours": 2}}]}}],
                  "study_tips": ["Rebalancing tip 1", "Rebalancing tip 2"]
                }}
                """
                re_resp = client.models.generate_content(
                    model="gemini-3.5-flash-lite", contents=re_prompt
                )
                st.session_state["plan"] = safe_parse_schedule(re_resp.text)
                st.rerun()

    # Calendar Export
    st.divider()
    cal = Calendar()
    cal.add("prodid", "-//LearnPulse OS//EN")
    cal.add("version", "2.0")
    for day_info in schedule_list:
        for slot in day_info.get("slots", []):
            ev = Event()
            ev.add(
                "summary", f"{slot.get('subject', '')}: {slot.get('topic', '')}"
            )
            ev.add("dtstart", datetime.now())
            ev.add("description", f"Duration: {slot.get('hours', '')}h")
            cal.add_component(ev)

    st.download_button(
        label="📥 Download Calendar File (.ics)",
        data=cal.to_ical(),
        file_name="study_plan.ics",
        mime="text/calendar",
        use_container_width=True,
    )

    # ==========================================
    # 5. Dedicated Study Tips Section (At the end)
    # ==========================================
    st.divider()
    st.markdown("### 💡 Recommended Study Strategies & Tips")
    tips = plan_data.get("study_tips", [])
    if tips:
        for tip in tips:
            st.markdown(
                f"""
                <div class="tip-box">
                    <span style="color:#a78bfa; font-weight:700; font-size:1.1rem;">⚡ Strategy:</span> 
                    <span style="color:#e2e8f0; font-size:0.95rem;">{tip}</span>
                </div>
                """,
                unsafe_allow_html=True,
            )
    else:
        st.markdown(
            """
            <div class="tip-box">
                <span style="color:#a78bfa; font-weight:700; font-size:1.1rem;">⚡ Strategy:</span> 
                <span style="color:#e2e8f0; font-size:0.95rem;">Maintain consistent daily study slots and focus intensely on high-weight topics during your first two study hours.</span>
            </div>
            """,
            unsafe_allow_html=True,
        )

# Footer
st.divider()
st.markdown(
    """
    <div style="text-align: center; color: #64748b; font-size: 0.85rem; padding: 12px 0;">
        Academic Mini-Project &bull; <b>Viswesh and team | Dept of CSE</b> &bull; Powered by Google Gemini & Streamlit
    </div>
    """,
    unsafe_allow_html=True,
)