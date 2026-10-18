// ChipShark admin API v4 — session tokens, login lockout, setup token, locked-down CORS, input validation.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const STRIPE_SECRET = Deno.env.get("STRIPE_SECRET_KEY") || "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") || "";
const REPLY_TO = "hello@chipsharksupply.com"; // buyer-facing reply-to: brand address, not a personal inbox
const FROM_ADDRESS = "ChipShark <hello@send.chipsharksupply.com>";
const ALLOWED_ORIGIN = "https://chipsharksupply.com";
const SESSION_TTL_SEC = 12 * 60 * 60;
const CONFIG_ID = "00000000-0000-0000-0000-000000000001";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STRIPE_LINK_RE = /^https:\/\/(buy|checkout)\.stripe\.com\//;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

const CORS = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Vary": "Origin",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-admin-token",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status, headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// ---------- crypto helpers ----------
const enc = new TextEncoder();
async function hmacHex(key: string, msg: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

// ---------- config + auth ----------
async function getCfg() {
  const { data } = await admin.from("admin_config").select("password_hash, session_secret, setup_token").limit(1).single();
  return data as { password_hash: string | null; session_secret: string; setup_token: string | null } | null;
}

async function verifyPassword(pwd: string): Promise<boolean> {
  if (!pwd || typeof pwd !== "string" || pwd.length > 200) return false;
  const { data, error } = await admin.rpc("admin_password_check", { pwd });
  if (error) { console.error("admin_password_check error:", error); return false; }
  return data === true;
}

// Token = v1.<expiry>.<hmac(session_secret, "v1.<expiry>.<tail of password hash>")>
// Resetting the password (hash changes / NULL) invalidates every outstanding token.
async function issueToken(cfg: NonNullable<Awaited<ReturnType<typeof getCfg>>>): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SEC;
  const sig = await hmacHex(cfg.session_secret, `v1.${exp}.${(cfg.password_hash || "").slice(-16)}`);
  return `v1.${exp}.${sig}`;
}

async function verifyToken(tok: string): Promise<boolean> {
  const parts = tok.split(".");
  if (parts.length !== 3 || parts[0] !== "v1") return false;
  const exp = Number(parts[1]);
  if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
  const cfg = await getCfg();
  if (!cfg?.password_hash) return false;
  const want = await hmacHex(cfg.session_secret, `v1.${exp}.${cfg.password_hash.slice(-16)}`);
  return safeEq(parts[2], want);
}

