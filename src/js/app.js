/**
 * app.js
 * ─────────────────────────────────────────────
 * Main orchestrator. Coordinates data loading,
 * AI generation, component rendering, and refresh loop.
 */

window.App = (() => {

  let _data       = null;
  let _aiData     = null;
  let _repEmail   = new URLSearchParams(window.location.search).get("rep") || window.CONFIG.CURRENT_REP_EMAIL;
  let _refreshTimer = null;

  // ── Bootstrap ──────────────────────────────────────────────────────
  async function init() {
    setHeaderSub();
    updateLiveBadge("connecting");

    // Manager: load rep selector
    if (window.CONFIG.IS_MANAGER) {
      await loadRepSelector();
    }

    window.HubSpot.fetchPortalId(); // warm cache non-blocking — used for deep links
    await refresh();

    // Auto-refresh loop
    _refreshTimer = setInterval(refresh, window.CONFIG.REFRESH_INTERVAL_MS);
  }

  // ── Full refresh ───────────────────────────────────────────────────
  async function refresh() {
    showLoading();

    try {
      // 1. Load HubSpot data
      _data = await window.HubSpot.loadAll(_repEmail);
      updateKPIs(_data);
      renderComponents(_data);
      updateLiveBadge("live");
      setLastRefresh();

      // 2. Build forecast card (fast — no AI needed)
      buildForecastCard(_data);

      // 3. Load AI priorities + follow-up checklist in parallel (slower)
      loadAI(_data);
      loadChecklist(_data);

    } catch (err) {
      console.error("[App] Data load failed:", err);
      showError(`HubSpot data error: ${err.message}`);
      updateLiveBadge("error");
    }
  }

  // ── Load Follow-Up Checklist from engagements (non-blocking) ────────
  async function loadChecklist(data) {
    const repName = emailToName(_repEmail);
    try {
      window.ChecklistFeed.renderLoading();
      const engagements = await window.HubSpot.fetchEngagements(_repEmail);
      const checklist = await window.Agent.generateFollowUpChecklist(repName, engagements, data.deals);
      if (checklist) {
        enrichChecklistLinks(checklist, data);
        window.ChecklistFeed.render(checklist);
      } else {
        window.ChecklistFeed.renderError("No actionable follow-ups found in recent engagements.");
      }
    } catch (err) {
      console.error("[App] Checklist load failed:", err);
      window.ChecklistFeed.renderError(err.message);
    }
  }

  // ── Load AI priorities (non-blocking) ─────────────────────────────
  async function loadAI(data) {
    const repName = emailToName(_repEmail);
    try {
      window.PriorityFeed.renderLoading();
      _aiData = await window.Agent.generateDailyPriorities(repName, data);

      if (_aiData) {
        window.PriorityFeed.render(_aiData.priorities);
        window.PriorityFeed.renderInsight(_aiData.insight);
        updateScoreRing(_aiData.score, _aiData.scoreDelta);
        updateKpiScoreDetail(_aiData.scoreDelta);

        // Optional: push Slack digest
        if (window.CONFIG.SLACK_ENABLED) {
          const digest = await window.Agent.generateSlackDigest(repName, _aiData.priorities, _aiData.score, _aiData.insight);
          if (digest) pushSlack(digest);
        }
      }
    } catch (err) {
      console.error("[App] AI load failed:", err);
      window.PriorityFeed.renderError(err.message);
    }
  }

  // ── Ask agent (ad-hoc) ────────────────────────────────────────────
  async function askAgent() {
    const input = document.getElementById("agent-input");
    const question = input?.value?.trim();
    if (!question || !_data) return;

    input.disabled = true;
    window.PriorityFeed.renderAgentResponse("Thinking...");

    try {
      const repName = emailToName(_repEmail);
      const answer = await window.Agent.askQuestion(question, repName, _data);
      window.PriorityFeed.renderAgentResponse(answer);
    } catch (err) {
      window.PriorityFeed.renderAgentResponse(`Error: ${err.message}`);
    } finally {
      if (input) { input.disabled = false; input.value = ""; }
    }
  }

  // ── Manager: switch rep ────────────────────────────────────────────
  async function switchRep(email) {
    if (!email || email === _repEmail) return;
    _repEmail = email;
    setHeaderSub();
    await refresh();
  }

  // ── KPI updates ───────────────────────────────────────────────────
  function updateKPIs(data) {
    const { deals, leads, activities } = data;

    // Pipeline
    const total = deals.reduce((s, d) => s + d.amount, 0);
    setEl("kpi-pipeline", window.HubSpot.fmtMoney(total));
    setEl("kpi-pipeline-sub", `${deals.length} open deals`);

    // Activities
    const actDone = Object.values(activities).reduce((s, a) => s + (a.completed || 0), 0);
    const actTarget = Object.values(activities).reduce((s, a) => s + (a.target || 0), 0);
    const actPct = actTarget ? Math.round((actDone / actTarget) * 100) : 0;
    setEl("kpi-activities", `${actDone}/${actTarget}`);
    setEl("kpi-activities-sub", `${actPct}% of daily target`);

    // At risk
    const atRisk = deals.filter(d => d.isAtRisk).length;
    setEl("kpi-risk", atRisk);
    const riskEl = document.getElementById("kpi-risk");
    if (riskEl) riskEl.className = `kpi-big${atRisk > 0 ? " risk" : ""}`;

    // Hot leads
    const hot = leads.filter(l => l.isHot).length;
    setEl("kpi-leads", hot);
  }

  function updateScoreRing(score, delta) {
    setEl("ring-val", score ?? "—");
    setEl("ring-delta", delta ?? "");
    const fill = document.getElementById("ring-fill");
    if (fill && score != null) {
      const circ = 2 * Math.PI * 26; // r=26
      const dashArr = `${(score / 100) * circ} ${circ}`;
      fill.setAttribute("stroke-dasharray", dashArr);
      const color = score >= 80 ? "#22c97a" : score >= 60 ? "#f5a623" : "#f87171";
      fill.setAttribute("stroke", color);
      setEl("ring-val", score);
      document.getElementById("ring-val").style.color = color;
    }
  }

  function updateKpiScoreDetail(delta) {
    const el = document.getElementById("kpi-score-detail");
    if (!el || !delta) return;
    const up = delta.startsWith("+");
    el.textContent = `${delta} pts vs yesterday`;
    el.style.color = up ? "#22c97a" : delta.startsWith("-") ? "#f87171" : "#7b8099";
  }

  // ── Component rendering ────────────────────────────────────────────
  function renderComponents(data) {
    window.ActivityTracker.render(data.activities);
    window.DealVelocity.render(data.deals);
    window.LeadFeed.render(data.leads);
  }

  function showLoading() {
    window.ActivityTracker.renderLoading();
    window.DealVelocity.renderLoading();
    window.LeadFeed.renderLoading();
  }

  // ── Manager: load rep selector ────────────────────────────────────
  async function loadRepSelector() {
    const wrap = document.getElementById("rep-selector");
    const sel  = document.getElementById("rep-select");
    if (!wrap || !sel) return;
    try {
      const owners = await window.HubSpot.fetchOwners();
      owners.forEach(o => {
        const opt = document.createElement("option");
        opt.value = o.email;
        opt.textContent = o.name;
        if (o.email === _repEmail) opt.selected = true;
        sel.appendChild(opt);
      });
      wrap.style.display = "block";
    } catch (e) {
      console.warn("Could not load rep list:", e.message);
    }
  }

  // ── Slack push ────────────────────────────────────────────────────
  async function pushSlack(digest) {
    try {
      await fetch(`${window.CONFIG.WORKER_URL}/slack/digest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...digest, repEmail: _repEmail }),
      });
    } catch (e) {
      console.warn("Slack push failed:", e.message);
    }
  }

  // ── UI helpers ─────────────────────────────────────────────────────
  function setHeaderSub() {
    const name = emailToName(_repEmail);
    const day  = new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
    setEl("header-sub", `${name} · ${day}`);
  }

  function setLastRefresh() {
    const el = document.getElementById("last-refresh");
    if (el) el.textContent = `Updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  }

  function updateLiveBadge(state) {
    const el = document.getElementById("live-badge");
    if (!el) return;
    const states = {
      connecting: { text: "● CONNECTING", cls: "badge badge-live connecting" },
      live:       { text: "● LIVE",        cls: "badge badge-live" },
      error:      { text: "● ERROR",       cls: "badge badge-live connecting" },
    };
    const s = states[state] || states.live;
    el.textContent = s.text;
    el.className = s.cls;
  }

  function showError(msg) {
    const feed = document.getElementById("priority-feed");
    if (feed) feed.innerHTML = `<div class="error-bar">⚠ ${msg}</div>`;
  }

  function setEl(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  function emailToName(email) {
    return (email || "").split("@")[0]
      .replace(/[._]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase());
  }

  // ── Personal Q2 Forecast Card ─────────────────────────────────────
  function buildForecastCard(data) {
    const el = document.getElementById('forecast-card');
    if (!el || !data) return;

    const deals    = data.deals || [];
    const repEmail = _repEmail;

    // Stage probability map (mirrors HubSpot defaults)
    const PROB = {
      appointmentscheduled: 0.20, qualifiedtobuy: 0.40,
      presentationscheduled: 0.60, decisionmakerboughtin: 0.70,
      contractsent: 0.90, default: 0.30,
    };
    const probFor = stage => PROB[stage] || PROB.default;

    const weightedPipe = deals.reduce((s, d) => s + d.amount * probFor(d.stage), 0);
    const rawPipe      = deals.reduce((s, d) => s + d.amount, 0);

    // Quarterly quota from config (per rep)
    const quota     = window.CONFIG.QUARTERLY_QUOTA || 100000;
    const qtrCW     = 0; // we don't have rep-level YTD CW in sales agent data — show pipeline-based
    const projected = weightedPipe;
    const projLow   = projected * 0.75;
    const projHigh  = projected * 1.25;

    // Weeks to quarter end
    const now = new Date();
    const qEnds = [new Date(now.getFullYear(),2,31), new Date(now.getFullYear(),5,30),
                   new Date(now.getFullYear(),8,30), new Date(now.getFullYear(),11,31)];
    const qEnd     = qEnds.find(d => d >= now) || qEnds[3];
    const weeksLeft = Math.max(0, Math.ceil((qEnd - now) / (7 * 864e5)));

    // Runway widths as % of quota
    const pipePct = Math.min(94, (projHigh / quota) * 100);
    const verdict = projected >= quota ? 'on-track' : projected >= quota * 0.6 ? 'at-risk' : 'behind';
    const verdictLbl = verdict === 'on-track' ? '✓ On Track' : verdict === 'at-risk' ? '⚠ At Risk' : '▼ Behind Pace';

    const fK = v => v >= 1e6 ? '$' + (v/1e6).toFixed(1) + 'M' : '$' + (v/1000).toFixed(0) + 'K';
    const gapColor = projected >= quota ? 'var(--accent)' : 'var(--red)';

    el.innerHTML = `
      <div class="fc-runway-labels">
        <span style="color:var(--brand);font-weight:700">${fK(projected)} weighted pipe</span>
        <span>$${(quota/1000).toFixed(0)}K quota</span>
      </div>
      <div class="fc-runway">
        <div class="fc-runway-cw"   style="width:${Math.min(94, (projected/quota*100)).toFixed(1)}%" title="Weighted pipeline ${fK(projected)}"></div>
        <div class="fc-runway-proj" style="width:${Math.min(94 - projected/quota*100, (projHigh-projected)/quota*100).toFixed(1)}%" title="Upside to ${fK(projHigh)}"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:5px;">
        <span class="fc-verdict fc-${verdict}">${verdictLbl}</span>
        <span style="font-size:9px;color:var(--text-hint)">${weeksLeft} wk${weeksLeft!==1?'s':''} to ${qEnd.toLocaleDateString('en-US',{month:'short',day:'numeric'})}</span>
      </div>
      <div class="fc-stats">
        <div class="fc-stat">
          <div class="fc-stat-l">Open Pipeline</div>
          <div class="fc-stat-v">${fK(rawPipe)}</div>
          <div class="fc-stat-s">${deals.length} active deals</div>
        </div>
        <div class="fc-stat">
          <div class="fc-stat-l">Weighted Forecast</div>
          <div class="fc-stat-v">${fK(projected)}</div>
          <div class="fc-stat-s">${fK(projLow)} – ${fK(projHigh)} range</div>
        </div>
        <div class="fc-stat">
          <div class="fc-stat-l">Gap to Quota</div>
          <div class="fc-stat-v" style="color:${gapColor}">${projected>=quota?'✓ Met':fK(Math.max(0,quota-projected))}</div>
          <div class="fc-stat-s">$${(quota/1000).toFixed(0)}K quarterly target</div>
        </div>
      </div>`;
  }

  // ── Enrich checklist items with HubSpot record IDs for deep links ───
  function enrichChecklistLinks(checklist, data) {
    if (!checklist?.items) return;
    checklist.items = checklist.items.map(item => ({
      ...item,
      dealId:    matchDealId(item.deal, data.deals),
      contactId: matchContactId(item.contact, data.contacts),
    }));
  }

  function matchDealId(dealName, deals) {
    if (!dealName || !deals?.length) return null;
    const q = dealName.toLowerCase();
    const match = deals.find(d => {
      const n = d.name.toLowerCase();
      return n === q || n.includes(q) || q.includes(n);
    });
    return match?.id || null;
  }

  function matchContactId(contactName, contacts) {
    if (!contactName || !contacts?.length) return null;
    const q = contactName.toLowerCase();
    return contacts.find(c => c.name.toLowerCase() === q)?.id || null;
  }

  // ── Enter key on agent input ───────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const input = document.getElementById("agent-input");
    if (input) {
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") askAgent();
      });
    }
    init();
  });

  return { refresh, askAgent, switchRep };

})();
