// api/creator-click.js — Vercel serverless function
//
// Logs one click on a creator landing page (parentingai.co/c/<handle>) to
// Supabase. First-party click counting is attribution layer 1 for the
// creator program (SPEC_INFLUENCER_PROGRAM.md §5a.1): clicks are ours and
// exact; redemptions come from App Store Connect; cohort economics from
// RevenueCat. Same trust posture as api/waitlist.js — anon key server-side,
// insert-only RLS, so a leaked key can add rows but never read them.
//
// ENV VARS (already set for the waitlist): SUPABASE_URL, SUPABASE_ANON_KEY.
// Table: creator_clicks — see supabase SQL in docs/CREATOR_LINKS_RUNBOOK.md.

const HANDLE_RE = /^[a-z0-9_-]{1,64}$/;

const seen = new Map();
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 20; // clicks are cheaper than emails; still bounded

function rateLimited(ip) {
  const now = Date.now();
  const hits = (seen.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  seen.set(ip, hits);
  if (seen.size > 5000) seen.clear();
  return hits.length > MAX_PER_WINDOW;
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }

  const SUPABASE_URL = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const SUPABASE_ANON_KEY = (process.env.SUPABASE_ANON_KEY || "").replace(/\s/g, "");
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("creator-click: missing SUPABASE_URL or SUPABASE_ANON_KEY");
    return res.status(500).json({ error: "not_configured" });
  }

  let body = req.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_json" }); }
  }
  const { handle, referrer } = body || {};

  if (typeof handle !== "string" || !HANDLE_RE.test(handle.toLowerCase())) {
    return res.status(400).json({ error: "invalid_handle" });
  }

  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || "unknown";
  if (rateLimited(ip)) return res.status(429).json({ error: "slow_down" });

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/creator_clicks`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify([
        {
          handle: handle.toLowerCase(),
          referrer: typeof referrer === "string" ? referrer.slice(0, 300) : null,
          user_agent: String(req.headers["user-agent"] || "").slice(0, 200),
        },
      ]),
    });

    if (!r.ok) {
      const detail = await r.text();
      console.error("creator-click: supabase responded", r.status, detail);
      return res.status(502).json({ error: "upstream", upstream_status: r.status });
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error("creator-click: insert failed", err);
    return res.status(502).json({ error: "upstream" });
  }
}
