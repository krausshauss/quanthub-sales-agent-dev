/**
 * activityTracker.js — daily KPI progress bars
 */
window.ActivityTracker = (() => {

  const ROWS = [
    { key: "calls",      label: "Calls",       color: "#818cf8" },
    { key: "emails",     label: "Emails",       color: "#22c97a" },
    { key: "meetings",   label: "Meetings",     color: "#f5a623" },
    { key: "tasks",      label: "Tasks",        color: "#60a5fa" },
    { key: "sequences",  label: "Sequences",    color: "#fb923c" },
    { key: "crmUpdates", label: "CRM Updates",  color: "#f87171" },
  ];

  function pct(a, b) { return b === 0 ? 0 : Math.min(100, Math.round((a / b) * 100)); }

  function render(activities) {
    const el = document.getElementById("activity-tracker");
    if (!el) return;

    if (!activities || !Object.keys(activities).length) {
      el.innerHTML = `<div style="color:#4b5563;font-size:12px;padding:8px 0">No activity data available.</div>`;
      return;
    }

    el.innerHTML = ROWS.map(row => {
      const act = activities[row.key] || { completed: 0, target: 1 };
      const p = pct(act.completed, act.target);
      const overTarget = act.completed >= act.target;
      return `
        <div class="act-row">
          <span class="act-label">${row.label}</span>
          <div class="act-bar-bg">
            <div class="act-bar-fill" style="width:${p}%;background:${overTarget ? '#22c97a' : row.color}"></div>
          </div>
          <span class="act-counts">
            ${act.completed}<span class="target">/${act.target}</span>
          </span>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const el = document.getElementById("activity-tracker");
    if (!el) return;
    el.innerHTML = ROWS.map(() => `<div class="skeleton-block" style="height:20px;margin:6px 0"></div>`).join("");
  }

  return { render, renderLoading };
})();


/**
 * dealVelocity.js — pipeline by stage
 */
window.DealVelocity = (() => {

  const COLORS = ["#818cf8", "#22c97a", "#f5a623", "#60a5fa", "#fb923c", "#f87171"];

  function fmtMoney(n) {
    if (n >= 1_000_000) return `$${(n/1_000_000).toFixed(1)}M`;
    if (n >= 1_000)     return `$${(n/1_000).toFixed(0)}K`;
    return `$${n}`;
  }

  function render(deals) {
    const el = document.getElementById("deal-velocity");
    if (!el) return;

    if (!deals || !deals.length) {
      el.innerHTML = `<div style="color:#4b5563;font-size:12px;padding:8px 0">No open deals found.</div>`;
      return;
    }

    // Aggregate by stage
    const stageMap = {};
    deals.forEach(d => {
      const key = d.stageLabel || d.stage || "Unknown";
      if (!stageMap[key]) stageMap[key] = { value: 0, count: 0 };
      stageMap[key].value += d.amount;
      stageMap[key].count++;
    });

    // Sort by value desc, exclude closed
    const stages = Object.entries(stageMap)
      .filter(([k]) => !k.toLowerCase().includes("closed"))
      .sort((a, b) => b[1].value - a[1].value)
      .slice(0, 6);

    const maxVal = stages[0]?.[1].value || 1;

    el.innerHTML = stages.map(([stage, data], i) => {
      const barPct = Math.round((data.value / maxVal) * 100);
      return `
        <div class="stage-row">
          <span class="stage-name">${stage}</span>
          <div class="stage-bar-bg">
            <div class="stage-bar-fill" style="width:${barPct}%;background:${COLORS[i % COLORS.length]}"></div>
          </div>
          <span class="stage-val">${fmtMoney(data.value)}</span>
          <span class="stage-count">${data.count}</span>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const el = document.getElementById("deal-velocity");
    if (!el) return;
    el.innerHTML = [1,2,3,4].map(() => `<div class="skeleton-block" style="height:20px;margin:6px 0"></div>`).join("");
  }

  return { render, renderLoading };
})();


/**
 * leadFeed.js — hot lead activity signals
 */
window.LeadFeed = (() => {

  const SIGNAL_COLORS = {
    hot:    "#f87171",
    warm:   "#fbbf24",
    cold:   "#4b5563",
  };

  function signalLevel(hoursAgo) {
    if (hoursAgo <= 4)  return "hot";
    if (hoursAgo <= 24) return "hot";
    if (hoursAgo <= 48) return "warm";
    return "cold";
  }

  function relTime(hoursAgo) {
    if (hoursAgo < 1)  return "< 1 hr ago";
    if (hoursAgo < 24) return `${hoursAgo}h ago`;
    return `${Math.floor(hoursAgo / 24)}d ago`;
  }

  function render(leads) {
    const el = document.getElementById("lead-feed");
    const badge = document.getElementById("lead-count-badge");
    if (!el) return;

    // Sort by most recent activity first
    const sorted = [...(leads || [])].sort((a, b) => a.hoursAgo - b.hoursAgo);
    const hot = sorted.filter(l => l.isHot);

    if (badge) {
      if (hot.length > 0) {
        badge.textContent = `${hot.length} HOT`;
        badge.style.display = "inline-block";
      } else {
        badge.style.display = "none";
      }
    }

    if (!sorted.length) {
      el.innerHTML = `<div style="color:#4b5563;font-size:12px;padding:10px 20px">No lead activity signals.</div>`;
      return;
    }

    el.innerHTML = sorted.slice(0, 8).map(l => {
      const sig = signalLevel(l.hoursAgo);
      const dotColor = SIGNAL_COLORS[sig];
      const eventText = l.stage
        ? `${l.stage.replace(/_/g, " ")}${l.company ? ` · ${l.company}` : ""}`
        : l.company || "Activity detected";

      return `
        <div class="lead-item">
          <div class="lead-dot" style="background:${dotColor}"></div>
          <div class="lead-body">
            <div class="lead-name">${escHtml(l.name)}</div>
            <div class="lead-event">${escHtml(eventText)}</div>
          </div>
          <div class="lead-time">${relTime(l.hoursAgo)}</div>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const el = document.getElementById("lead-feed");
    if (!el) return;
    el.innerHTML = [1,2,3].map(() => `<div class="skeleton-block" style="height:18px;margin:6px 0"></div>`).join("");
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  return { render, renderLoading };
})();
