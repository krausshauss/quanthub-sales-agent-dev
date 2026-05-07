/**
 * checklistFeed.js
 * ─────────────────────────────────────────────
 * Follow-up checklist driven by recent meeting notes,
 * call logs, and emails (including Fathom AI summaries).
 */

window.ChecklistFeed = (() => {

  let _items = [];

  const PRIORITY_STYLE = {
    high:   { dot: "🔴", cls: "cl-high" },
    medium: { dot: "🟡", cls: "cl-med"  },
    low:    { dot: "⚪", cls: "cl-low"  },
  };

  const SOURCE_ICON = {
    meeting: "📹",
    call:    "📞",
    email:   "✉️",
  };

  function sourceIcon(source) {
    const sl = (source || "").toLowerCase();
    if (sl.startsWith("meeting")) return SOURCE_ICON.meeting;
    if (sl.startsWith("call"))    return SOURCE_ICON.call;
    if (sl.startsWith("email"))   return SOURCE_ICON.email;
    return "•";
  }

  function escHtml(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function render(checklist) {
    const feed = document.getElementById("checklist-feed");
    const meta = document.getElementById("checklist-meta");
    if (!feed) return;

    _items = checklist?.items || [];

    if (!_items.length) {
      feed.innerHTML = `<div class="cl-empty">No follow-ups extracted — check back after your next meeting or call.</div>`;
      return;
    }

    if (meta && checklist.generatedFrom) {
      meta.textContent = checklist.generatedFrom;
    }

    feed.innerHTML = _items.map((item, i) => {
      const ps = PRIORITY_STYLE[item.priority] || PRIORITY_STYLE.medium;
      const icon = sourceIcon(item.source);
      const dealBadge = item.deal
        ? `<span class="cl-deal">${escHtml(item.deal)}</span>`
        : "";
      const contactBadge = item.contact
        ? `<span class="cl-contact">${escHtml(item.contact)}</span>`
        : "";

      return `
        <div class="cl-item fade-up ${ps.cls}" style="animation-delay:${i * 50}ms" id="cl-item-${i}">
          <label class="cl-check-wrap" onclick="event.stopPropagation()" title="Mark done">
            <input type="checkbox" class="cl-checkbox" onchange="ChecklistFeed.onCheck(${i}, this.checked)" />
            <span class="cl-checkmark"></span>
          </label>
          <div class="cl-body">
            <div class="cl-task">${ps.dot} ${escHtml(item.task)}</div>
            <div class="cl-context">${escHtml(item.context)}</div>
            <div class="cl-badges">
              ${dealBadge}${contactBadge}
              <span class="cl-source">${icon} ${escHtml(item.source)}</span>
            </div>
          </div>
        </div>`;
    }).join("");
  }

  function renderLoading() {
    const feed = document.getElementById("checklist-feed");
    if (!feed) return;
    feed.innerHTML = [1, 2, 3].map(i =>
      `<div class="skeleton-block" style="height:52px;animation-delay:${i * 100}ms"></div>`
    ).join("");
  }

  function renderError(msg) {
    const feed = document.getElementById("checklist-feed");
    if (!feed) return;
    feed.innerHTML = `<div class="cl-empty">${escHtml(msg || "Could not generate follow-up checklist.")}</div>`;
  }

  function onCheck(index, checked) {
    const el = document.getElementById(`cl-item-${index}`);
    if (el) el.classList.toggle("cl-done", checked);
  }

  return { render, renderLoading, renderError, onCheck };

})();
