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
  // Catalog artwork has a different lifetime from a playback session. A large
  // poster grid must never evict a video's root capability (or earlier posters).
  private artworkEntries = new Map<string, any>();
  private childEntries = new Map<string, any>();
  entries = new Map<string, any>();
  private remote(url: string, source: Source, headers: any, format?: string) {
    return { url, source, headers: cleanHeaders(headers, true), format };
  }
  private add(entry: any, kind: "root" | "artwork" | "child" = "root") {
    const entries =
      kind === "artwork"
        ? this.artworkEntries
        : kind === "child"
          ? this.childEntries
          : this.entries;
    if (kind === "child" && entries.size >= 20000)
      entries.delete(entries.keys().next().value);
    // Fail closed on pathological catalogs without invalidating live tokens.
    if (kind === "artwork" && entries.size >= 300000)
      throw Error("Artwork catalog exceeds its size limit.");
    const token = randomBytes(24).toString("hex");
    entries.set(token, entry);
    return `oxa://media/${token}`;
  }
  register(url: string, source: Source, headers: any = {}, format?: string) {
    return this.add(this.remote(url, source, headers, format));
  }
  artwork(url: string, source: Source, headers: any = {}) {
    return this.add(this.remote(url, source, headers), "artwork");
  }
  file(root: string, file: string, child = false) {
    return this.add({ root, file }, child ? "child" : "root");
  }
  closePlayback() {
    this.entries.clear();
    this.childEntries.clear();
  }
  forgetArtwork() {
    this.artworkEntries.clear();
  }
  forget() {
    this.closePlayback();
    this.forgetArtwork();
  }
  async handle(req: Request) {
    const token = new URL(req.url).pathname.split("/")[1],
      entry =
        this.entries.get(token) ||
        this.artworkEntries.get(token) ||
        this.childEntries.get(token);
    if (!entry) return new Response("Media session expired.", { status: 404 });
    if (this.childEntries.has(token)) {
      this.childEntries.delete(token);
      this.childEntries.set(token, entry);
    }
    try {
      if (entry.root) {
        const root = fs.realpathSync(entry.root),
          file = fs.realpathSync(path.join(root, entry.file));
        if (!file.startsWith(root + path.sep))
          return new Response(null, { status: 403 });
        const stat = fs.statSync(file);
        if (file.endsWith(".m3u8")) {
          const raw = fs.readFileSync(file, "utf8");
          const rewrite = (uri: string) => this.file(root, uri, true);
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
          return this.add(
            this.remote(
              child.href,
              entry.source,
              same ? entry.headers : cleanHeaders(entry.headers, false),
            ),
            "child",
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
