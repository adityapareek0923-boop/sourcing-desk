// agent-chat — Sonar only, multi-provider (OpenAI-compatible / Anthropic / Google).
// Reads provider/api_key/model/base_url from the agents row for Sonar.
// Tools: Nexar+Mouser part search, RFQ list/get, draft_quote (queues for approval).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL        = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE        = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const NEXAR_CLIENT_ID     = Deno.env.get("NEXAR_CLIENT_ID") || "";
const NEXAR_CLIENT_SECRET = Deno.env.get("NEXAR_CLIENT_SECRET") || "";
const MOUSER_API_KEY      = Deno.env.get("MOUSER_API_KEY") || "";

const db = createClient(SUPABASE_URL, SERVICE_ROLE);

const CORS = {
  "Access-Control-Allow-Origin": "https://chipsharksupply.com",
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-token, x-trigger-secret",
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

// ---------- Admin session validation ----------
async function hmacHex(key: string, msg: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function validAdminSession(token: string): Promise<boolean> {
  if (!token || token.length < 20) return false;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const { data } = await db.from("admin_config").select("session_secret, password_hash").limit(1).single();
  if (!data?.session_secret || !data?.password_hash) return false;
  const want = await hmacHex(data.session_secret, `v1.${exp}.${data.password_hash.slice(-16)}`);
  return want === parts[2];
}
async function validTriggerSecret(secret: string): Promise<boolean> {
  if (!secret || secret.length < 20) return false;
  const { data } = await db.from("admin_config").select("trigger_secret").limit(1).single();
  if (!data?.trigger_secret) return false;
  if (secret.length !== data.trigger_secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= secret.charCodeAt(i) ^ data.trigger_secret.charCodeAt(i);
  return diff === 0;
}

// ---------- Nexar / Octopart ----------
let nexarToken: { value: string; exp: number } | null = null;
async function nexarAccessToken(): Promise<string | null> {
  if (!NEXAR_CLIENT_ID || !NEXAR_CLIENT_SECRET) return null;
  if (nexarToken && nexarToken.exp > Date.now() + 60_000) return nexarToken.value;
  const r = await fetch("https://identity.nexar.com/connect/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: NEXAR_CLIENT_ID, client_secret: NEXAR_CLIENT_SECRET, scope: "supply.domain" }),
  });
  if (!r.ok) return null;
  const j = await r.json();
  nexarToken = { value: j.access_token, exp: Date.now() + (j.expires_in * 1000) };
  return nexarToken.value;
}
async function searchNexar(mpn: string): Promise<any> {
  const token = await nexarAccessToken();
  if (!token) return { error: "nexar not configured" };
  const query = `query SearchPart($q: String!) { supSearchMpn(q: $q, limit: 5) { hits results { part { mpn manufacturer { name } shortDescription bestDatasheet { url } totalAvail medianPrice1000 { convertedPrice currency } sellers { company { name } offers { inventoryLevel moq packaging prices { quantity convertedPrice currency } } } } } } }`;
  const r = await fetch("https://api.nexar.com/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
    body: JSON.stringify({ query, variables: { q: mpn } }),
  });
  if (!r.ok) return { error: `nexar http ${r.status}` };
  const j = await r.json();
  if (j.errors) return { error: j.errors[0]?.message || "nexar error" };
  const results = j.data?.supSearchMpn?.results || [];
  return { source: "nexar", hits: j.data?.supSearchMpn?.hits || 0, parts: results.slice(0, 5).map((r: any) => ({ mpn: r.part?.mpn, manufacturer: r.part?.manufacturer?.name, description: r.part?.shortDescription, total_avail: r.part?.totalAvail, median_1k_price: r.part?.medianPrice1000?.convertedPrice, currency: r.part?.medianPrice1000?.currency, sellers: (r.part?.sellers || []).slice(0, 6).map((s: any) => ({ name: s.company?.name, offers: (s.offers || []).slice(0, 3).map((o: any) => ({ stock: o.inventoryLevel, moq: o.moq, packaging: o.packaging, best_price: o.prices?.[0] ? `${o.prices[0].convertedPrice} ${o.prices[0].currency} @ ${o.prices[0].quantity}+` : null })) })) })) };
}
async function searchMouser(mpn: string): Promise<any> {
  if (!MOUSER_API_KEY) return { error: "mouser not configured" };
  const r = await fetch(`https://api.mouser.com/api/v1/search/keyword?apiKey=${MOUSER_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ SearchByKeywordRequest: { keyword: mpn, records: 5, searchOptions: "InStock" } }),
  });
  if (!r.ok) return { error: `mouser http ${r.status}` };
  const j = await r.json();
  const parts = (j.SearchResults?.Parts || []).slice(0, 5).map((p: any) => ({ mpn: p.ManufacturerPartNumber, manufacturer: p.Manufacturer, description: p.Description, stock: p.AvailabilityInStock, lifecycle: p.LifecycleStatus, lead_time: p.LeadTime, datasheet: p.DataSheetUrl, price_breaks: (p.PriceBreaks || []).slice(0, 4).map((pb: any) => ({ qty: pb.Quantity, price: pb.Price })) }));
  return { source: "mouser", hits: j.SearchResults?.NumberOfResult || 0, parts };
}
async function searchParts(mpn: string): Promise<any> {
  const nexar = await searchNexar(mpn);
  if (!nexar.error && (nexar.hits > 0)) return nexar;
  const mouser = await searchMouser(mpn);
  if (!mouser.error) return mouser;
  return { error: "no sources available", nexar_error: nexar.error, mouser_error: mouser.error };
}

// ---------- RFQ tools ----------
async function listRfqs(status?: string, limit = 20): Promise<any> {
  const q = db.from("rfqs").select("id, name, company, email, mpn, qty, urgency, status, created_at").order("created_at", { ascending: false }).limit(limit);
  const { data, error } = status ? await q.eq("status", status) : await q;
  if (error) return { error: error.message };
  return { rfqs: data || [] };
}
async function getRfq(id: string): Promise<any> {
  const { data, error } = await db.from("rfqs").select("*").eq("id", id).maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "rfq not found" };
  return { rfq: data };
}
async function saveTask(agentId: string, convId: string, type: string, title: string, payload: any): Promise<any> {
  const { data, error } = await db.from("agent_tasks").insert({ agent_id: agentId, conversation_id: convId, type, title, payload }).select("id").single();
  if (error) return { error: error.message };
  return { task_id: data.id, status: "pending_approval", message: "Task queued for your approval in the admin tray." };
}
function draftQuoteEmail(args: any) {
  return { subject: `Quote for ${args.mpn} — ${args.qty} units`, body: `Hi ${args.buyer_name || "there"},\n\nPricing confirmed on ${args.mpn}:\n\n• Qty: ${args.qty}\n• Unit price: $${args.unit_price} (incl. ${args.markup_pct}% ChipShark margin)\n• Lead time: ${args.lead_time_days} days\n• Source tier: ${args.source_tier || "independent"}, ${args.source_country || "country TBD"}\n• Docs: ${args.docs || "manufacturer CoC + source traceability + date-code photos"}\n\n${args.notes || ""}\n\nStripe payment link will follow if you accept. Full refund within 30 days of receipt if the part fails your incoming inspection.\n\n— ChipShark` };
}

// ---------- Tool schema (used in whichever provider shape) ----------
const SONAR_TOOLS = [
  { name: "search_parts", description: "Search for a part across distributors (Nexar/Octopart first, Mouser fallback). Returns stock, price breaks, sellers.",
    parameters: { type: "object", properties: { mpn: { type: "string" }, qty: { type: "integer" } }, required: ["mpn"] } },
  { name: "list_rfqs", description: "List recent RFQs. Optionally filter by status.",
    parameters: { type: "object", properties: { status: { type: "string" } } } },
  { name: "get_rfq", description: "Get full details of a specific RFQ by ID.",
    parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
  { name: "draft_quote", description: "Draft a quote email and queue it for approval before sending.",
    parameters: { type: "object", properties: {
      rfq_id: { type: "string" }, buyer_name: { type: "string" }, mpn: { type: "string" }, qty: { type: "integer" },
      unit_price: { type: "number" }, markup_pct: { type: "number" }, lead_time_days: { type: "integer" },
      source_tier: { type: "string" }, source_country: { type: "string" }, docs: { type: "string" }, notes: { type: "string" },
    }, required: ["rfq_id", "mpn", "qty", "unit_price", "markup_pct", "lead_time_days"] } },
];

async function executeTool(agentId: string, convId: string, name: string, args: any): Promise<any> {
  try {
    switch (name) {
      case "search_parts": return await searchParts(args.mpn);
      case "list_rfqs":    return await listRfqs(args.status);
      case "get_rfq":      return await getRfq(args.id);
      case "draft_quote": { const draft = draftQuoteEmail(args); return await saveTask(agentId, convId, "send_quote_email", `Quote for ${args.mpn} × ${args.qty}`, { ...args, draft }); }
      default: return { error: `unknown tool: ${name}` };
    }
  } catch (e) { return { error: `tool execution failed: ${e instanceof Error ? e.message : String(e)}` }; }
}

// ============================================================
// Provider adapters. Each returns { text, tool_calls:[{id,name,args}] }
// and takes { system, history, step } where history is an array of
// { role: 'user'|'assistant'|'tool', content, tool_calls?, tool_name?, tool_result? }
// ============================================================

type NormalizedMsg = { role: string; content?: string | null; tool_calls?: any[]; tool_name?: string; tool_result?: any; tool_call_id?: string };
type ProviderResponse = { text: string; toolCalls: { id: string; name: string; args: any }[] };

// --- OpenAI-compatible (OpenAI, Groq, DeepSeek, OpenRouter, Together, Fireworks, Mistral, etc.)
async function callOpenAICompat(baseUrl: string, apiKey: string, model: string, system: string, history: NormalizedMsg[]): Promise<ProviderResponse> {
  const messages: any[] = [{ role: "system", content: system }];
  for (const m of history) {
    if (m.role === "user") messages.push({ role: "user", content: m.content || "" });
    else if (m.role === "assistant") {
      const row: any = { role: "assistant", content: m.content || "" };
      if (m.tool_calls?.length) {
        row.tool_calls = m.tool_calls.map((tc: any, i: number) => ({
          id: tc.id || `call_${i}_${Date.now()}`, type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
        }));
      }
      messages.push(row);
    } else if (m.role === "tool") {
      let tcId = m.tool_call_id;
      if (!tcId) for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && messages[i].tool_calls) {
          const match = messages[i].tool_calls.find((c: any) => c.function.name === m.tool_name);
          if (match) { tcId = match.id; break; }
        }
      }
      messages.push({ role: "tool", tool_call_id: tcId || "call_unknown", name: m.tool_name, content: JSON.stringify(m.tool_result).slice(0, 2500) }); // shortcut: truncates big tool results to fit free-tier TPM
    }
  }
  const tools = SONAR_TOOLS.map(t => ({ type: "function", function: t }));
  const url = baseUrl.replace(/\/$/, "") + "/chat/completions";
  const send = () => fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0.4, max_tokens: 1024 }),
  });
  let r = await send();
  if (r.status === 429) { // free tiers: wait what the provider asks (max 30s), retry once
    const body = await r.text();
    const secs = Number(r.headers.get("retry-after")) || Number(body.match(/try again in ([\d.]+)s/)?.[1]) || 15;
    await new Promise(res => setTimeout(res, Math.min(secs + 1, 30) * 1000));
    r = await send();
  }
  if (!r.ok) throw new Error(`openai-compat http ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const choice = j.choices?.[0]?.message || {};
  const toolCalls = (choice.tool_calls || []).map((tc: any) => {
    let args: any = {};
    try { args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { args = {}; }
    return { id: tc.id, name: tc.function?.name, args };
  });
  return { text: choice.content || "", toolCalls };
}

// --- Anthropic Claude (api.anthropic.com)
async function callAnthropic(apiKey: string, model: string, system: string, history: NormalizedMsg[]): Promise<ProviderResponse> {
  // Convert history to Anthropic shape. Assistant tool_calls become content blocks of type "tool_use";
  // tool results become a user message with content blocks of type "tool_result".
  const messages: any[] = [];
  for (const m of history) {
    if (m.role === "user") {
      messages.push({ role: "user", content: m.content || "" });
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      if (m.tool_calls?.length) for (const tc of m.tool_calls) {
        blocks.push({ type: "tool_use", id: tc.id || `toolu_${Date.now()}`, name: tc.name, input: tc.args || {} });
      }
      if (blocks.length) messages.push({ role: "assistant", content: blocks });
    } else if (m.role === "tool") {
      // Find the matching tool_use id from the most recent assistant turn
      let tuId = m.tool_call_id;
      if (!tuId) for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role === "assistant" && Array.isArray(messages[i].content)) {
          const match = messages[i].content.find((b: any) => b.type === "tool_use" && b.name === m.tool_name);
          if (match) { tuId = match.id; break; }
        }
      }
      messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: tuId || "toolu_unknown", content: JSON.stringify(m.tool_result) }] });
    }
  }
  const tools = SONAR_TOOLS.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, system, messages, tools, max_tokens: 2048, temperature: 0.4 }),
  });
  if (!r.ok) throw new Error(`anthropic http ${r.status}: ${await r.text()}`);
  const j = await r.json();
  let text = "";
  const toolCalls: { id: string; name: string; args: any }[] = [];
  for (const block of (j.content || [])) {
    if (block.type === "text") text += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, args: block.input || {} });
  }
  return { text, toolCalls };
}

