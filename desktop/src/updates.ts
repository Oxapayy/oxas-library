import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { once } from "node:events";
import { bytes, json, request } from "./network";
const RELEASES =
  "https://api.github.com/repos/Oxapayy/oxas-library/releases?per_page=30";
export type Release = {
  tag_name: string;
  draft?: boolean;
  prerelease?: boolean;
  html_url: string;
  assets: { name: string; browser_download_url: string }[];
};
export type Offer = {
  version: string;
  notes: string;
  file: string;
  url: string;
  sums: string;
};
// Compares dotted numeric versions, so 1.0.10 is newer than 1.0.9.
export function newer(candidate: string, current: string) {
  const a = candidate.split(".").map(Number),
    b = current.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d > 0;
  }
  return false;
}
// Picks the newest published desktop release that ships an installer for this
// platform and architecture together with its checksum file.
export function pick(
  releases: Release[],
  current: string,
  platform: string,
  arch: string,
): Offer | undefined {
  let best: Offer | undefined;
  for (const r of releases) {
    const version = /^desktop-v(\d+\.\d+\.\d+)$/.exec(r.tag_name)?.[1];
    if (!version || r.draft || r.prerelease || !newer(version, current))
      continue;
    if (best && !newer(version, best.version)) continue;
    const file =
      platform === "win32"
        ? `Oxa-Library-Setup-${version}.exe`
        : platform === "darwin"
          ? `Oxas-Library-Desktop-${version}-macOS-${arch === "arm64" ? "arm64" : "x64"}.dmg`
          : "";
    const asset = r.assets.find((a) => a.name === file),
      sums = r.assets.find((a) => /^SHA256SUMS(\.txt)?$/.test(a.name));
    if (asset && sums)
      best = {
        version,
        notes: r.html_url,
        file,
        url: asset.browser_download_url,
        sums: sums.browser_download_url,
      };
  }
  return best;
}
export type UpdateStatus = {
  version?: string;
  notes?: string;
  state: "none" | "available" | "downloading" | "ready" | "failed";
  fraction?: number;
  error?: string;
};
export class Updates {
  offer?: Offer;
  status: UpdateStatus = { state: "none" };
  installer?: string;
  checkFailed = false;
  constructor(
    public current: string,
    public folder: () => string,
    public changed: () => void,
  ) {}
  async check() {
    if (this.status.state === "downloading" || this.status.state === "ready")
      return this.status;
    try {
      const releases = await json(RELEASES, {
        publicOnly: true,
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Oxas-Library-Desktop",
        },
        limit: 4 * 1024 * 1024,
      });
      this.offer = pick(
        Array.isArray(releases) ? releases : [],
        this.current,
        process.platform,
        process.arch,
      );
      this.status = this.offer
        ? {
            state: "available",
            version: this.offer.version,
            notes: this.offer.notes,
          }
        : { state: "none" };
      this.checkFailed = false;
    } catch {
      // A failed background check stays silent; the next check tries again.
      this.checkFailed = true;
    }
    this.changed();
    return this.status;
  }
  async download() {
    const offer = this.offer;
    if (!offer || this.status.state === "downloading") return this.status;
    this.status = { ...this.status, state: "downloading", fraction: 0 };
    this.changed();
    const dest = path.join(this.folder(), offer.file),
      partial = dest + ".part";
    let out: fs.WriteStream | undefined;
    try {
      const list = (
        await bytes(offer.sums, { publicOnly: true, limit: 256 * 1024 })
      ).data.toString();
      const expected = new RegExp(
        `^([0-9a-f]{64})\\s+\\*?${offer.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
        "im",
      ).exec(list)?.[1];
      if (!expected) throw Error("The release has no checksum for this file.");
      const r = await request(offer.url, { publicOnly: true });
      if (r.status !== 200) {
        r.stream.resume();
        throw Error("The update could not be downloaded.");
      }
      const total = Number(r.headers["content-length"] || 0);
      const hash = crypto.createHash("sha256"),
        file = fs.createWriteStream(partial, { mode: 0o644 });
      out = file;
      let count = 0,
        last = 0;
      for await (const chunk of r.stream) {
        hash.update(chunk);
        count += chunk.length;
        if (!file.write(chunk)) await once(file, "drain");
        if (total && Date.now() - last > 1000) {
          last = Date.now();
          this.status = { ...this.status, fraction: count / total };
          this.changed();
        }
      }
      file.end();
      await once(file, "finish");
      if (hash.digest("hex") !== expected) {
        fs.rmSync(partial, { force: true });
        throw Error("The download did not match the published checksum.");
      }
      fs.renameSync(partial, dest);
      this.installer = dest;
      this.status = { ...this.status, state: "ready", fraction: 1 };
    } catch (e: any) {
      out?.destroy();
      fs.rmSync(partial, { force: true });
      this.status = {
        ...this.status,
        state: "failed",
        error: e.message || "The update could not be downloaded.",
      };
    }
    this.changed();
    return this.status;
  }
}
