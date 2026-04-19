/**
 * hubspot.js
 * ─────────────────────────────────────────────
 * All HubSpot data fetching via Cloudflare Worker proxy.
 * Returns normalized data structures used by all components.
 */

window.HubSpot = (() => {

  const BASE = () => window.CONFIG.WORKER_URL;

  // Stage label cache — populated on first loadAll(), merged with CONFIG.STAGE_LABELS
  let _stageLabels = {};

  async function fetchStageLabels() {
    try {
      const data = await api("/hubspot/stages");
      _stageLabels = { ...data, ...window.CONFIG.STAGE_LABELS }; // config overrides take precedence
    } catch {
      _stageLabels = { ...window.CONFIG.STAGE_LABELS };
    }
  }

  function stageLabel(stageId) {
    return _stageLabels[stageId] || window.CONFIG.STAGE_LABELS[stageId] || (stageId || "Unknown").replace(/_/g, " ");
  }

  // ── Core fetch wrapper ─────────────────────────────────────────────
  async function api(path, options = {}) {
    const res = await fetch(`${BASE()}${path}`, {
      ...options,
      headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.statusText);
      throw new Error(`Worker ${path}: ${res.status} — ${err}`);
    }
    return res.json();
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function daysSince(isoDate) {
    if (!isoDate) return 999;
    return Math.floor((Date.now() - new Date(isoDate).getTime()) / 86_400_000);
  }

  function hoursSince(isoDate) {
    if (!isoDate) return 999;
    return Math.floor((Date.now() - new Date(isoDate).getTime()) / 3_600_000);
  }

  function fmtMoney(n) {
    const num = parseFloat(n) || 0;
    if (num >= 1_000_000) return `$${(num / 1_000_000).toFixed(1)}M`;
    if (num >= 1_000)     return `$${(num / 1_000).toFixed(0)}K`;
    return `$${num.toFixed(0)}`;
  }

  // ── Deals ──────────────────────────────────────────────────────────
  async function fetchDeals(ownerEmail) {
    const raw = await api(`/hubspot/deals?owner=${encodeURIComponent(ownerEmail)}`);
    const CLOSED_TERMS = ["closed", "won", "lost"];
    const isClosedStage = (lbl) => CLOSED_TERMS.some(t => lbl.toLowerCase().includes(t));

    const deals = (raw.results || [])
      .map(d => {
        const p = d.properties || {};
        const stageLbl = stageLabel(p.dealstage);
        return {
          id:               d.id,
          name:             p.dealname || "Unnamed Deal",
          amount:           parseFloat(p.amount) || 0,
          amountFmt:        fmtMoney(p.amount),
          stage:            p.dealstage || "",
          stageLabel:       stageLbl,
          pipeline:         p.pipeline || "",
          closeDate:        p.closedate || null,
          daysToClose:      p.closedate ? Math.ceil((new Date(p.closedate) - Date.now()) / 86_400_000) : null,
          lastContact:      p.notes_last_updated || p.hs_lastmodifieddate || null,
          daysSinceContact: daysSince(p.notes_last_updated || p.hs_lastmodifieddate),
          probability:      parseFloat(p.hs_deal_stage_probability) || 0,
          isAtRisk:         daysSince(p.notes_last_updated || p.hs_lastmodifieddate) >= window.CONFIG.RISK_DAYS_NO_CONTACT,
          isClosed:         p.hs_is_closed === "true" || isClosedStage(stageLbl),
        };
      })
      .filter(d => !d.isClosed);

    return deals;
  }

  // ── Contacts ───────────────────────────────────────────────────────
  async function fetchContacts(ownerEmail) {
    const raw = await api(`/hubspot/contacts?owner=${encodeURIComponent(ownerEmail)}`);
    return (raw.results || []).map(c => {
      const p = c.properties || {};
      return {
        id:         c.id,
        name:       [p.firstname, p.lastname].filter(Boolean).join(" ") || p.email || "Unknown",
        email:      p.email || "",
        company:    p.company || "",
        lifecycle:  p.lifecyclestage || "",
        leadStatus: p.hs_lead_status || "",
        lastActivity: p.notes_last_updated || null,
      };
    });
  }

  // ── Leads (HubSpot Lead object) ────────────────────────────────────
  async function fetchLeads(ownerEmail) {
    const raw = await api(`/hubspot/leads?owner=${encodeURIComponent(ownerEmail)}`);
    return (raw.results || []).map(l => {
      const p = l.properties || {};
      const lastAct = p.hs_lastmodifieddate || p.createdate || null;
      return {
        id:          l.id,
        name:        p.hs_lead_name || "Unnamed Lead",
        stage:       p.hs_pipeline_stage || "",
        lastActivity: lastAct,
        hoursAgo:    hoursSince(lastAct),
        isHot:       hoursSince(lastAct) <= window.CONFIG.HOT_LEAD_HOURS,
        source:      p.hs_lead_source || "",
        company:     p.company || "",
      };
    });
  }

  // ── Activities (today) ─────────────────────────────────────────────
  async function fetchActivitiesToday(ownerEmail) {
    const raw = await api(`/hubspot/activities/today?owner=${encodeURIComponent(ownerEmail)}`);
    // Merge with config targets
    const t = window.CONFIG.ACTIVITY_TARGETS;
    return {
      calls:      { completed: raw.calls?.completed      || 0, target: raw.calls?.target      || t.calls },
      emails:     { completed: raw.emails?.completed     || 0, target: raw.emails?.target     || t.emails },
      meetings:   { completed: raw.meetings?.completed   || 0, target: raw.meetings?.target   || t.meetings },
      tasks:      { completed: raw.tasks?.completed      || 0, target: raw.tasks?.target      || t.tasks },
      sequences:  { completed: raw.sequences?.completed  || 0, target: raw.sequences?.target  || t.sequences },
      crmUpdates: { completed: raw.crmUpdates?.completed || 0, target: raw.crmUpdates?.target || t.crmUpdates },
    };
  }

  // ── Sequences (active) ─────────────────────────────────────────────
  async function fetchSequences(ownerEmail) {
    const raw = await api(`/hubspot/sequences?owner=${encodeURIComponent(ownerEmail)}`);
    return (raw.results || []).map(s => ({
      id:           s.id,
      contactName:  s.contactName || "Unknown",
      sequenceName: s.sequenceName || "",
      nextStep:     s.nextStep || "",
      nextStepDate: s.nextStepDate || null,
      stepNumber:   s.currentStep || 1,
      totalSteps:   s.totalSteps || 1,
    }));
  }

  // ── Owner list (for manager view) ─────────────────────────────────
  async function fetchOwners() {
    const raw = await api("/hubspot/owners");
    return (raw.results || []).map(o => ({
      id:    o.id,
      email: o.email || "",
      name:  [o.firstName, o.lastName].filter(Boolean).join(" ") || o.email,
    }));
  }

  // ── Bulk load for one rep ──────────────────────────────────────────
  async function loadAll(ownerEmail) {
    await fetchStageLabels(); // must complete before fetchDeals uses stageLabel()
    const [deals, contacts, leads, activities, sequences] = await Promise.allSettled([
      fetchDeals(ownerEmail),
      fetchContacts(ownerEmail),
      fetchLeads(ownerEmail),
      fetchActivitiesToday(ownerEmail),
      fetchSequences(ownerEmail),
    ]);

    return {
      deals:      deals.status      === "fulfilled" ? deals.value      : [],
      contacts:   contacts.status   === "fulfilled" ? contacts.value   : [],
      leads:      leads.status      === "fulfilled" ? leads.value      : [],
      activities: activities.status === "fulfilled" ? activities.value : {},
      sequences:  sequences.status  === "fulfilled" ? sequences.value  : [],
    };
  }

  return { loadAll, fetchOwners, fmtMoney };

})();
