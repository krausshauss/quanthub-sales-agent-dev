/**
 * config.js
 * ─────────────────────────────────────────────
 * All configuration for the Sales Agent app.
 * Edit this file to match your environment.
 */

window.CONFIG = {

  // ── Cloudflare Worker proxy URL ───────────────────────────────────
  // Your existing worker — we add new routes to it (see cloudflare-worker/index.js)
  WORKER_URL: "https://quanthub-sales-agent-dev.michael-20e.workers.dev",

  // ── Logged-in rep ─────────────────────────────────────────────────
  // In production, pull this from your auth system (cookie, JWT, etc.)
  // For development, hardcode a rep email here:
  CURRENT_REP_EMAIL: "mkrause@quanthub.com",

  // ── Manager mode ──────────────────────────────────────────────────
  // Set to true to show rep selector dropdown
  IS_MANAGER: false,

  // ── Activity targets (per day) ────────────────────────────────────
  // Adjust to match your team's daily KPI targets
  ACTIVITY_TARGETS: {
    calls:    12,
    emails:   10,
    meetings:  2,
    tasks:     5,
    sequences: 3,
    crmUpdates: 8,
  },

  // ── Deal risk thresholds ──────────────────────────────────────────
  RISK_DAYS_NO_CONTACT: 7,    // flag deal if no contact in N days
  HOT_LEAD_HOURS:       48,   // lead active within N hours = hot

  // ── Auto-refresh interval ─────────────────────────────────────────
  REFRESH_INTERVAL_MS: 15 * 60 * 1000, // 15 minutes

  // ── Slack webhook (optional) ──────────────────────────────────────
  // Route through your worker — never expose Slack URLs client-side
  SLACK_ENABLED: false,

  // ── Email digest (optional) ───────────────────────────────────────
  EMAIL_DIGEST_ENABLED: false,

  // ── HubSpot deal stage display names ──────────────────────────────
  // Map HubSpot internal stage IDs → human labels
  // Find your stage IDs in HubSpot: Settings → Deals → Pipeline
  STAGE_LABELS: {
    "appointmentscheduled":   "Qualified",
    "qualifiedtobuy":         "SQL",
    "presentationscheduled":  "Demo Scheduled",
    "decisionmakerboughtin":  "Proposal Sent",
    "contractsent":           "Contract Out",
    "closedwon":              "Closed Won",
    "closedlost":             "Closed Lost",
    // Add your custom stages here:
    // "your_stage_id": "Display Name",
  },

};