// --- Google Gemini (generativelanguage.googleapis.com)
async function callGoogle(apiKey: string, model: string, system: string, history: NormalizedMsg[]): Promise<ProviderResponse> {
  const contents: any[] = [];
  for (const m of history) {
    if (m.role === "user") {
      contents.push({ role: "user", parts: [{ text: m.content || "" }] });
    } else if (m.role === "assistant") {
      const parts: any[] = [];
      if (m.content) parts.push({ text: m.content });
      if (m.tool_calls?.length) for (const tc of m.tool_calls) {
        parts.push({ functionCall: { name: tc.name, args: tc.args || {} } });
      }
      if (parts.length) contents.push({ role: "model", parts });
    } else if (m.role === "tool") {
      contents.push({ role: "user", parts: [{ functionResponse: { name: m.tool_name, response: m.tool_result } }] });
    }
  }
  const tools = [{ functionDeclarations: SONAR_TOOLS }];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${apiKey}`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents, tools,
      generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
    }),
  });
  if (!r.ok) throw new Error(`google http ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const parts = j.candidates?.[0]?.content?.parts || [];
  let text = "";
  const toolCalls: { id: string; name: string; args: any }[] = [];
  for (const p of parts) {
    if (p.text) text += p.text;
    if (p.functionCall) toolCalls.push({ id: `gcall_${toolCalls.length}_${Date.now()}`, name: p.functionCall.name, args: p.functionCall.args || {} });
  }
  return { text, toolCalls };
}

