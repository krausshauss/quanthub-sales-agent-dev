/**
 * cloudflare-worker.js  —  QuantHub Sales Agent
 * ─────────────────────────────────────────────
 * Secrets (set via: wrangler secret put <NAME>):
 *   HUBSPOT_TOKEN       — pat-na1-... (HubSpot Private App token)
 *   ANTHROPIC_API_KEY   — sk-ant-...
 *   PORTAL_PASSWORD     — password used to log into the portal
 *   SESSION_SECRET      — long random string for HMAC-signing session cookies
 *   SLACK_WEBHOOK_URL   — https://hooks.slack.com/... (optional, for /slack/digest)
 *
 * Routes (all require a valid session cookie except /login, /auth, /logout):
 *   GET  /login                       → login page (always public)
 *   POST /auth                        → submit password, set cookie, redirect to /
 *   GET  /logout                      → clear cookie, redirect to /login
 *   GET  /                            → app HTML (served from public/index.html)
 *   GET  /src/*                       → app static assets
 *   GET  /health                      → sanity check
 *   POST /claude                      → Anthropic API proxy
 *   GET  /hubspot/deals               → open deals by owner
 *   GET  /hubspot/contacts            → contacts by owner
 *   GET  /hubspot/leads               → lead objects by owner
 *   GET  /hubspot/activities/today    → engagement counts for today
 *   GET  /hubspot/sequences           → active sequences by owner
 *   GET  /hubspot/stages              → stage ID → label map
 *   GET  /hubspot/owners              → all HubSpot owners
 *   GET  /hubspot/portal              → HubSpot portal ID
 *   GET  /hubspot/engagements         → last-30-day meetings, calls, emails
 *   POST /hubspot/activity            → log a completed task
 *   POST /slack/digest                → push morning digest to Slack
 */

// Gated entry page, bundled into the worker at build time (wrangler's default
// module rules import *.html as text). Served only after auth.
import INDEX_HTML from "./index.html";

const SESSION_COOKIE     = "qh_session";
const SESSION_DURATION_S = 30 * 24 * 60 * 60;       // 30 days
const MAX_FAILS          = 5;
const FAIL_WINDOW_MS     = 15 * 60 * 1000;          // 15 minutes

const failedAttempts = new Map();

