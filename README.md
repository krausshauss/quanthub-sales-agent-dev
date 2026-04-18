# QuantHub Sales Agent
### AI-powered daily activity driver for sales reps · HubSpot + Claude + Cloudflare

---

## What this is

A SalesLoft-style daily priority engine that:
- Pulls **live data** from HubSpot (deals, contacts, leads, sequences, tasks, engagements)
- Runs a **Claude AI agent** that ranks today's top 5 actions per rep — by revenue impact + urgency
- Shows a **real-time KPI dashboard** (pipeline, activity pace, at-risk deals, hot leads)
- Delivers priorities via **web dashboard + Slack digest + (email coming)**
- Lets reps **ask the agent** mid-day: "What should I do after this call?"

---

## Project structure

```
quanthub-sales-agent/
├── index.html                          ← Open this in browser / deploy as static site
├── src/
│   ├── css/
│   │   └── main.css                    ← All styles (dark, SalesLoft aesthetic)
│   └── js/
│       ├── config.js                   ← ⭐ Edit this first — your URLs, targets, stage names
│       ├── hooks/
│       │   ├── hubspot.js              ← All HubSpot data fetching (normalized)
│       │   └── agent.js               ← Claude AI: priorities, coaching, Slack digest
│       └── components/
│           ├── priorityFeed.js         ← Ranked action list renderer
│           └── activityTracker.js      ← Activity bars + deal velocity + lead feed
├── cloudflare-worker/
│   └── index.js                        ← Merge into your existing Worker
└── README.md
```

---

## Setup (5 steps)

### Step 1 — Cloudflare Worker

Merge `cloudflare-worker/index.js` into your existing Worker.

Add these environment variables in **Cloudflare Dashboard → Worker → Settings → Variables**:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |
| `HUBSPOT_API_KEY` | `pat-na1-...` (HubSpot Private App token) |
| `ALLOWED_ORIGIN` | `https://your-dashboard-domain.com` |
| `SLACK_WEBHOOK_URL` | `https://hooks.slack.com/...` *(optional)* |

New routes your worker will handle:
```
POST /claude                    → Anthropic API proxy
GET  /hubspot/deals             → open deals by owner email
GET  /hubspot/contacts          → contacts by owner email
GET  /hubspot/leads             → lead objects (or MQL/SQL fallback)
GET  /hubspot/activities/today  → call/email/meeting/task counts for today
GET  /hubspot/sequences         → active sequence enrollments
GET  /hubspot/owners            → all owners (for manager view)
POST /slack/digest              → push Slack block kit message
```

### Step 2 — HubSpot Private App

1. HubSpot → **Settings → Integrations → Private Apps → Create**
2. Required scopes:
   - `crm.objects.deals.read`
   - `crm.objects.contacts.read`
   - `crm.objects.owners.read`
   - `crm.objects.engagements.read`
   - `crm.objects.tasks.read`
   - `crm.objects.leads.read` *(if Lead object enabled)*
   - `automation.sequences.read` *(for sequences)*
3. Copy the token → `HUBSPOT_API_KEY` in Cloudflare

### Step 3 — Edit config.js

```js
window.CONFIG = {
  WORKER_URL:          "https://YOUR-WORKER.workers.dev",
  CURRENT_REP_EMAIL:   "rep@yourcompany.com",   // or pull from auth
  IS_MANAGER:          false,
  
  ACTIVITY_TARGETS: {
    calls: 12, emails: 10, meetings: 2,
    tasks: 5, sequences: 3, crmUpdates: 8,
  },

  // Map your HubSpot stage IDs → display names
  STAGE_LABELS: {
    "appointmentscheduled":  "Qualified",
    "contractsent":          "Contract Out",
    // Add yours here...
  },
};
```

**Find your stage IDs:** HubSpot → Settings → Deals → Pipeline → hover stage → copy internal name

### Step 4 — Open in browser

```bash
# Option A: just open the file
open index.html

# Option B: local dev server (VS Code Live Server extension)
# Right-click index.html → Open with Live Server

# Option C: deploy to Cloudflare Pages (recommended for production)
# Connect your quanthub-dashboard repo → auto-deploys on push
```

### Step 5 — Auth integration

For production, replace the hardcoded `CURRENT_REP_EMAIL` in `config.js` with your auth system:

```js
// Example: read from cookie set by your SSO
CURRENT_REP_EMAIL: document.cookie.match(/rep_email=([^;]+)/)?.[1] || "fallback@co.com",

// Example: read from URL param (dev/manager use)
CURRENT_REP_EMAIL: new URLSearchParams(location.search).get("rep") || "rep@co.com",
```

---

## Manager mode

Set `IS_MANAGER: true` in config.js. The app will:
- Load all HubSpot owners into a dropdown
- Let you switch between rep views
- Each rep gets their own AI priorities and KPIs

For a team leaderboard view, this is the next build layer — ask the agent to scaffold it.

---

## Slack digest

When `SLACK_ENABLED: true` in config.js and `SLACK_WEBHOOK_URL` is set in your Worker, the agent will automatically push a morning digest after the first data load.

For **scheduled digests** (e.g. 8am every day), add a Cloudflare Cron Trigger:
```
# cloudflare-worker/index.js — add this export alongside the fetch handler:
export default {
  async fetch(request, env) { ... },     // existing
  async scheduled(event, env, ctx) {     // cron
    // For each rep, load HubSpot data + generate AI priorities + push Slack
    // Implement with your rep list from /hubspot/owners
  }
}
```

---

## Extending

| Feature | Where to add |
|---|---|
| Email digest | Add `POST /email/digest` route in worker + SendGrid/Resend API |
| Deal timeline | `GET /hubspot/deals/:id/timeline` using engagements API |
| Quota tracking | Store in Cloudflare KV → `GET /quotas/:email` |
| Custom AI scoring | Edit the `systemPrompt` in `agent.js → generateDailyPriorities()` |
| Rep leaderboard | New page `leaderboard.html` + `GET /hubspot/team` worker route |
| Mobile app | Same worker API, wrap UI in Capacitor or PWA manifest |

---

## Troubleshooting

**"HubSpot data error"** → Check `HUBSPOT_API_KEY` is set in Cloudflare env vars and has correct scopes

**"AI priorities not loading"** → Check `ANTHROPIC_API_KEY` and that your Worker `/claude` route is working. Test: `curl -X POST https://your-worker.workers.dev/claude -H "Content-Type: application/json" -d '{"model":"claude-sonnet-4-20250514","max_tokens":10,"messages":[{"role":"user","content":"hi"}]}'`

**Leads not showing** → Lead object may not be enabled on your HubSpot plan. Worker auto-falls back to MQL/SQL contacts.

**CORS errors** → Set `ALLOWED_ORIGIN` in Cloudflare env vars to match your exact domain

**Stage names showing as internal IDs** → Add your stage IDs to `STAGE_LABELS` in config.js. Find them in HubSpot → Settings → Deals → Pipeline
