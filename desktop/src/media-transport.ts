import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { bytes, request, webStream, cleanHeaders, local } from "./network";
import type { Source } from "./model";
export const toVTT = (raw: string) =>
  raw.trimStart().startsWith("WEBVTT")
    ? raw
    : "WEBVTT\n\n" +
      raw.replace(/^\uFEFF/, "").replace(/(\d\d:\d\d:\d\d),(\d{3})/g, "$1.$2");
// The source's trusted host determines network scope; a provider-supplied
// stream URL must never widen that scope to private network addresses.
export function sourceIsPublic(source: Source) {
  try {
    return !local(
      new URL(
        source.host.includes("://") ? source.host : `https://${source.host}`,
      ).hostname,
    );
  } catch {
    return true;
  }
}
export class MediaTransport {
  entries = new Map<string, any>();
  register(url: string, source: Source, headers: any = {}, format?: string) {
    if (this.entries.size > 20000) this.entries.clear();
    const token = randomBytes(24).toString("hex");
    this.entries.set(token, {
      url,
      source,
      headers: cleanHeaders(headers, true),
      format,
    });
    return `oxa://media/${token}`;
  }
  file(root: string, file: string) {
    const token = randomBytes(24).toString("hex");
    this.entries.set(token, { root, file });
    return `oxa://media/${token}`;
  }
  forget() {
    this.entries.clear();
  }
  async handle(req: Request) {
    const token = new URL(req.url).pathname.split("/")[1],
      entry = this.entries.get(token);
    if (!entry) return new Response("Media session expired.", { status: 404 });
    try {
      if (entry.root) {
        const root = fs.realpathSync(entry.root),
          file = fs.realpathSync(path.join(root, entry.file));
        if (!file.startsWith(root + path.sep))
          return new Response(null, { status: 403 });
        const stat = fs.statSync(file);
        if (file.endsWith(".m3u8")) {
          const raw = fs.readFileSync(file, "utf8");
          const rewrite = (uri: string) => this.file(root, uri);
          return new Response(this.rewrite(raw, rewrite), {
            headers: { "Content-Type": "application/vnd.apple.mpegurl" },
          });
        }
        if (file.endsWith(".vtt"))
          return new Response(fs.readFileSync(file), {
            headers: { "Content-Type": "text/vtt" },
          });
        const range = req.headers.get("range");
        let start = 0,
          end = stat.size - 1,
          status = 200;
        const match = range?.match(/^bytes=(\d+)-(\d*)$/);
        if (match) {
          start = Number(match[1]);
          end = match[2] ? Math.min(Number(match[2]), end) : end;
          status = 206;
          if (start > end || start >= stat.size)
            return new Response(null, {
              status: 416,
              headers: { "Content-Range": `bytes */${stat.size}` },
            });
        }
        const headers: any = {
          "Content-Type": file.endsWith(".ts")
            ? "video/mp2t"
            : file.endsWith(".webm")
              ? "video/webm"
              : "video/mp4",
          "Content-Length": String(end - start + 1),
          "Accept-Ranges": "bytes",
        };
        if (status === 206)
          headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
        return new Response(
          webStream(fs.createReadStream(file, { start, end })),
          { status, headers },
        );
      }
      const extra: any = { ...entry.headers };
      if (req.headers.has("range")) extra.Range = req.headers.get("range");
      const options = {
        source: entry.source,
        media: true,
        publicOnly: sourceIsPublic(entry.source),
        headers: extra,
      };
      const r = await request(entry.url, options);
      const mime = String(r.headers["content-type"] || "");
      if (r.status < 200 || r.status >= 300) {
        r.stream.resume();
        return new Response("Stream unavailable.", { status: r.status });
      }
      if (
        entry.format === "hls" ||
        /mpegurl/.test(mime) ||
        new URL(r.url).pathname.endsWith(".m3u8")
      ) {
        const chunks: Buffer[] = [];
        let n = 0;
        for await (const b of r.stream) {
          n += b.length;
          if (n > 4 * 1024 * 1024) {
            r.stream.destroy();
            throw Error("Playlist too large.");
          }
          chunks.push(b);
        }
        const text = Buffer.concat(chunks).toString();
        if (!text.trimStart().startsWith("#EXTM3U"))
          throw Error("Invalid HLS manifest.");
        const rewrite = (raw: string) => {
          const child = new URL(raw, r.url);
          const same = child.origin === new URL(entry.url).origin;
          return this.register(
            child.href,
            entry.source,
            same ? entry.headers : cleanHeaders(entry.headers, false),
          );
        };
        return new Response(this.rewrite(text, rewrite), {
          headers: { "Content-Type": "application/vnd.apple.mpegurl" },
        });
      }
      const headers: any = {};
      for (const k of [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
      ])
        if (r.headers[k]) headers[k] = String(r.headers[k]);
      headers["Cache-Control"] = "no-store";
      return new Response(webStream(r.stream), { status: r.status, headers });
    } catch {
      return new Response(
        "Media request failed. Check the source and its format.",
        { status: 502 },
      );
    }
  }
  rewrite(text: string, resolve: (raw: string) => string) {
    return text
      .split(/\r?\n/)
      .map((line) =>
        line.startsWith("#")
          ? line.replace(/URI="([^"]+)"/g, (_m, uri) => `URI="${resolve(uri)}"`)
          : line.trim()
            ? resolve(line.trim())
            : line,
      )
      .join("\n");
  }
  async caption(url: string, source: Source, headers: any) {
    const b = await bytes(url, {
      source,
      headers,
      publicOnly: sourceIsPublic(source),
      limit: 2 * 1024 * 1024,
    });
    const token = randomBytes(24).toString("hex");
    this.entries.set(token, { caption: toVTT(b.data.toString()) });
    return `oxa://caption/${token}`;
  }
  captionResponse(req: Request) {
    return new Response(
      this.entries.get(new URL(req.url).pathname.split("/")[1])?.caption || "",
      { headers: { "Content-Type": "text/vtt" } },
    );
  }
  captionText(raw: string) {
    const token = randomBytes(24).toString("hex");
    this.entries.set(token, { caption: toVTT(raw) });
    return `oxa://caption/${token}`;
  }
}
