import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { Readable } from "node:stream";
import type { Source } from "./model";
export function local(host: string) {
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    (!host.includes(".") && !host.includes(":"))
  )
    return true;
  if (host === "::1" || (/^(fc|fd|fe80:)/.test(host) && host.includes(":")))
    return true;
  const p = host.split(".").map(Number);
  return (
    p.length === 4 &&
    (p[0] === 10 ||
      p[0] === 127 ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 169 && p[1] === 254))
  );
}
export function publicIP(ip: string) {
  ip = ip.toLowerCase();
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
    if (net.isIP(ip) !== 4) return false;
  }
  if (!net.isIP(ip) || local(ip)) return false;
  if (net.isIP(ip) === 4) {
    const [a, b, c] = ip.split(".").map(Number);
    return !(
      a === 0 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 192 && (b === 0 || b === 2 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  // Only global unicast: exclude NAT64, mapped/compatible, multicast,
  // documentation, and tunnelling ranges that could reach a private endpoint.
  return (
    /^[23][0-9a-f]{3}:/.test(ip) &&
    !ip.startsWith("2001:db8:") &&
    !ip.startsWith("2002:") &&
    !ip.startsWith("2001:0:")
  );
}
export function urlCheck(
  raw: string,
  source: Partial<Source> = {},
  media = false,
) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw Error("Enter a valid HTTP or HTTPS URL.");
  }
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    !u.hostname ||
    raw.length > 16384
  )
    throw Error("Use HTTP/HTTPS without embedded credentials.");
  if (
    u.protocol === "http:" &&
    !(media && source.allowInsecureStreams) &&
    !(source.allowHTTP && local(u.hostname))
  )
    throw Error(
      "Use HTTPS, or explicitly allow local HTTP / HTTP media streams for this source.",
    );
  return u;
}
export function cleanHeaders(headers: any, allowAuth = false) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (typeof v !== "string" || v.length > 16384 || /[\r\n]/.test(v)) continue;
    if (
      [
        "accept",
        "content-type",
        "user-agent",
        "referer",
        "origin",
        "range",
        "depth",
        "accept-language",
      ].includes(k.toLowerCase()) ||
      (allowAuth &&
        [
          "authorization",
          "x-emby-token",
          "x-plex-token",
          "x-emby-authorization",
        ].includes(k.toLowerCase()))
    )
      out[k] = v;
  }
  return out;
}
export type RequestOptions = {
  source?: Partial<Source>;
  media?: boolean;
  publicOnly?: boolean;
  method?: string;
  headers?: any;
  body?: string | Buffer;
  limit?: number;
  signal?: AbortSignal;
  raw?: boolean;
  budget?: { remaining: number };
};
export class ResponseLimitError extends Error {}
export async function request(
  raw: string,
  opts: RequestOptions = {},
  hops = 0,
): Promise<{
  stream: http.IncomingMessage;
  url: string;
  status: number;
  headers: http.IncomingHttpHeaders;
}> {
  if (hops > 8) throw Error("Too many redirects.");
  const u = urlCheck(raw, opts.source, opts.media);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const records = net.isIP(host)
    ? [{ address: host, family: net.isIP(host) }]
    : await dns.lookup(host, { all: true });
  const privateAllowed = !opts.publicOnly && local(host);
  if (
    !records.length ||
    records.some(
      (r) =>
        (!privateAllowed && !publicIP(r.address)) ||
        r.address === "169.254.169.254",
    )
  )
    throw Error("This request resolves to a disallowed network address.");
  const address = records[0];
  return await new Promise((resolve, reject) => {
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: opts.method || "GET",
        headers: {
          ...cleanHeaders(opts.headers, true),
          "Accept-Encoding": "identity",
          ...(opts.body
            ? { "Content-Length": String(Buffer.byteLength(opts.body)) }
            : {}),
        },
        signal: opts.signal,
        timeout: 25000,
        autoSelectFamily: false,
        lookup: (_h: any, _o: any, cb: any) =>
          cb(null, address.address, address.family),
      } as http.RequestOptions & { autoSelectFamily: boolean },
      async (res) => {
        const status = res.statusCode || 0;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location
        ) {
          res.resume();
          try {
            const next = new URL(res.headers.location, u);
            const same = next.origin === u.origin;
            const headers = same
              ? opts.headers
              : cleanHeaders(opts.headers, false);
            if (
              u.protocol === "https:" &&
              next.protocol === "http:" &&
              !(opts.media && opts.source?.allowInsecureStreams)
            )
              throw Error("An insecure redirect was blocked.");
            resolve(
              await request(
                next.href,
                {
                  ...opts,
                  headers,
                  method: status === 303 ? "GET" : opts.method,
                  body: status === 303 ? undefined : opts.body,
                },
                hops + 1,
              ),
            );
          } catch (e) {
            reject(e);
          }
          return;
        }
        resolve({ stream: res, url: u.href, status, headers: res.headers });
      },
    );
    req.on("timeout", () => req.destroy(Error("Connection timed out.")));
    req.on("error", () =>
      reject(
        Error(
          "Could not connect to this source. Check its address and network access.",
        ),
      ),
    );
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
export async function bytes(raw: string, opts: RequestOptions = {}) {
  const r = await request(raw, opts);
  const chunks: Buffer[] = [];
  let size = 0,
    limit = opts.limit ?? 16 * 1024 * 1024;
  for await (const part of r.stream) {
    size += part.length;
    if (opts.budget) {
      opts.budget.remaining -= part.length;
      if (opts.budget.remaining < 0) {
        r.stream.destroy();
        throw new ResponseLimitError(
          "The source exceeds the library response budget. Add a smaller library.",
        );
      }
    }
    if (size > limit) {
      r.stream.destroy();
      throw new ResponseLimitError(
        "The server response exceeds the size limit.",
      );
    }
    chunks.push(part);
  }
  if (!opts.raw && (r.status < 200 || r.status >= 300))
    throw Error(
      r.status === 401 || r.status === 403
        ? "Source access was rejected. Check your login or subscription."
        : `Source request failed (${r.status}).`,
    );
  return { ...r, data: Buffer.concat(chunks) };
}
export async function json(raw: string, opts: RequestOptions = {}) {
  const r = await bytes(raw, {
    ...opts,
    headers: { Accept: "application/json", ...opts.headers },
  });
  try {
    return JSON.parse(r.data.toString());
  } catch {
    throw Error("The source did not return a supported library response.");
  }
}
export const webStream = (r: Readable) =>
  Readable.toWeb(r) as ReadableStream<Uint8Array>;
