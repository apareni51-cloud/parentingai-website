// api/waitlist.js — Vercel serverless function
//
// Captures a waitlist email and writes it to Supabase.
//
// WHY THIS IS A FUNCTION AND NOT A DIRECT BROWSER -> SUPABASE CALL
// A direct call would put the anon key in the page, which is workable but
// gives spammers a free write endpoint with no honeypot and no shaping. This
// keeps the key server-side and lets us drop obvious bots before they hit
// the database.
//
// ENV VARS required in Vercel (Project -> Settings -> Environment Variables):
//   SUPABASE_URL       https://apbjqrnnilcfpbqapzln.supabase.co
//   SUPABASE_ANON_KEY  the anon/publishable key — NOT the service role key
//
// The anon key is deliberate. The waitlist table's RLS policy allows INSERT
// and nothing else, so the worst case if this key ever leaks is that someone
// can add rows. A service-role key would let them read every address.
// See supabase/migrations/20260825000000_waitlist.sql.

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

// Best-effort burst limiter. Vercel recycles instances, so this is a speed
// bump, not a wall — it exists to blunt a naive script, not a determined one.
const seen = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;

function rateLimited(ip) {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 5000) seen.clear(); // bound memory
  return hits.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  // Env values get pasted by hand into a dashboard, so treat them as dirty.
  // A trailing newline on the key produces a malformed Authorization header
  // and Supabase rejects it; a trailing slash on the URL produces a double
  // slash and PostgREST 404s. Both fail identically and opaquely, so strip
  // them here rather than relying on whoever pasted them being careful.
  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").replace(/\s/g, "");

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("waitlist: missing SUPABASE_URL or SUPABASE_ANON_KEY");
    return res.status(500).json({ error: "not_configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  const { email, ct, company } = body || {};

  // Honeypot: a real browser never fills this. Return 200 so bots think they won.
  if (company) return res.status(200).json({ ok: true });

  if (typeof email !== "string" || !EMAIL_RE.test(email) || email.length > 254) {
    return res.status(400).json({ error: "invalid_email" });
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "slow_down" });

  // `ct` is a campaign tag we generate ourselves — keep it to a known shape so
  // this column can never become a free-text sink.
  const source =
    typeof ct === "string" && /^[a-z0-9_-]{1,64}$/i.test(ct) ? ct : "web_home_direct";

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        // Plain insert only.
        //
        // This previously sent `resolution=ignore-duplicates` for
        // idempotency, which makes PostgREST emit ON CONFLICT DO NOTHING.
        // Under RLS that upsert path is evaluated against more than the
        // INSERT policy — resolving the conflict requires reading the
        // existing row — and this table deliberately has no SELECT policy.
        // Result: every request failed with 42501 "new row violates row
        // level security policy", even though a plain insert with the same
        // key and role succeeds. Duplicates are handled by catching 409
        // below instead.
        Prefer: "return=minimal",
      },
      body: JSON.stringify([
        {
          email: email.toLowerCase(),
          source,
          user_agent: String(req.headers["user-agent"] || "").slice(0, 200),
        },
      ]),
    });

    if (!r.ok && r.status !== 409) {
      const detail = await r.text();
      console.error("waitlist: supabase responded", r.status, detail);
      // Surface the upstream status code (never the body) so a failure is
      // diagnosable from a plain curl instead of the Vercel log viewer.
      // 401 = bad key · 404 = bad URL · 403 = RLS or missing grant.
      return res.status(502).json({ error: "upstream", upstream_status: r.status });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("waitlist: insert failed", err);
    return res.status(502).json({ error: "upstream" });
  }
}