export default {
  async fetch(request, env) {
    const url    = new URL(request.url);
    const path   = url.pathname;
    const method = request.method;

    try {
      // ── Always-public auth routes ─────────────────────────────────
      if (path === "/login" && method === "GET")  return loginPage();
      if (path === "/auth"  && method === "POST") return handleAuth(request, env);
      if (path === "/logout")                     return logout();

      // ── Everything else requires a valid session ──────────────────
      if (!(await isAuthed(request, env))) {
        const wantsHtml = (request.headers.get("Accept") || "").includes("text/html");
        if (method === "GET" && wantsHtml) {
          return Response.redirect(new URL("/login", url), 302);
        }
        return json({ error: "Unauthorized" }, 401);
      }

      // ── Authed: entry page (bundled, gated) ───────────────────────
      // /src/* static files are served directly by [assets] and never reach
      // the worker — they hold no secrets.
      if (method === "GET" && (path === "/" || path === "")) {
        return html(INDEX_HTML);
      }

      // ── Authed: health ────────────────────────────────────────────
      if (path === "/health") {
        return json({ ok: true, worker: "quanthub-sales-agent", ts: Date.now() });
      }

      // ── POST /claude ──────────────────────────────────────────────
      if (path === "/claude" && method === "POST") {
        const body = await request.json();
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type":      "application/json",
            "x-api-key":         env.ANTHROPIC_API_KEY,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        const data = await res.json();
        return json(data, res.status);
      }

      // ── GET /hubspot/deals ────────────────────────────────────────
      if (path === "/hubspot/deals" && method === "GET") {
        const owner   = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);
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
        return json(data);
      }

      // ── GET /hubspot/contacts ─────────────────────────────────────
      if (path === "/hubspot/contacts" && method === "GET") {
        const owner   = url.searchParams.get("owner") || "";
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
        return json(data);
      }

      // ── GET /hubspot/leads ────────────────────────────────────────
      if (path === "/hubspot/leads" && method === "GET") {
        const owner   = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);
        const filters = ownerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }]
          : [];
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
          return json(data);
        } catch {
          // Fallback: return MQL/SQL contacts as leads
          const fallback = await hsPost(env, "/crm/v3/objects/contacts/search", {
            filterGroups: [{
              filters: [
                ...filters,
                { propertyName: "lifecyclestage", operator: "IN",
                  values: ["marketingqualifiedlead", "salesqualifiedlead", "lead"] },
              ]
            }],
            properties: ["firstname", "lastname", "email", "company", "lifecyclestage", "hs_lastmodifieddate", "createdate"],
            sorts: [{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }],
            limit: 50,
          });
          const results = (fallback.results || []).map(c => ({
            id: c.id,
            properties: {
              hs_lead_name:        [c.properties.firstname, c.properties.lastname].filter(Boolean).join(" ") || c.properties.email,
              hs_pipeline_stage:   c.properties.lifecyclestage,
              company:             c.properties.company,
              hs_lastmodifieddate: c.properties.hs_lastmodifieddate,
              createdate:          c.properties.createdate,
              hs_lead_source:      "",
            }
          }));
          return json({ results });
        }
      }

      // ── GET /hubspot/activities/today ─────────────────────────────
      if (path === "/hubspot/activities/today" && method === "GET") {
        const owner      = url.searchParams.get("owner") || "";
        const ownerId    = await resolveOwnerId(env, owner);
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        const since      = startOfDay.getTime().toString();

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
          sequences:  { completed: 0,                   target: 3  },
          crmUpdates: { completed: 0,                   target: 8  },
        });
      }

      // ── GET /hubspot/sequences ────────────────────────────────────
      if (path === "/hubspot/sequences" && method === "GET") {
        const owner = url.searchParams.get("owner") || "";
        try {
          const data = await hsGet(env, `/automation/v4/sequences/enrollments?ownerEmail=${encodeURIComponent(owner)}&limit=50`);
          const results = (data.results || []).map(e => ({
            id:           e.id,
            contactName:  e.contactName || "Contact",
            sequenceName: e.sequenceName || "Sequence",
            nextStep:     e.nextStep || "",
            nextStepDate: e.scheduledAt || null,
            currentStep:  e.currentStepOrder || 1,
            totalSteps:   e.totalSteps || 1,
          }));
          return json({ results });
        } catch {
          return json({ results: [] });
        }
      }

      // ── GET /hubspot/stages ───────────────────────────────────────
      if (path === "/hubspot/stages" && method === "GET") {
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
        return json(stageMap);
      }

      // ── GET /hubspot/owners ───────────────────────────────────────
      if (path === "/hubspot/owners" && method === "GET") {
        const data = await hsGet(env, "/crm/v3/owners/?limit=100");
        return json(data);
      }

      // ── GET /hubspot/portal ───────────────────────────────────────
      if (path === "/hubspot/portal" && method === "GET") {
        const data = await hsGet(env, "/account-info/v3/details");
        return json({ portalId: data.portalId });
      }

      // ── GET /hubspot/engagements ──────────────────────────────────
      if (path === "/hubspot/engagements" && method === "GET") {
        const owner   = url.searchParams.get("owner") || "";
        const ownerId = await resolveOwnerId(env, owner);
        const since   = new Date(Date.now() - 30 * 86400000).getTime().toString();

        const ownerFilter = ownerId
          ? [{ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId }]
          : [];

        const meetingProps = [
          "hs_meeting_title", "hs_timestamp", "hs_meeting_outcome",
          "hs_internal_meeting_notes", "hs_meeting_body", "hs_note_body",
          "hubspot_owner_id",
        ];

        const [meetingsOwnerRes, meetingsDealRes, callsRes, emailsRes] = await Promise.allSettled([

          // Pass 1: meetings owned by the rep directly
          hsPost(env, "/crm/v3/objects/meetings/search", {
            properties: meetingProps,
            filterGroups: [{ filters: [
              { propertyName: "hs_timestamp", operator: "GTE", value: since },
              ...ownerFilter,
            ]}],
            sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
            limit: 15,
          }),

          // Pass 2: meetings on the rep's open deals (Fathom path)
          (async () => {
            if (!ownerId) return { results: [] };
            const dealData = await hsPost(env, "/crm/v3/objects/deals/search", {
              properties: ["dealname"],
              filterGroups: [{ filters: [
                { propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId },
                { propertyName: "hs_is_closed",     operator: "EQ", value: "false" },
              ]}],
              limit: 50,
            });
            const dealIds = (dealData.results || []).map(d => d.id);
            if (!dealIds.length) return { results: [] };

            const assocData = await hsPost(
              env,
              "/crm/v4/associations/deals/meetings/batch/read",
              { inputs: dealIds.slice(0, 50).map(id => ({ id })) }
            );
            const meetingIds = [...new Set(
              (assocData.results || []).flatMap(r => (r.to || []).map(t => String(t.toObjectId)))
            )];
            if (!meetingIds.length) return { results: [] };

            const batchData = await hsPost(env, "/crm/v3/objects/meetings/batch/read", {
              properties: meetingProps,
              inputs: meetingIds.slice(0, 20).map(id => ({ id })),
            });
            return {
              results: (batchData.results || []).filter(m => {
                const ts = m.properties.hs_timestamp;
                return ts && new Date(ts).getTime() >= parseInt(since);
              }),
            };
          })(),

          hsPost(env, "/crm/v3/objects/calls/search", {
            properties: [
              "hs_call_title", "hs_timestamp", "hs_call_outcome",
              "hs_call_body", "hs_call_duration", "hubspot_owner_id",
            ],
            filterGroups: [{ filters: [
              { propertyName: "hs_timestamp", operator: "GTE", value: since },
              ...ownerFilter,
            ]}],
            sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
            limit: 10,
          }),

          hsPost(env, "/crm/v3/objects/emails/search", {
            properties: [
              "hs_email_subject", "hs_timestamp", "hs_email_direction",
              "hs_email_text", "hubspot_owner_id",
            ],
            filterGroups: [{ filters: [
              { propertyName: "hs_timestamp", operator: "GTE", value: since },
              ...ownerFilter,
            ]}],
            sorts: [{ propertyName: "hs_timestamp", direction: "DESCENDING" }],
            limit: 10,
          }),
        ]);

        const seenMeetingIds = new Set();
        const allMeetingResults = [
          ...(meetingsOwnerRes.value?.results || []),
          ...(meetingsDealRes.value?.results  || []),
        ].filter(m => {
          if (seenMeetingIds.has(m.id)) return false;
          seenMeetingIds.add(m.id);
          return true;
        });

        const meetings = allMeetingResults.map(r => ({
          type:      "meeting",
          id:        r.id,
          title:     r.properties.hs_meeting_title || "Meeting",
          timestamp: r.properties.hs_timestamp,
          outcome:   r.properties.hs_meeting_outcome || "",
          notes:     r.properties.hs_internal_meeting_notes
                     || r.properties.hs_meeting_body
                     || r.properties.hs_note_body || "",
        }));

        const calls = (callsRes.value?.results || []).map(r => ({
          type:      "call",
          id:        r.id,
          title:     r.properties.hs_call_title || "Call",
          timestamp: r.properties.hs_timestamp,
          outcome:   r.properties.hs_call_outcome || "",
          notes:     r.properties.hs_call_body || "",
          duration:  r.properties.hs_call_duration || null,
        }));

        const emails = (emailsRes.value?.results || []).map(r => ({
          type:      "email",
          id:        r.id,
          title:     r.properties.hs_email_subject || "Email",
          timestamp: r.properties.hs_timestamp,
          direction: r.properties.hs_email_direction || "",
          notes:     r.properties.hs_email_text || "",
        }));

        const all = [...meetings, ...calls, ...emails]
          .filter(e => e.notes && e.notes.trim().length > 10)
          .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
          .slice(0, 15);

        return json({ results: all });
      }

      // ── POST /hubspot/activity ────────────────────────────────────
      if (path === "/hubspot/activity" && method === "POST") {
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
        return json({ ok: true, id: task.id });
      }

      // ── POST /slack/digest ────────────────────────────────────────
      if (path === "/slack/digest" && method === "POST") {
        if (!env.SLACK_WEBHOOK_URL) {
          return json({ error: "SLACK_WEBHOOK_URL not configured" }, 400);
        }
        const body = await request.json();
        const res = await fetch(env.SLACK_WEBHOOK_URL, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ blocks: body.blocks }),
        });
        return json({ ok: res.ok }, res.ok ? 200 : 500);
      }

      return json({ error: "Not found" }, 404);

    } catch (err) {
      console.error("[Worker]", err.message);
      return json({ error: err.message }, 500);
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
//   Auth
// ═══════════════════════════════════════════════════════════════════════════

async function isAuthed(request, env) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token || !env.SESSION_SECRET) return false;
  return verifySession(token, env.SESSION_SECRET);
}

