/**
 * priorityFeed.js
 * ─────────────────────────────────────────────
 * Renders the AI-directed priority action list.
 * SalesLoft-style: ranked, tagged, actionable.
 */

window.PriorityFeed = (() => {

  let _priorities = [];

  const TAG_CLASS = {
    "Hot":      "tag-hot",
    "Follow-up":"tag-followup",
    "At risk":  "tag-atrisk",
    "New opp":  "tag-newopp",
    "Admin":    "tag-admin",
    "Lead":     "tag-lead",
    "Sequence": "tag-sequence",
  };

  const RANK_STYLES = [
    { bg: "#2d1010", color: "#f87171" },
    { bg: "#2d2206", color: "#fbbf24" },
    { bg: "#1e2035", color: "#818cf8" },
    { bg: "#0d2d1e", color: "#22c97a" },
    { bg: "#0e1a2d", color: "#60a5fa" },
  ];

  function fmtValue(v) {
    if (!v) return "";
    if (v >= 1_000_000) return `$${(v/1_000_000).toFixed(1)}M`;
    if (v >= 1_000)     return `$${(v/1_000).toFixed(0)}K`;
    return `$${v}`;
  }

  function render(priorities) {
    const feed = document.getElementById("priority-feed");
    if (!feed) return;

    _priorities = priorities || [];

    if (!_priorities.length) {
      feed.innerHTML = `<div class="error-bar">No priorities generated. Check your Claude API connection.</div>`;
      return;
    }

    feed.innerHTML = _priorities.map((p, i) => {
      const style = RANK_STYLES[i] || RANK_STYLES[4];
      const tagClass = TAG_CLASS[p.tag] || "tag-admin";

      return `
        <div class="priority-item fade-up" style="animation-delay:${i * 60}ms" data-rank="${p.rank}" id="pri-item-${i}">
          <label class="pri-check-wrap" onclick="event.stopPropagation()" title="Mark complete">
            <input type="checkbox" class="pri-checkbox" onchange="PriorityFeed.onCheckboxChange(${i}, this.checked)" />
            <span class="pri-checkmark"></span>
          </label>
          <div class="pri-rank" style="background:${style.bg};color:${style.color}">${p.rank}</div>
          <div class="pri-body" onclick="PriorityFeed.onItemClick(${i})" style="cursor:pointer;flex:1">
            <div class="pri-title">${escHtml(p.title)}</div>
            <div class="pri-detail">${escHtml(p.detail)}</div>
            <div class="pri-meta">
              <span class="tag ${tagClass}">${escHtml(p.tag)}</span>
              ${p.contactName ? `<span class="days-badge">${escHtml(p.contactName)}</span>` : ""}
            </div>
          </div>
          <div class="pri-right">
            ${p.dealValue ? `<span class="pri-value">${fmtValue(p.dealValue)}</span>` : ""}
          </div>
        </div>`;
    }).join("");

    // Update timestamp
    const ts = document.getElementById("priority-timestamp");
    if (ts) ts.textContent = `Generated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function renderLoading() {
    const feed = document.getElementById("priority-feed");
    if (!feed) return;
    feed.innerHTML = [1,2,3,4,5].map(i =>
      `<div class="skeleton-block" style="animation-delay:${i*100}ms"></div>`
    ).join("");
  }

  function renderInsight(text) {
    const box = document.getElementById("insight-box");
    const el  = document.getElementById("insight-text");
    if (!box || !el) return;
    if (text) {
      el.textContent = text;
      box.style.display = "block";
    } else {
      box.style.display = "none";
    }
  }

  function renderAgentResponse(text) {
    const el = document.getElementById("agent-response");
    if (!el) return;
    if (text) {
      el.textContent = text;
      el.style.display = "block";
    } else {
      el.style.display = "none";
    }
  }

  function onItemClick(index) {
    const input = document.getElementById("agent-input");
    if (input) {
      const p = _priorities[index];
      const title = p?.title || "";
      input.value = `What's the best approach for: "${title}"?`;
      input.focus();
    }
  }

  async function onCheckboxChange(index, checked) {
    const item = document.getElementById(`pri-item-${index}`);
    if (!item) return;

    if (checked) {
      item.classList.add("pri-done");
      const p = _priorities[index];
      try {
        const repEmail = new URLSearchParams(window.location.search).get("rep")
          || (window.CONFIG && window.CONFIG.CURRENT_REP_EMAIL) || "";
        await fetch(`${window.CONFIG.WORKER_URL}/hubspot/activity`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title:      p.title,
            detail:     p.detail,
            ownerEmail: repEmail,
          }),
        });
      } catch (e) {
        console.warn("[PriorityFeed] Activity log failed:", e.message);
      }
    } else {
      item.classList.remove("pri-done");
    }
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderError(msg) {
    const feed = document.getElementById("priority-feed");
    if (!feed) return;
    feed.innerHTML = `<div class="error-bar">${msg || "Claude API unavailable. Check API key or account credits."}</div>`;
  }

  return { render, renderLoading, renderInsight, renderError, renderAgentResponse, onItemClick, onCheckboxChange };

})();
