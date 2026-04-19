/**
 * cloudflare-worker.js  —  QuantHub Sales Agent
 * ─────────────────────────────────────────────
 * Secrets (set via: wrangler secret put <NAME>):
 *   ANTHROPIC_API_KEY   — sk-ant-...
 *   HUBSPOT_TOKEN       — pat-na1-... (HubSpot Private App token)
 *   SLACK_WEBHOOK_URL   — https://hooks.slack.com/... (optional)
 *   ALLOWED_ORIGIN      — https://your-dashboard.com
 *
 * Routes:
 *   POST /claude                      → Anthropic API proxy
 *   GET  /hubspot/deals               → open deals by owner
 *   GET  /hubspot/contacts            → contacts by owner
 *   GET  /hubspot/leads               → lead objects by owner
 *   GET  /hubspot/activities/today    → engagement counts for today
 *   GET  /hubspot/sequences           → active sequences by owner
 *   GET  /hubspot/owners              → all HubSpot owners (manager view)
 *   POST /slack/digest                → push morning digest to Slack
 */

const CORS = (origin) => ({
  "Access-Control-Allow-Origin":  origin || "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
});

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const corsHeaders = CORS(env.ALLOWED_ORIGIN || origin || "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url  = new URL(request.url);
    const path = url.pathname;

    try {

      // ── POST /claude ─────────────────────────────────────────────
      // If this route already exists in your worker, skip or merge.
      if (path === "/claude" && request.method === "POST") {
        const body = await request.json();
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return json(data, res.status, corsHeaders);
      }

      // ── GET /hubspot/deals ───────────────────────────────────────
      if (path === "/hubspot/deals" && request.method === "GET") {
        const owner   = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);

        // Filter by owner only — frontend filters out closed stages by name.
        // Avoids hs_is_closed inconsistencies across HubSpot account configs.
        const filters = ownerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }]
          : [];

        const data = await hsPost(env, "/crm/v3/objects/deals/search", {
          filterGroups: [{ filters }],
          properties: [
            "dealname", "amount", "dealstage", "pipeline", "closedate",
            "hubspot_owner_id", "notes_last_updated", "hs_lastmodifieddate",
            "hs_deal_stage_probability", "hs_is_closed",
          ],
          sorts: [{ propertyName: "amount", direction: "DESCENDING" }],
          limit: 100,
        });
        return json(data, 200, corsHeaders);
      }

      // ── GET /hubspot/contacts ────────────────────────────────────
      if (path === "/hubspot/contacts" && request.method === "GET") {
        const owner = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);

        const filters = ownerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }]
          : [];

        const data = await hsPost(env, "/crm/v3/objects/contacts/search", {
          filterGroups: [{ filters }],
          properties: [
            "firstname", "lastname", "email", "company",
            "lifecyclestage", "hs_lead_status", "notes_last_updated",
          ],
          limit: 100,
        });
        return json(data, 200, corsHeaders);
      }

      // ── GET /hubspot/leads ───────────────────────────────────────
      // HubSpot Lead object (newer CRM feature)
      if (path === "/hubspot/leads" && request.method === "GET") {
        const owner = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);

        const filters = ownerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }]
          : [];

        // Try Lead object first; fall back to contact lifecycle if not enabled
        try {
          const data = await hsPost(env, "/crm/v3/objects/leads/search", {
            filterGroups: [{ filters }],
            properties: [
              "hs_lead_name", "hs_pipeline_stage", "hs_lead_source",
              "hs_lastmodifieddate", "createdate", "company",
            ],
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
            limit: 50,
          });
          return json(data, 200, corsHeaders);
        } catch {
          // Fallback: return MQL/SQL contacts as leads
          const fallback = await hsPost(env, "/crm/v3/objects/contacts/search", {
            filterGroups: [{
              filters: [
                ...filters,
                { propertyName: "lifecyclestage", operator: "IN", values: ["marketingqualifiedlead", "salesqualifiedlead", "lead"] },
              ]
            }],
            properties: ["firstname", "lastname", "email", "company", "lifecyclestage", "hs_lastmodifieddate", "createdate"],
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
            limit: 50,
          });
          // Normalize to lead shape
          const results = (fallback.results || []).map(c => ({
            id: c.id,
            properties: {
              hs_lead_name: [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || c.properties.email,
              hs_pipeline_stage: c.properties.lifecyclestage,
              company: c.properties.company,
              hs_lastmodifieddate: c.properties.hs_lastmodifieddate,
              createdate: c.properties.createdate,
              hs_lead_source: "",
            }
          }));
          return json({ results }, 200, corsHeaders);
        }
      }

      // ── GET /hubspot/activities/today ────────────────────────────
      if (path === "/hubspot/activities/today" && request.method === "GET") {
        const owner = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const since = startOfDay.getTime().toString();

        const [calls, emails, meetings, tasks] = await Promise.allSettled([
          countEngagements(env, ownerId, "CALL",    since),
          countEngagements(env, ownerId, "EMAIL",   since),
          countEngagements(env, ownerId, "MEETING", since),
          countTasks(env, ownerId, since),
        ]);

        return json({
          calls:      { completed: calls.value    || 0, target: 12 },
          emails:     { completed: emails.value   || 0, target: 10 },
          meetings:   { completed: meetings.value || 0, target: 2  },
          tasks:      { completed: tasks.value    || 0, target: 5  },
          sequences:  { completed: 0,                   target: 3  }, // extend via sequences API
          crmUpdates: { completed: 0,                   target: 8  }, // extend via notes/deals update API
        }, 200, corsHeaders);
      }

      // ── GET /hubspot/sequences ───────────────────────────────────
      if (path === "/hubspot/sequences" && request.method === "GET") {
        const owner = url.searchParams.get("owner") || "";
        // HubSpot Sequences API — requires sequences scope
        try {
          const data = await hsGet(env, `/automation/v4/sequences/enrollments?ownerEmail=${encodeURIComponent(owner)}&limit=50`);
          // Normalize enrollment data
          const results = (data.results || []).map(e => ({
            id:           e.id,
            contactName:  e.contactName || "Contact",
            sequenceName: e.sequenceName || "Sequence",
            nextStep:     e.nextStep || "",
            nextStepDate: e.scheduledAt || null,
            currentStep:  e.currentStepOrder || 1,
            totalSteps:   e.totalSteps || 1,
          }));
          return json({ results }, 200, corsHeaders);
        } catch {
          return json({ results: [] }, 200, corsHeaders);
        }
      }

      // ── GET /hubspot/stages ──────────────────────────────────────
      // Returns { stageId: "Stage Label", ... } for deals + leads pipelines
      if (path === "/hubspot/stages" && request.method === "GET") {
        const [dealPipelines, leadPipelines] = await Promise.allSettled([
          hsGet(env, "/crm/v3/pipelines/deals"),
          hsGet(env, "/crm/v3/pipelines/leads"),
        ]);
        const stageMap = {};
        for (const result of [dealPipelines, leadPipelines]) {
          if (result.status !== "fulfilled") continue;
          for (const pipeline of (result.value.results || [])) {
            for (const stage of (pipeline.stages || [])) {
              stageMap[stage.id] = stage.label;
            }
          }
        }
        return json(stageMap, 200, corsHeaders);
      }

      // ── GET /hubspot/owners ──────────────────────────────────────
      if (path === "/hubspot/owners" && request.method === "GET") {
        const data = await hsGet(env, "/crm/v3/owners/?limit=100");
        return json(data, 200, corsHeaders);
      }

      // ── POST /hubspot/activity ───────────────────────────────────
      // Log a completed task (priority action checked off by rep)
      if (path === "/hubspot/activity" && request.method === "POST") {
        const body  = await request.json();
        const { title, detail, ownerEmail } = body;
        const ownerId = await resolveOwnerId(env, ownerEmail);

        const taskProps = {
          hs_task_subject: title || "Priority action completed",
          hs_task_body:    detail || "",
          hs_task_status:  "COMPLETED",
          hs_task_type:    "TODO",
          hs_timestamp:    new Date().toISOString(),
        };
        if (ownerId) taskProps.hubspot_owner_id = ownerId;

        const task = await hsPost(env, "/crm/v3/objects/tasks", { properties: taskProps });
        return json({ ok: true, id: task.id }, 200, corsHeaders);
      }

      // ── POST /slack/digest ───────────────────────────────────────
      if (path === "/slack/digest" && request.method === "POST") {
        if (!env.SLACK_WEBHOOK_URL) {
          return json({ error: "SLACK_WEBHOOK_URL not configured" }, 400, corsHeaders);
        }
        const body = await request.json();
        const res = await fetch(env.SLACK_WEBHOOK_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blocks: body.blocks }),
        });
        return json({ ok: res.ok }, res.ok ? 200 : 500, corsHeaders);
      }

      return new Response("Not found", { status: 404, headers: corsHeaders });

    } catch (err) {
      console.error("[Worker]", err.message);
      return json({ error: err.message }, 500, corsHeaders);
    }
  },
};

