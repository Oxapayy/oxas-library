// Vercel entry point for the private web gateway. Vercel rewrites
// /web/api/:op here; the gateway itself expects its public URL back.
import { createGateway } from "../lib/oxa-gateway.mjs";

const origins = new Set(["https://oxapay.cc", "https://www.oxapay.cc"]);
for (const host of [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL, process.env.VERCEL_PROJECT_PRODUCTION_URL]) if (host) origins.add("https://" + host);
for (const origin of (process.env.OXA_WEB_ORIGINS || "").split(",")) if (origin.trim()) origins.add(origin.trim());
const gateway = createGateway({ key: process.env.OXA_WEB_GATEWAY_KEY, origins: [...origins] });

async function handle(request) {
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
