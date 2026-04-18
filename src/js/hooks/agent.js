/**
 * agent.js
 * ─────────────────────────────────────────────
 * Claude AI agent: generates daily priorities, scores,
 * coaching insights, and answers ad-hoc rep questions.
 * Calls Claude via your Cloudflare Worker proxy at POST /claude.
 */

window.Agent = (() => {

  // ── Core Claude call via Worker proxy ─────────────────────────────
  async function callClaude(systemPrompt, userMessage, maxTokens = 1000) {
    const res = await fetch(`${window.CONFIG.WORKER_URL}/claude`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) throw new Error(`Agent call failed: ${res.status}`);
    const data = await res.json();
    return data.content?.[0]?.text || "";
  }

  function parseJSON(text) {
    try {
      return JSON.parse(text.replace(/```json|```/g, "").trim());
    } catch {
      return null;
    }
  }

  // ── Daily Priority Generation ──────────────────────────────────────
  // Returns: { score, scoreDelta, insight, priorities[] }
  async function generateDailyPriorities(repName, data) {
    const { deals, leads, activities, sequences } = data;

    const atRisk = deals.filter(d => d.isAtRisk);
    const hotLeads = leads.filter(l => l.isHot);
    const topDeals = [...deals].sort((a, b) => b.amount - a.amount).slice(0, 15);

    const systemPrompt = `You are an elite sales performance AI agent for a B2B sales team.
Your job: analyze CRM data and generate a laser-focused daily action plan for one sales rep.
Be direct, specific, and data-driven. Always reference actual deal names and dollar amounts.
Return ONLY valid JSON — no markdown, no preamble, no explanation outside the JSON.

Return exactly this shape:
{
  "score": <integer 0-100, rep's AI priority score for today>,
  "scoreDelta": <string like "+7" or "-3" or "→0">,
  "insight": <string, 2-3 sentences of direct coaching to the rep, second person "you">,
  "priorities": [
    {
      "rank": <1-5>,
      "title": <string, specific action max 65 chars>,
      "detail": <string, context with deal name/amount/days, max 95 chars>,
      "tag": <one of: "Hot" | "Follow-up" | "At risk" | "New opp" | "Admin" | "Lead" | "Sequence">,
      "dealValue": <number or null>,
      "contactName": <string or null>,
      "urgencyReason": <string, 1 sentence why this is ranked here>
    }
  ]
}

Scoring rules (0-100):
- Start at 70
- +15 if pipeline coverage > 3x quota
- +10 if activity pace >= 70% of daily targets
- -10 per deal at risk (no contact 7+ days)
- -5 if CRM updates < 50% of target
- +5 per hot lead with activity in 24hrs
- +5 if no deals closing this month without a scheduled call

Priority ranking rules (rank 1 = most urgent):
1. Proposals expiring or close dates within 7 days
2. Deals with decision maker engagement (email opens, website visits)
3. At-risk deals (7+ days no contact) sorted by value
4. Hot leads with recent activity signals
5. Sequence follow-ups due today
6. CRM hygiene if score < 60%`;

    const userMessage = `Sales rep: ${repName}
Today: ${new Date().toDateString()}
Day of week: ${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][new Date().getDay()]}

TOP DEALS (open, by value):
${JSON.stringify(topDeals.map(d => ({
  name: d.name, amount: d.amountFmt, stage: d.stageLabel,
  daysSinceContact: d.daysSinceContact, daysToClose: d.daysToClose,
  isAtRisk: d.isAtRisk, probability: d.probability
})), null, 2)}

AT-RISK DEALS (${atRisk.length}):
${JSON.stringify(atRisk.map(d => ({ name: d.name, amount: d.amountFmt, daysSinceContact: d.daysSinceContact })), null, 2)}

HOT LEADS (${hotLeads.length} active in 48hrs):
${JSON.stringify(hotLeads.slice(0, 8).map(l => ({ name: l.name, company: l.company, hoursAgo: l.hoursAgo, source: l.source })), null, 2)}

ACTIVE SEQUENCES (${sequences.length}):
${JSON.stringify(sequences.slice(0, 6).map(s => ({ contact: s.contactName, sequence: s.sequenceName, nextStep: s.nextStep, nextStepDate: s.nextStepDate })), null, 2)}

TODAY'S ACTIVITY PROGRESS:
${JSON.stringify(activities, null, 2)}

Generate today's priority action plan.`;

    const raw = await callClaude(systemPrompt, userMessage, 1200);
    return parseJSON(raw);
  }

  // ── Ad-hoc agent question ──────────────────────────────────────────
  // "What should I do after this call?" etc.
  async function askQuestion(question, repName, data) {
    const { deals, leads, activities } = data;
    const topDeals = [...deals].sort((a, b) => b.amount - a.amount).slice(0, 10);

    const systemPrompt = `You are a real-time sales coach AI for ${repName}.
Answer concisely in 2-4 sentences. Be direct and actionable. Reference specific deals by name when relevant.
No bullet points. No markdown. Plain conversational coaching.`;

    const userMessage = `Question: ${question}

Context — current pipeline:
${JSON.stringify(topDeals.map(d => ({ name: d.name, amount: d.amountFmt, stage: d.stageLabel, daysSinceContact: d.daysSinceContact })), null, 2)}

Activity today:
Calls ${activities.calls?.completed || 0}/${activities.calls?.target || 12} · Emails ${activities.emails?.completed || 0}/${activities.emails?.target || 10} · Meetings ${activities.meetings?.completed || 0}/${activities.meetings?.target || 2}

Hot leads: ${leads.filter(l => l.isHot).length}`;

    return callClaude(systemPrompt, userMessage, 400);
  }

  // ── Slack digest ───────────────────────────────────────────────────
  // Generates a Slack block kit message for morning standup push
  async function generateSlackDigest(repName, priorities, score, insight) {
    if (!priorities?.length) return null;

    const blocks = [
      {
        type: "header",
        text: { type: "plain_text", text: `☀️ ${repName}'s Priority Actions — ${new Date().toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" })}` }
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: `*AI Score: ${score}/100* · ${insight}` }
      },
      { type: "divider" },
      ...priorities.slice(0, 5).map((p, i) => ({
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*${i + 1}. ${p.title}*\n${p.detail}${p.dealValue ? ` · _${window.HubSpot?.fmtMoney ? window.HubSpot.fmtMoney(p.dealValue) : '$' + p.dealValue}_` : ""}`
        }
      })),
      { type: "divider" },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `_QuantHub Sales Agent · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}_` }]
      }
    ];

    return { blocks };
  }

  return { generateDailyPriorities, askQuestion, generateSlackDigest };

})();