// ── HubSpot helpers ───────────────────────────────────────────────────

async function hsPost(env, endpoint, body) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.HUBSPOT_TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`HubSpot POST ${endpoint}: ${res.status} ${t}`);
  }
  return res.json();
}

async function hsGet(env, endpoint) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    headers: { "Authorization": `Bearer ${env.HUBSPOT_TOKEN}` },
  });
  if (!res.ok) throw new Error(`HubSpot GET ${endpoint}: ${res.status}`);
  return res.json();
}

// Cache: email → HubSpot owner ID (lives for Worker lifetime)
const _ownerCache = new Map();

async function resolveOwnerId(env, email) {
  if (!email) return null;
  if (_ownerCache.has(email)) return _ownerCache.get(email);
  try {
    const data = await hsGet(env, `/crm/v3/owners/?email=${encodeURIComponent(email)}&limit=1`);
    const id = data.results?.[0]?.id || null;
    _ownerCache.set(email, id);
    return id;
  } catch { return null; }
}

async function countEngagements(env, ownerId, type, sinceMs) {
  try {
    const filters = [
      { propertyName: "hs_timestamp",      operator: "GTE", value: sinceMs },
      { propertyName: "hs_engagement_type", operator: "EQ",  value: type },
    ];
    if (ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
    const data = await hsPost(env, "/crm/v3/objects/engagements/search", {
      filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1,
    });
    return data.total || 0;
  } catch { return 0; }
}

async function countTasks(env, ownerId, sinceMs) {
  try {
    const filters = [
      { propertyName: "hs_timestamp", operator: "GTE", value: sinceMs },
      { propertyName: "hs_task_status", operator: "EQ", value: "COMPLETED" },
    ];
    if (ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
    const data = await hsPost(env, "/crm/v3/objects/tasks/search", {
      filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1,
    });
    return data.total || 0;
  } catch { return 0; }
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}