// ---------- login lockout ----------
// ponytail: 5 failures/15min per IP, 30/15min global. A global cap means an attacker can lock new logins
// for 15 minutes (existing 12h tokens keep working). Fine for a one-admin tool.
function clientIp(req: Request): string {
  return (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
}
async function lockedOut(ip: string): Promise<boolean> {
  const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  const [a, b] = await Promise.all([
    admin.from("admin_auth_failures").select("id", { count: "exact", head: true }).eq("ip", ip).gte("at", since),
    admin.from("admin_auth_failures").select("id", { count: "exact", head: true }).gte("at", since),
  ]);
  return (a.count || 0) >= 5 || (b.count || 0) >= 30;
}
async function recordFailure(ip: string) {
  await admin.from("admin_auth_failures").insert({ ip });
  if (Math.random() < 0.05) {
    await admin.from("admin_auth_failures").delete().lt("at", new Date(Date.now() - 24 * 3600 * 1000).toISOString());
  }
}

// ---------- email + stripe helpers ----------
function esc(s: unknown) {
  if (s == null) return "";
  return String(s).replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function oneLine(s: unknown, max = 150) {
  const flat = String(s || "").replace(/[\r\n\t]+/g, " · ").replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function stripeForm(obj: Record<string, unknown>) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
}

async function stripeCall(path: string, body: Record<string, unknown>) {
  const res = await fetch(`https://api.stripe.com${path}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${STRIPE_SECRET}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: stripeForm(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Stripe ${path} ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
  return data;
}

async function createStripePaymentLink(opts: { rfqId: string; shortId: string; amountCents: number; currency: string; mpn: string; qty: string; buyerEmail: string }) {
  if (!STRIPE_SECRET) throw new Error("STRIPE_SECRET_KEY not configured in Supabase secrets.");
  if (opts.amountCents < 50) throw new Error("Quote too small (Stripe minimum is $0.50).");
  const firstMpn = (opts.mpn || "").split(/\s+/)[0] || "components";
  const product = await stripeCall("/v1/products", {
    name: `ChipShark RFQ ${opts.shortId}`,
    description: `${opts.qty} × ${firstMpn.slice(0, 80)}`,
    "metadata[rfq_id]": opts.rfqId,
    "metadata[short_id]": opts.shortId,
  });
  const price = await stripeCall("/v1/prices", {
    product: product.id,
    unit_amount: opts.amountCents,
    currency: (opts.currency || "USD").toLowerCase(),
  });
  const link = await stripeCall("/v1/payment_links", {
    "line_items[0][price]": price.id,
    "line_items[0][quantity]": 1,
    "metadata[rfq_id]": opts.rfqId,
    "metadata[short_id]": opts.shortId,
    "metadata[buyer_email]": opts.buyerEmail || "",
    allow_promotion_codes: "false",
  });
  return link.url as string;
}

// Wrap plain-text body in branded HTML. Preserves newlines as paragraph breaks.
function wrapEmailHtml(body: string, trackUrl: string) {
  const paras = String(body || "").split(/\n{2,}/).map((p) => esc(p).replace(/\n/g, "<br>"));
  const btn = trackUrl ? `<div style="margin: 24px 0;"><a href="${esc(trackUrl)}" style="display:inline-block; background:#0071e3; color:#fff; padding:12px 24px; border-radius:980px; text-decoration:none; font-size:15px;">View your RFQ ›</a></div>` : "";
  return `<!doctype html><html><body style="font-family:-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px; color:#1d1d1f;">
    <div style="margin-bottom: 24px;"><span style="display:inline-flex; align-items:center; gap:10px; font-size:15px; font-weight:600;"><span style="display:inline-block; width:26px; height:26px; background:#1d1d1f; color:white; border-radius:7px; text-align:center; line-height:26px; font-size:11px;">CS</span>ChipShark</span></div>
    ${paras.map((p) => `<p style="font-size:15px; line-height:1.6; color:#424245; margin:0 0 14px;">${p}</p>`).join("")}
    ${btn}
    <hr style="border:none; border-top:0.5px solid #d2d2d7; margin:30px 0 14px;">
    <p style="font-size:12px; color:#86868b; margin:0;">ChipShark · Hard-to-find electronic components<br><a href="https://chipsharksupply.com" style="color:#86868b; text-decoration:none;">chipsharksupply.com</a></p>
  </body></html>`;
}

async function sendResend(to: string, subject: string, html: string, replyTo?: string) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not configured.");
  const body: Record<string, unknown> = { from: FROM_ADDRESS, to, subject: oneLine(subject, 150), html };
  if (replyTo) body.reply_to = replyTo;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Resend ${res.status}: ${err}`);
  }
  return res.json();
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/admin-api\/?/, "").replace(/\/$/, "");

  try {
    // ---- unauthenticated: setup / verify / status ----
    if (req.method === "POST" && path === "setup") {
      const ip = clientIp(req);
      if (await lockedOut(ip)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
      const body = await req.json().catch(() => ({}));
      const pwd = String(body.password || "");
      if (pwd.length < 8) return json({ error: "Password must be at least 8 characters." }, 400);
      if (pwd.length > 200) return json({ error: "Password too long." }, 400);
      const cfg = await getCfg();
      if (cfg?.password_hash) return json({ error: "Password already configured. Use /verify instead." }, 409);
      // Reset flow (SQL editor): UPDATE admin_config SET password_hash = NULL, setup_token = encode(extensions.gen_random_bytes(8),'hex') RETURNING setup_token;
      const given = String(body.setup_token || "").trim();
      if (!cfg?.setup_token || !safeEq(given, cfg.setup_token)) {
        await recordFailure(ip);
        return json({ error: "Invalid setup token." }, 403);
      }
      const { data: hashRow, error: hashErr } = await admin.rpc("admin_password_hash", { pwd });
      if (hashErr) return json({ error: "Setup failed." }, 500);
      const { error: updErr } = await admin.from("admin_config")
        .update({ password_hash: hashRow, setup_token: null, updated_at: new Date().toISOString() })
        .eq("id", CONFIG_ID);
      if (updErr) return json({ error: "Setup failed." }, 500);
      return json({ ok: true, message: "Admin password set." });
    }

    if (req.method === "POST" && path === "verify") {
      const ip = clientIp(req);
      if (await lockedOut(ip)) return json({ ok: false, error: "Too many attempts. Try again in 15 minutes." }, 429);
      const body = await req.json().catch(() => ({}));
      const ok = await verifyPassword(String(body.password || ""));
      if (!ok) {
        await recordFailure(ip);
        return json({ ok: false }, 401);
      }
      const cfg = await getCfg();
      if (!cfg) return json({ ok: false }, 500);
      return json({ ok: true, token: await issueToken(cfg) });
    }

    if (req.method === "GET" && path === "status") {
      const cfg = await getCfg();
      return json({ setup_required: !cfg?.password_hash });
    }

    // ---- authenticated (session token) ----
    const tok = req.headers.get("x-admin-token") || "";
    if (!(await verifyToken(tok))) return json({ error: "unauthorized" }, 401);

    if (req.method === "GET" && path === "session") return json({ ok: true });

    if (req.method === "GET" && path === "list") {
      const { data, error } = await admin.from("rfqs").select("*").order("created_at", { ascending: false });
      if (error) return json({ error: error.message }, 500);
      return json({ rfqs: data || [] });
    }

    if (req.method === "PATCH" && path === "update") {
      const id = url.searchParams.get("id") || "";
      if (!UUID_RE.test(id)) return json({ error: "valid id required" }, 400);
      const body = await req.json().catch(() => ({}));
      const allowed = ["status", "quote_amount_cents", "quote_currency", "stripe_payment_link", "payment_status"];
      const patch: Record<string, unknown> = {};
      for (const k of allowed) if (k in body) patch[k] = body[k];
      if (Object.keys(patch).length === 0) return json({ error: "No valid fields to update." }, 400);

      if ("quote_amount_cents" in patch && patch.quote_amount_cents != null) {
        const n = patch.quote_amount_cents;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 50_000_000) return json({ error: "quote_amount_cents must be an integer between 0 and 50,000,000." }, 400);
      }
      if ("quote_currency" in patch && patch.quote_currency != null && !/^[A-Za-z]{3}$/.test(String(patch.quote_currency))) {
        return json({ error: "quote_currency must be a 3-letter code." }, 400);
      }
      if ("stripe_payment_link" in patch && patch.stripe_payment_link) {
        if (!STRIPE_LINK_RE.test(String(patch.stripe_payment_link).trim())) return json({ error: "Payment link must be a Stripe URL (https://buy.stripe.com/…)." }, 400);
        patch.stripe_payment_link = String(patch.stripe_payment_link).trim();
      }

      const settingAmount = typeof patch.quote_amount_cents === "number" && patch.quote_amount_cents > 0;
      const noManualLink = !patch.stripe_payment_link || !String(patch.stripe_payment_link).trim();

      if (settingAmount && noManualLink) {
        if (!STRIPE_SECRET) return json({ error: "STRIPE_SECRET_KEY is not set in Supabase secrets." }, 503);
        const { data: rfq, error: rfqErr } = await admin.from("rfqs").select("mpn, qty, email").eq("id", id).single();
        if (rfqErr || !rfq) return json({ error: "RFQ not found" }, 404);
        try {
          patch.stripe_payment_link = await createStripePaymentLink({
            rfqId: id, shortId: id.slice(0, 8).toUpperCase(),
            amountCents: patch.quote_amount_cents as number,
            currency: String(patch.quote_currency || "USD"),
            mpn: rfq.mpn || "", qty: rfq.qty || "", buyerEmail: rfq.email || "",
          });
        } catch (e) {
          return json({ error: "Stripe link creation failed: " + (e as Error).message }, 502);
        }
      }

      const { data, error } = await admin.from("rfqs").update(patch).eq("id", id).select().single();
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true, rfq: data, generated_link: settingAmount && noManualLink });
    }

    // --- Draft email: returns pre-filled subject + body based on type + RFQ ---
    if (req.method === "POST" && path === "draft-email") {
      const body = await req.json().catch(() => ({}));
      const id = String(body.rfq_id || "");
      const type = body.type || "custom";
      if (!UUID_RE.test(id)) return json({ error: "valid rfq_id required" }, 400);
      const { data: rfq, error: rfqErr } = await admin.from("rfqs").select("*").eq("id", id).single();
      if (rfqErr || !rfq) return json({ error: "RFQ not found" }, 404);
      const shortId = id.slice(0, 8).toUpperCase();
      const firstName = (rfq.name || "there").trim().split(/\s+/)[0];
      const amount = rfq.quote_amount_cents ? `$${(rfq.quote_amount_cents / 100).toFixed(2)} ${rfq.quote_currency || "USD"}` : "";
      const trackUrl = `https://chipsharksupply.com/track.html?id=${encodeURIComponent(id)}`;
      let subject = "";
      let draft = "";
      if (type === "quote_ready") {
        subject = `Quote ready — RFQ ${shortId} — ChipShark`;
        draft = `Hi ${firstName},\n\nYour quote is ready: ${amount} for ${rfq.qty} × ${(rfq.mpn || "").split(/\s+/)[0]}.\n\nReview and pay here: ${trackUrl}\n\nLead time: [FILL IN]\nSupplier tier: A — franchised / authorised\n\nReply with any questions.\n\n— ChipShark`;
      } else if (type === "cannot_source") {
        subject = `Update on RFQ ${shortId} — unable to source`;
        draft = `Hi ${firstName},\n\nThanks for your RFQ for ${rfq.qty} × ${(rfq.mpn || "").split(/\s+/)[0]}.\n\nUnfortunately we weren't able to find a reliable source for this at acceptable quality, price, or lead time.\n\nSpecifically: [FILL IN REASON]\n\nSuggestions:\n- [possible alt MPN]\n- [alt approach]\n\nHappy to keep watching for new stock — reply if you'd like us to.\n\n— ChipShark`;
      } else {
        subject = `Update on RFQ ${shortId} — ChipShark`;
        draft = `Hi ${firstName},\n\n[Your message here]\n\n— ChipShark`;
      }
      return json({ subject, body: draft, to: rfq.email, trackUrl });
    }

    // --- Send email: delivers the (possibly edited) draft via Resend ---
    if (req.method === "POST" && path === "send-email") {
      const body = await req.json().catch(() => ({}));
      const id = String(body.rfq_id || "");
      const type = body.type || "custom";
      const subject = String(body.subject || "").trim();
      const draft = String(body.body || "").trim();
      if (!UUID_RE.test(id) || !subject || !draft) return json({ error: "rfq_id, subject, body required" }, 400);
      if (subject.length > 300 || draft.length > 20000) return json({ error: "subject or body too long" }, 400);
      if (!RESEND_API_KEY) return json({ error: "RESEND_API_KEY not configured" }, 503);
      const { data: rfq, error: rfqErr } = await admin.from("rfqs").select("email, name").eq("id", id).single();
      if (rfqErr || !rfq) return json({ error: "RFQ not found" }, 404);
      if (!rfq.email) return json({ error: "RFQ has no buyer email" }, 400);
      const trackUrl = `https://chipsharksupply.com/track.html?id=${encodeURIComponent(id)}`;
      const html = wrapEmailHtml(draft, trackUrl);
      try {
        await sendResend(rfq.email, subject, html, REPLY_TO);
      } catch (e) {
        return json({ error: "Send failed: " + (e as Error).message }, 502);
      }
      // Record + apply status change for cannot_source
      const statusPatch: Record<string, unknown> = { last_email_type: type, last_email_sent_at: new Date().toISOString(), last_email_subject: subject };
      if (type === "cannot_source") statusPatch.status = "unable_to_source";
      await admin.from("rfqs").update(statusPatch).eq("id", id);
      return json({ ok: true, sent_to: rfq.email });
    }

    // --- Delete an RFQ permanently ---
    if (req.method === "DELETE" && path === "rfq") {
      const id = url.searchParams.get("id") || "";
      if (!UUID_RE.test(id)) return json({ error: "valid id required" }, 400);
      const { error } = await admin.from("rfqs").delete().eq("id", id);
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    // --- Sonar provider config (read) ---
    if (req.method === "GET" && path === "sonar-config") {
      const { data, error } = await admin.from("agents")
        .select("id, name, provider, model, base_url, api_key, system_prompt")
        .eq("id", "sonar").maybeSingle();
      if (error) return json({ error: error.message }, 500);
      if (!data) return json({ error: "sonar agent not found" }, 404);
      return json({
        provider: data.provider || "openai_compat",
        model:    data.model    || "",
        base_url: data.base_url || "",
        has_key:  !!(data.api_key && data.api_key.length > 0),
        system_prompt: data.system_prompt || "",
      });
    }

    // --- Sonar provider config (update) ---
    if (req.method === "POST" && path === "sonar-config") {
      const body = await req.json().catch(() => ({}));
      const patch: Record<string, unknown> = {};
      const allowedProviders = new Set(["openai_compat", "anthropic", "google"]);
      if ("provider" in body) {
        const p = String(body.provider || "").toLowerCase();
        if (!allowedProviders.has(p)) return json({ error: "provider must be openai_compat, anthropic, or google" }, 400);
        patch.provider = p;
      }
      if ("model"    in body) patch.model    = String(body.model || "").trim().slice(0, 200);
      if ("base_url" in body) patch.base_url = String(body.base_url || "").trim().slice(0, 300) || null;
      if ("api_key"  in body) {
        const k = String(body.api_key || "").trim();
        // Allow blanking the key; otherwise set it (plaintext — service-role only, admin UI only)
        patch.api_key = k || null;
      }
      if ("system_prompt" in body) patch.system_prompt = String(body.system_prompt || "").slice(0, 10000);
      if (Object.keys(patch).length === 0) return json({ error: "no fields to update" }, 400);
      patch.updated_at = new Date().toISOString();
      const { error } = await admin.from("agents").update(patch).eq("id", "sonar");
      if (error) return json({ error: error.message }, 500);
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  } catch (err) {
    console.error("admin-api error:", err);
    return json({ error: "Server error" }, 500);
  }
});
