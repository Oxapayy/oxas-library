import fs from "node:fs";
import path from "node:path";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
// Keeps fetched artwork on disk so posters load instantly on the next launch
// instead of being downloaded again. Files are sealed with the device key like
// the library itself, because artwork reveals which titles someone has.
export class ArtworkCache {
  private size = -1;
  constructor(
    public dir: string,
    private key: Buffer,
    public limit = 300 * 1024 * 1024,
  ) {}
  private file(id: string) {
    return path.join(this.dir, createHash("sha256").update(id).digest("hex"));
  }
  get(id: string): { data: Buffer; type: string } | undefined {
    try {
      const b = fs.readFileSync(this.file(id));
      const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
      c.setAAD(Buffer.from(id));
      c.setAuthTag(b.subarray(-16));
      const plain = Buffer.concat([c.update(b.subarray(12, -16)), c.final()]);
      const split = plain.indexOf(10);
      if (split < 1) return undefined;
      return {
        type: plain.subarray(0, split).toString(),
        data: plain.subarray(split + 1),
      };
    } catch {
      return undefined;
    }
  }
  set(id: string, data: Buffer, type: string) {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      const n = randomBytes(12),
        c = createCipheriv("aes-256-gcm", this.key, n);
      c.setAAD(Buffer.from(id));
      const body = Buffer.concat([
        n,
        c.update(Buffer.concat([Buffer.from(type + "\n"), data])),
        c.final(),
        c.getAuthTag(),
      ]);
      const file = this.file(id),
        temp = file + ".tmp";
      fs.writeFileSync(temp, body, { mode: 0o600 });
      fs.renameSync(temp, file);
      if (this.size >= 0) this.size += body.length;
      if (this.size < 0 || this.size > this.limit) this.trim();
    } catch {
      /* A full or read-only disk only costs a re-download later. */
    }
  }
  // Removes the least recently written files once the cache exceeds its limit.
  trim() {
    try {
      const rows = fs
        .readdirSync(this.dir)
        .filter((name) => !name.endsWith(".tmp"))
        .map((name) => {
          const file = path.join(this.dir, name);
          const stat = fs.statSync(file);
          return { file, size: stat.size, time: stat.mtimeMs };
        })
        .sort((a, b) => a.time - b.time);
      let total = rows.reduce((sum, row) => sum + row.size, 0);
      for (const row of rows) {
        if (total <= this.limit * 0.8) break;
        fs.rmSync(row.file, { force: true });
        total -= row.size;
      }
      this.size = total;
    } catch {
      this.size = 0;
    }
  }
  clear() {
    fs.rmSync(this.dir, { recursive: true, force: true });
    this.size = 0;
  }
}
