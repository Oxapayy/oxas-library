import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { empty, Snapshot } from "./model";
export class Disk {
  key: Buffer;
  scope = "guest";
  state: Snapshot = empty();
  constructor(
    public root: string,
    test = false,
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const keyFile = path.join(root, "device-key");
    if (!safeStorage.isEncryptionAvailable() && !test)
      throw Error("Secure operating-system credential storage is unavailable.");
    if (fs.existsSync(keyFile))
      this.key = test
        ? fs.readFileSync(keyFile)
        : Buffer.from(
            safeStorage.decryptString(fs.readFileSync(keyFile)),
            "base64",
          );
    else {
      this.key = randomBytes(32);
      this.atomic(
        keyFile,
        test
          ? this.key
          : safeStorage.encryptString(this.key.toString("base64")),
      );
    }
    this.switch("guest");
  }
  atomic(file: string, bytes: Buffer) {
    const temp = file + ".tmp";
    fs.writeFileSync(temp, bytes, { mode: 0o600 });
    fs.renameSync(temp, file);
  }
  read(name: string, fallback: any) {
    const p = path.join(this.root, name + ".vault");
    if (!fs.existsSync(p)) return fallback;
    const b = fs.readFileSync(p);
    if (b.length > 64 * 1024 * 1024 || b.length < 28)
      throw Error("Local library storage is invalid.");
    const c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAAD(Buffer.from(name));
    c.setAuthTag(b.subarray(-16));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(12, -16)), c.final()]).toString(),
    );
  }
  write(name: string, value: any) {
    const n = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, n);
    c.setAAD(Buffer.from(name));
    const p = path.join(this.root, name + ".vault");
    this.atomic(
      p,
      Buffer.concat([
        n,
        c.update(JSON.stringify(value)),
        c.final(),
        c.getAuthTag(),
      ]),
    );
  }
  switch(scope: string) {
    if (!/^(guest|[0-9a-f-]{36})$/i.test(scope))
      throw Error("Invalid account.");
    this.scope = scope.toLowerCase();
    this.state = this.read("library-" + this.scope, empty());
    this.state.journal ??= { cursor: 0, revisions: {}, pending: {} };
    for (const t of this.state.transfers)
      if (t.state === "downloading" || t.state === "queued") {
        t.state = "failed";
        t.error = "Interrupted. Retry to continue.";
      }
  }
  save() {
    this.write("library-" + this.scope, this.state);
  }
  get mediaRoot() {
    const p = this.state.preferences.downloadDirectory
      ? path.join(
          this.state.preferences.downloadDirectory,
          "Oxa-Library-Downloads",
          this.scope,
        )
      : path.join(this.root, "downloads", this.scope);
    fs.mkdirSync(p, { recursive: true, mode: 0o700 });
    return p;
  }
}