async function handleAuth(request, env) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  if (!checkRateLimit(ip)) {
    return loginPage("Too many failed attempts. Wait 15 minutes and try again.", 429);
  }
  if (!env.PORTAL_PASSWORD || !env.SESSION_SECRET) {
    return loginPage("Server misconfigured: missing secret(s).", 500);
  }

  const form     = await request.formData();
  const password = (form.get("password") || "").toString();

  if (!timingSafeEqualStr(password, env.PORTAL_PASSWORD)) {
    recordFailure(ip);
    return loginPage("Incorrect password.", 401);
  }

  clearFailures(ip);
  const token = await makeSession(env.SESSION_SECRET);
  return new Response(null, {
    status: 302,
    headers: {
      "Location":   "/",
      "Set-Cookie": cookieHeader(token, SESSION_DURATION_S),
    },
  });
}

function logout() {
  return new Response(null, {
    status: 302,
    headers: {
      "Location":   "/login",
      "Set-Cookie": cookieHeader("", 0),
    },
  });
}

function cookieHeader(value, maxAgeS) {
  return `${SESSION_COOKIE}=${encodeURIComponent(value)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeS}`;
}

function readCookie(request, name) {
  const raw = request.headers.get("Cookie") || "";
  const m   = raw.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[1]) : null;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64uEncode(buf) {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64uDecode(s) {
  const pad  = "=".repeat((4 - (s.length % 4)) % 4);
  const norm = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin  = atob(norm);
  const out  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacSign(secret, data) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return b64uEncode(sig);
}

async function makeSession(secret) {
  const now     = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ iat: now, exp: now + SESSION_DURATION_S });
  const pb64    = b64uEncode(enc.encode(payload));
  const sig     = await hmacSign(secret, pb64);
  return `${pb64}.${sig}`;
}