async function dispatchLLM(agent: any, system: string, history: NormalizedMsg[]): Promise<ProviderResponse> {
  const provider = (agent.provider || "openai_compat").toLowerCase();
  const apiKey = agent.api_key || "";
  const model  = agent.model || "";
  if (!apiKey) throw new Error("API key not set for this agent. Add it in admin → Sonar → Settings.");
  if (!model)  throw new Error("Model not set for this agent. Add it in admin → Sonar → Settings.");
  if (provider === "anthropic") return await callAnthropic(apiKey, model, system, history);
  if (provider === "google" || provider === "gemini") return await callGoogle(apiKey, model, system, history);
  // Default: OpenAI-compatible (OpenAI, Groq, DeepSeek, OpenRouter, Together, Mistral, etc.)
  const baseUrl = agent.base_url || "https://api.openai.com/v1";
  return await callOpenAICompat(baseUrl, apiKey, model, system, history);
}

// ---------- Admin UI helpers (unchanged from before) ----------
async function listConversations(agentId: string) {
  const { data, error } = await db.from("agent_conversations").select("id, agent_id, title, created_at, updated_at").eq("agent_id", agentId).order("updated_at", { ascending: false }).limit(50);
  if (error) return { error: error.message };
  return { conversations: data || [] };
}
async function listMessages(convId: string) {
  const { data, error } = await db.from("agent_messages").select("id, role, content, tool_calls, tool_name, tool_result, created_at").eq("conversation_id", convId).order("created_at", { ascending: true });
  if (error) return { error: error.message };
  return { messages: data || [] };
}
async function listTasks(status?: string, agentId?: string) {
  let q = db.from("agent_tasks").select("id, agent_id, conversation_id, type, title, payload, status, result, created_at, reviewed_at, executed_at").order("created_at", { ascending: false }).limit(50);
  if (status) q = q.eq("status", status);
  if (agentId) q = q.eq("agent_id", agentId);
  const { data, error } = await q;
  if (error) return { error: error.message };
  return { tasks: data || [] };
}
async function updateTaskStatus(taskId: string, status: "approved" | "declined" | "executed" | "failed", result?: any) {
  const patch: any = { status, reviewed_at: new Date().toISOString() };
  if (status === "executed" || status === "failed") patch.executed_at = new Date().toISOString();
  if (result !== undefined) patch.result = result;
  const { data, error } = await db.from("agent_tasks").update(patch).eq("id", taskId).select("*").single();
  if (error) return { error: error.message };
  return { task: data };
}
async function deleteConversation(convId: string) {
  const { error } = await db.from("agent_conversations").delete().eq("id", convId);
  if (error) return { error: error.message };
  return { ok: true };
}
async function deleteTask(taskId: string) {
  const { error } = await db.from("agent_tasks").delete().eq("id", taskId);
  if (error) return { error: error.message };
  return { ok: true };
}

