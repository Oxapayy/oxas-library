import fs from "node:fs";
import path from "node:path";
import { once } from "node:events";
import { Disk } from "./storage";
import { hash, Media, uuid } from "./model";
import { Provider } from "./providers";
import { request, bytes, local, cleanHeaders } from "./network";
import { toVTT } from "./media-transport";
export class Downloads {
  active = new Map<string, AbortController>();
  running = false;
  epoch = 0;
  constructor(
    public disk: Disk,
    public provider: (m: Media) => Provider,
    public changed: () => void,
  ) {}
  persist(progress = false) {
    // Byte counts are cosmetic and rebuilt on retry; checkpoint them rarely.
    if (progress && this.disk.saveSoon) this.disk.saveSoon(15000);
    else this.disk.save();
    this.changed();
  }
  add(items: Media[], choice?: any) {
    for (const m of items) {
      if (m.kind === "channel" || m.kind === "series") continue;
      const exists = this.disk.state.transfers.find(
        (t) =>
          t.media.id === m.id &&
          ["ready", "queued", "downloading"].includes(t.state),
      );
      if (exists) continue;
      this.disk.state.transfers.push({
        id: uuid(),
        media: m,
        state: "queued",
        bytes: 0,
        fraction: 0,
        choice,
      });
    }
    this.persist();
    void this.pump();
  }
  cancel(id: string) {
    this.active.get(id)?.abort();
    const t = this.disk.state.transfers.find((t) => t.id === id);
    if (t && t.state !== "ready") {
      t.state = "cancelled";
      t.error = "Cancelled. Retry to continue.";
      this.persist();
    }
  }
  retry(id: string) {
    const t = this.disk.state.transfers.find((t) => t.id === id);
    if (t && !this.active.has(id)) {
      t.state = "queued";
      t.error = undefined;
      this.persist();
      void this.pump();
    }
  }
  delete(id: string) {
    this.cancel(id);
    const t = this.disk.state.transfers.find((t) => t.id === id);
    if (t) {
      const dir = path.join(this.disk.mediaRoot, hash(t.id));
      fs.rmSync(dir, { recursive: true, force: true });
      this.disk.state.transfers = this.disk.state.transfers.filter(
        (x) => x.id !== id,
      );
      this.persist();
    }
  }
  suspend() {
    this.epoch++;
    for (const c of this.active.values()) c.abort();
    this.active.clear();
  }
  async file(
    url: string,
    dest: string,
    opts: any,
    signal: AbortSignal,
    update: (n: number, total: number) => void,
  ) {
    fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
    const partial = dest + ".part";
    let existing = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
    const response = await request(url, {
      ...opts,
      signal,
      media: true,
      headers: {
        ...opts.headers,
        ...(existing ? { Range: `bytes=${existing}-` } : {}),
      },
    });
    if (response.status === 416 && existing) {
      fs.rmSync(partial, { force: true });
      response.stream.resume();
      return this.file(url, dest, opts, signal, update);
    }
    if (response.status < 200 || response.status >= 300) {
      response.stream.resume();
      throw Error("Download source unavailable. Try resolving a fresh stream.");
    }
    if (/text\/html/i.test(response.headers["content-type"] || "")) {
      response.stream.resume();
      throw Error("The source returned a web page instead of video.");
    }
    // Append only when the server continues exactly where the partial file ends.
    const range = /^bytes (\d+)-/.exec(response.headers["content-range"] || "");
    if (
      response.status === 206 &&
      existing &&
      range &&
      Number(range[1]) !== existing
    ) {
      response.stream.resume();
      fs.rmSync(partial, { force: true });
      return this.file(url, dest, opts, signal, update);
    }
    if (response.status !== 206) existing = 0;
    const expected = Number(response.headers["content-length"] || 0) + existing;
    const output = fs.createWriteStream(partial, {
      flags: existing ? "a" : "w",
      mode: 0o600,
    });
    let count = existing,
      lastCheck = 0,
      writeError: Error | undefined;
    output.on("error", (error) => {
      writeError = error;
      response.stream.destroy(error);
    });
    try {
      for await (const chunk of response.stream) {
        if (signal.aborted) throw Error("Cancelled");
        count += chunk.length;
        if (count - lastCheck > 32 * 1024 * 1024) {
          lastCheck = count;
          const free = fs.statfsSync(path.dirname(dest));
          if (free.bavail * free.bsize < 64 * 1024 * 1024)
            throw Error("Not enough free disk space.");
        }
        if (!output.write(chunk)) await once(output, "drain");
        update(count, expected);
      }
      if (writeError) throw writeError;
      output.end();
      await once(output, "finish");
      if (expected && count !== expected)
        throw Error("The download ended before all bytes arrived.");
      if (!count) throw Error("The download is empty.");
      fs.renameSync(partial, dest);
      return count;
    } catch (e) {
      output.destroy();
      throw e;
    }
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    const epoch = this.epoch,
      scope = this.disk.scope;
    try {
      while (epoch === this.epoch && scope === this.disk.scope) {
        const t = this.disk.state.transfers.find((t) => t.state === "queued");
        if (!t) break;
        const controller = new AbortController();
        this.active.set(t.id, controller);
        t.state = "downloading";
        this.persist();
        const folder = path.join(this.disk.mediaRoot, hash(t.id));
        fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
        try {
          const api = this.provider(t.media);
          let choice = t.choice;
          if (choice && t.media.websiteItem) {
            const choices = await api.sources(t.media);
            choice = choices.sources.find(
              (x) =>
                x.name === choice.name &&
                x.quality === choice.quality &&
                JSON.stringify(x.languages) ===
                  JSON.stringify(choice.languages),
            );
            if (!choice)
              throw Error(
                "The selected server is no longer available. Choose it again.",
              );
          }
          const play = await api.playback(
            t.media,
            choice,
            true,
            this.disk.state.preferences.subtitleLanguage,
          );
          const opts = api.opts({ headers: play.headers, media: true });
          let last = 0;
          const update = (n: number, total: number) => {
            t.bytes = n;
            t.fraction = total ? n / total : 0;
            if (Date.now() - last > 700 && epoch === this.epoch) {
              last = Date.now();
              this.persist(true);
            }
          };
          const isHLS =
            play.format === "hls" ||
            new URL(play.url).pathname.endsWith(".m3u8") ||
            (await this.probeHLS(play.url, opts));
          let entry =
            play.format === "mpegts"
              ? "video.mpegts"
              : new URL(play.url).pathname.endsWith(".webm")
                ? "video.webm"
                : "video.mp4";
          if (!isHLS) t.format = play.format;
          if (isHLS) {
            entry = "index.m3u8";
            t.bytes = 0;
            const assets = new Map<string, string>();
            let assetCount = 0;
            const get = async (url: string, depth = 0): Promise<string> => {
              if (depth > 8 || assets.size > 12000)
                throw Error("This HLS download is too complex.");
              if (assets.has(url)) return assets.get(url)!;
              const isRoot = depth === 0;
              let name = isRoot
                ? entry
                : `asset-${assets.size}${new URL(url).pathname.endsWith(".m3u8") ? ".m3u8" : ".bin"}`;
              assets.set(url, name);
              const r = await bytes(url, {
                ...opts,
                headers:
                  new URL(url).origin === new URL(play.url).origin
                    ? play.headers
                    : cleanHeaders(play.headers, false),
                signal: controller.signal,
                limit: 32 * 1024 * 1024,
              });
              const text = r.data.subarray(0, 20).toString();
              if (text.trimStart().startsWith("#EXTM3U")) {
                if (!name.endsWith(".m3u8")) {
                  name = name.replace(/\.bin$/, ".m3u8");
                  assets.set(url, name);
                }
                const manifest = r.data.toString();
                if (
                  !manifest.includes("#EXT-X-STREAM-INF") &&
                  !manifest.includes("#EXT-X-ENDLIST") &&
                  manifest.includes("#EXTINF")
                )
                  throw Error("Live HLS cannot be downloaded.");
                if (
                  /METHOD=(?!NONE|AES-128)[\w-]+|KEYFORMAT="(?!identity)/.test(
                    manifest,
                  )
                )
                  throw Error("Protected HLS cannot be saved offline.");
                const lines: string[] = [];
                for (const line of manifest.split(/\r?\n/)) {
                  if (line.startsWith("#")) {
                    let changed = line;
                    for (const m of line.matchAll(/URI="([^"]+)"/g)) {
                      const child = await get(
                        new URL(m[1], r.url).href,
                        depth + 1,
                      );
                      changed = changed.replace(m[0], `URI="${child}"`);
                    }
                    lines.push(changed);
                  } else if (line.trim())
                    lines.push(
                      await get(new URL(line.trim(), r.url).href, depth + 1),
                    );
                  else lines.push(line);
                }
                fs.writeFileSync(path.join(folder, name), lines.join("\n"), {
                  mode: 0o600,
                });
              } else {
                fs.writeFileSync(path.join(folder, name), r.data, {
                  mode: 0o600,
                });
                t.bytes += r.data.length;
                assetCount++;
                if (assetCount % 4 === 0) this.persist(true);
              }
              return name;
            };
            await get(play.url);
            t.format = "hls";
          } else {
            const dest = path.join(folder, entry);
            // A retry resolves a fresh stream, which may be another file or
            // mirror. Never append its bytes to a partial file from a different URL.
            if (t.partURL !== play.url)
              fs.rmSync(dest + ".part", { force: true });
            t.partURL = play.url;
            t.bytes = await this.file(
              play.url,
              dest,
              opts,
              controller.signal,
              update,
            );
          }
          if (play.media.subtitleURL)
            try {
              const r = await bytes(
                play.media.subtitleURL,
                api.opts({ limit: 2 * 1024 * 1024, signal: controller.signal }),
              );
              fs.writeFileSync(
                path.join(folder, "captions.vtt"),
                toVTT(r.data.toString()),
                { mode: 0o600 },
              );
              t.caption = true;
            } catch {}
          if (controller.signal.aborted || epoch !== this.epoch)
            throw Error("Cancelled");
          t.entry = entry;
          t.state = "ready";
          t.fraction = 1;
          t.error = undefined;
          this.persist();
        } catch (e: any) {
          if (
            epoch === this.epoch &&
            scope === this.disk.scope &&
            this.disk.state.transfers.some((x) => x.id === t.id)
          ) {
            t.state = controller.signal.aborted ? "cancelled" : "failed";
            t.error = e.message?.includes("disk")
              ? "Not enough free disk space."
              : controller.signal.aborted
                ? "Cancelled. Retry to continue."
                : "Download failed. Check the source, format and free space, then retry.";
            this.persist();
          }
        } finally {
          this.active.delete(t.id);
        }
      }
    } finally {
      this.running = false;
      if (
        epoch !== this.epoch &&
        this.disk.state.transfers.some((t) => t.state === "queued")
      )
        void this.pump();
    }
  }
  async probeHLS(url: string, opts: any) {
    const r = await request(url, { ...opts, method: "HEAD", media: true });
    r.stream.resume();
    return /mpegurl/i.test(r.headers["content-type"] || "");
  }
}