async function verifySession(token, secret) {
  if (!token || !token.includes(".")) return false;
  const [pb64, sig] = token.split(".");
  if (!pb64 || !sig) return false;
  const expectedSig = await hmacSign(secret, pb64);
  if (!timingSafeEqualStr(sig, expectedSig)) return false;
  try {
    const payload = JSON.parse(dec.decode(b64uDecode(pb64)));
    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return res === 0;
}

function checkRateLimit(ip) {
  const now   = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry) return true;
  if (now - entry.firstAt > FAIL_WINDOW_MS) {
    failedAttempts.delete(ip);
    return true;
  }
  return entry.count < MAX_FAILS;
}

function recordFailure(ip) {
  const now   = Date.now();
  const entry = failedAttempts.get(ip);
  if (!entry || now - entry.firstAt > FAIL_WINDOW_MS) {
    failedAttempts.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

function clearFailures(ip) {
  failedAttempts.delete(ip);
}

function loginPage(errMsg = "", status = 200) {
  const safe = errMsg.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));
  const body = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QuantHub · Sign in</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&display=swap" rel="stylesheet" />
  <style>
    *,*::before,*::after { box-sizing: border-box; }
    html, body { height: 100%; margin: 0; }
    body { font-family: 'Manrope', -apple-system, sans-serif; background: #0a0e1a; color: #e6edf3; display: flex; align-items: center; justify-content: center; padding: 1rem; }
    .card { background: #161b22; padding: 2.5rem 2rem; border-radius: 14px; width: 100%; max-width: 360px; box-shadow: 0 12px 40px rgba(0,0,0,0.6); border: 1px solid #30363d; }
    .brand { color: #0077B5; font-weight: 800; letter-spacing: 0.05em; font-size: 0.85rem; text-transform: uppercase; }
    h1 { margin: 0.25rem 0 1.5rem; font-size: 1.4rem; font-weight: 700; }
    label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 0.4rem; }
    input { width: 100%; padding: 0.75rem 0.9rem; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #e6edf3; font-family: inherit; font-size: 0.95rem; }
    input:focus { outline: none; border-color: #0077B5; box-shadow: 0 0 0 3px rgba(0, 119, 181, 0.2); }
    button { width: 100%; margin-top: 1.1rem; padding: 0.8rem; background: #0077B5; color: white; border: none; border-radius: 8px; font-family: inherit; font-size: 0.95rem; font-weight: 700; cursor: pointer; transition: background 0.15s; }
    button:hover { background: #005c8a; }
    .err { color: #f85149; font-size: 0.85rem; margin-top: 0.9rem; min-height: 1.2em; text-align: center; }
  </style>
</head>
<body>
  <main class="card">
    <div class="brand">QuantHub</div>
    <h1>Sign in</h1>
    <form method="POST" action="/auth">
      <label for="pw">Password</label>
      <input id="pw" type="password" name="password" autocomplete="current-password" autofocus required />
      <button type="submit">Continue</button>
      <div class="err">${safe}</div>
    </form>
  </main>
</body>
</html>`;
  return html(body, status);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      "Content-Type":           "text/html; charset=utf-8",
      "Cache-Control":          "no-store",
      "X-Frame-Options":        "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy":        "no-referrer",
    },
  });
}

// ═══════════════════════════════════════════════════════════════════════════
//   HubSpot helpers
// ═══════════════════════════════════════════════════════════════════════════

async function hsPost(env, endpoint, body) {
  const res = await fetch(`https://api.hubapi.com${endpoint}`, {
    method:  "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.HUBSPOT_TOKEN}` },
    body:    JSON.stringify(body),
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

// Cache: email → HubSpot owner ID (lives for Worker isolate lifetime)
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
      { propertyName: "hs_timestamp",       operator: "GTE", value: sinceMs },
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
      { propertyName: "hs_timestamp",   operator: "GTE", value: sinceMs },
      { propertyName: "hs_task_status", operator: "EQ",  value: "COMPLETED" },
    ];
    if (ownerId) filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: ownerId });
    const data = await hsPost(env, "/crm/v3/objects/tasks/search", {
      filterGroups: [{ filters }], properties: ["hs_timestamp"], limit: 1,
    });
    return data.total || 0;
  } catch { return 0; }
}