// ---------- Email send via Resend (unchanged) ----------
const EMAIL_BLOCK_DOMAINS = /@(?:example\.(?:com|org|net)|test|localhost|invalid|internal|example|chipsharksupply\.test)$/i;
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
async function sendTaskEmail(taskId: string, overrides: { to?: string; subject?: string; body?: string } = {}) {
  const RESEND = Deno.env.get("RESEND_API_KEY") || "";
  if (!RESEND) return { error: "RESEND_API_KEY not configured" };
  const { data: task, error } = await db.from("agent_tasks").select("*").eq("id", taskId).single();
  if (error || !task) return { error: error?.message || "task not found" };
  if (task.status !== "pending") return { error: `task is ${task.status}, cannot send` };
  if (!["send_cold_email", "send_quote_email"].includes(task.type)) return { error: `task type ${task.type} is not sendable` };
  const payload = task.payload || {};
  const draft = payload.draft || {};
  const to = (overrides.to || payload.contact_email || payload.to || "").trim().toLowerCase();
  const subject = overrides.subject || draft.subject || payload.subject || "ChipShark — follow-up";
  const body = overrides.body || draft.body || payload.body || "";
  if (!EMAIL_RE.test(to)) return { error: `invalid recipient email: ${to || "<missing>"}` };
  if (EMAIL_BLOCK_DOMAINS.test(to)) return { error: `recipient looks invented (${to}). Edit the To field with a real address.` };
  if (!body || body.length < 20) return { error: "body is too short to send" };
  const bodyHtml = body.replace(/\n/g, "<br>");
  const bodyText = body + "\n\n---\nChipShark · Independent components sourcing · Jaipur, India · https://chipsharksupply.com";
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${RESEND}` },
    body: JSON.stringify({ from: "ChipShark <hello@chipsharksupply.com>", to: [to], subject, text: bodyText, html: bodyHtml }),
  });
  const resendResp = await r.json().catch(() => ({}));
  if (!r.ok) { await updateTaskStatus(taskId, "failed", { error: `resend ${r.status}`, resend: resendResp }); return { error: `resend http ${r.status}: ${JSON.stringify(resendResp)}` }; }
  await updateTaskStatus(taskId, "executed", { sent_to: to, resend_id: resendResp.id, sent_at: new Date().toISOString() });
  return { ok: true, sent_to: to, resend_id: resendResp.id };
}

// ---------- Main handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  const sess = req.headers.get("x-admin-token") || "";
  const triggerSec = req.headers.get("x-trigger-secret") || "";
  const isAdmin = sess ? await validAdminSession(sess) : false;
  const isTrigger = triggerSec ? await validTriggerSecret(triggerSec) : false;
  if (!isAdmin && !isTrigger) return json({ error: "unauthorized" }, 401);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
  const action: string = body.action || "send";

  if (action === "list_conversations") { if (!body.agent_id) return json({ error: "agent_id required" }, 400); return json(await listConversations(body.agent_id)); }
  if (action === "list_messages")      { if (!body.conversation_id) return json({ error: "conversation_id required" }, 400); return json(await listMessages(body.conversation_id)); }
  if (action === "list_tasks")         return json(await listTasks(body.status, body.agent_id));
  if (action === "approve_task")       { if (!body.task_id) return json({ error: "task_id required" }, 400); return json(await updateTaskStatus(body.task_id, "approved")); }
  if (action === "decline_task")       { if (!body.task_id) return json({ error: "task_id required" }, 400); return json(await updateTaskStatus(body.task_id, "declined")); }
  if (action === "mark_executed")      { if (!body.task_id) return json({ error: "task_id required" }, 400); return json(await updateTaskStatus(body.task_id, "executed", body.result)); }
  if (action === "send_task")          { if (!body.task_id) return json({ error: "task_id required" }, 400); return json(await sendTaskEmail(body.task_id, { to: body.to, subject: body.subject, body: body.body })); }
  if (action === "delete_conversation"){ if (!body.conversation_id) return json({ error: "conversation_id required" }, 400); return json(await deleteConversation(body.conversation_id)); }
  if (action === "delete_task")        { if (!body.task_id) return json({ error: "task_id required" }, 400); return json(await deleteTask(body.task_id)); }

  // Default: send a chat message
  const agentId: string = body.agent_id;
  const message: string = body.message;
  let convId: string | null = body.conversation_id || null;
  if (!agentId || !message) return json({ error: "agent_id and message required" }, 400);

  const { data: agent, error: agentErr } = await db.from("agents").select("*").eq("id", agentId).eq("enabled", true).maybeSingle();
  if (agentErr || !agent) return json({ error: "agent not found" }, 404);

  if (!convId) {
    const { data: conv, error: convErr } = await db.from("agent_conversations").insert({ agent_id: agentId, title: message.slice(0, 80) }).select("id").single();
    if (convErr) return json({ error: convErr.message }, 500);
    convId = conv.id;
  }
  await db.from("agent_messages").insert({ conversation_id: convId, role: "user", content: message });
  const { data: history } = await db.from("agent_messages").select("role, content, tool_calls, tool_name, tool_result").eq("conversation_id", convId).order("created_at", { ascending: true });

  // drop saved "[error] ..." rows so old failures aren't resent to the model
  const historyMsgs: NormalizedMsg[] = ((history || []) as NormalizedMsg[]).filter(m => !(m.role === "assistant" && m.content?.startsWith("[error]")));
  const newMessages: any[] = [];

  for (let step = 0; step < 6; step++) {
    let resp: ProviderResponse;
    try { resp = await dispatchLLM(agent, agent.system_prompt || "", historyMsgs); }
    catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      await db.from("agent_messages").insert({ conversation_id: convId, role: "assistant", content: `[error] ${errMsg}` });
      return json({ error: errMsg, conversation_id: convId }, 500);
    }

    const toolCalls = resp.toolCalls.map(tc => ({ id: tc.id, name: tc.name, args: tc.args }));

    const assistantRow = { conversation_id: convId, role: "assistant", content: resp.text || null, tool_calls: toolCalls.length ? toolCalls : null };
    const { data: savedAsst } = await db.from("agent_messages").insert(assistantRow).select("id, created_at").single();
    newMessages.push({ ...assistantRow, id: savedAsst?.id, created_at: savedAsst?.created_at });

    historyMsgs.push({ role: "assistant", content: resp.text, tool_calls: toolCalls });

    if (toolCalls.length === 0) break;

    for (const tc of toolCalls) {
      const result = await executeTool(agentId, convId, tc.name, tc.args);
      const toolRow = { conversation_id: convId, role: "tool", tool_name: tc.name, tool_result: result };
      const { data: savedTool } = await db.from("agent_messages").insert(toolRow).select("id, created_at").single();
      newMessages.push({ ...toolRow, id: savedTool?.id, created_at: savedTool?.created_at });
      historyMsgs.push({ role: "tool", tool_name: tc.name, tool_result: result, tool_call_id: tc.id });
    }
  }

  return json({ conversation_id: convId, messages: newMessages });
});
