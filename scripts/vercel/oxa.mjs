// Vercel entry point for the private web gateway. Vercel rewrites
// /web/api/:op here; the gateway itself expects its public URL back.
import { createGateway } from "../lib/oxa-gateway.mjs";

const origins = new Set(["https://oxapay.cc", "https://www.oxapay.cc"]);
for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) if (host) origins.add("https://" + host);
for (const origin of (process.env.OXA_WEB_ORIGINS || "").split(",")) if (origin.trim()) origins.add(origin.trim());
const gateway = createGateway({ key: process.env.OXA_WEB_GATEWAY_KEY, origins: [...origins] });

// Vercel ignores the gateway's Netlify rateLimit config. Keep the same budget
// (600 requests a minute per IP) for each warm function instance.
const WINDOW_MS = 60_000, LIMIT = 600, hits = new Map();
function limited(request) {
  const ip = (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const now = Date.now(), entry = hits.get(ip);
  if (!entry || now - entry.start >= WINDOW_MS) {
    if (hits.size > 50_000) for (const [key, value] of hits) if (now - value.start >= WINDOW_MS) hits.delete(key);
    hits.set(ip, { start: now, count: 1 });
    return false;
  }
  return ++entry.count > LIMIT;
}

async function handle(request) {
  if (limited(request))
    return Response.json({ error: "Too many requests. Wait a minute and retry." }, { status: 429, headers: { "Retry-After": "60", "Cache-Control": "no-store" } });
  const incoming = new URL(request.url);
  const op = incoming.searchParams.get("op") || "";
  incoming.searchParams.delete("op");
  const host = request.headers.get("x-forwarded-host") || incoming.host;
  const url = new URL("/web/api/" + encodeURIComponent(op) + incoming.search, "https://" + host);
  const init = { method: request.method, headers: request.headers, signal: request.signal };
  if (!["GET", "HEAD"].includes(request.method)) { init.body = request.body; init.duplex = "half"; }
  return gateway(new Request(url, init), { params: { op } });
}
export const GET = handle, HEAD = handle, POST = handle;
