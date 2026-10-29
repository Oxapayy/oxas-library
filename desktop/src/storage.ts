import { safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { empty, Snapshot } from "./model";
export type PreparedScope = { scope: string; state: Snapshot };
export class Disk {
  key: Buffer;
  private saveTimer?: ReturnType<typeof setTimeout>;
  private saveDue = 0;
  private pendingSave = false;
  private loaded = false;
  saveError?: string;
  scope = "guest";
  state: Snapshot = empty();
  constructor(
    public root: string,
    test = false,
    private storageChanged: () => void = () => {},
  ) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const keyFile = path.join(root, "device-key");
    if (!test && !safeStorage.isEncryptionAvailable())
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
  flushPending() {
    if (this.pendingSave) this.save();
  }
  prepareSwitch(scope: string): PreparedScope {
    if (!/^(guest|[0-9a-f-]{36})$/i.test(scope))
      throw Error("Invalid account.");
    // Finish a pending progress checkpoint before leaving its account scope.
    this.flushPending();
    const nextScope = scope.toLowerCase();
    if (this.loaded && nextScope === this.scope)
      return { scope: nextScope, state: this.state };
    const nextState = this.read("library-" + nextScope, empty());
    nextState.journal ??= { cursor: 0, revisions: {}, pending: {} };
    for (const t of nextState.transfers)
      if (t.state === "downloading" || t.state === "queued") {
        t.state = "failed";
        t.error = "Interrupted. Retry to continue.";
      }
    return { scope: nextScope, state: nextState };
  }
  commitSwitch(next: PreparedScope) {
    // Account APIs may await network requests between prepare and commit.
    // Preserve changes made to the outgoing library during that interval.
    this.flushPending();
    this.scope = next.scope;
    this.state = next.state;
    this.loaded = true;
  }
  switch(scope: string) {
    this.commitSwitch(this.prepareSwitch(scope));
  }
  save() {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.pendingSave = true;
    try {
      this.write("library-" + this.scope, this.state);
      this.pendingSave = false;
      if (this.saveError) {
        this.saveError = undefined;
        this.storageChanged();
      }
    } catch (error) {
      if (!this.saveError) {
        this.saveError =
          "Your latest changes could not be saved. Check free disk space and folder permissions, then retry. Keep the app open until saving succeeds.";
        this.storageChanged();
      }
      throw error;
    }
  }
  // Transfer bytes and playback progress are noisy. Each write re-encrypts the
  // whole library, so batch them; explicit edits, completion, scope changes
  // and quit still save now. An earlier deadline replaces a later one.
  saveSoon(delay = 1000) {
    this.pendingSave = true;
    const due = Date.now() + delay;
    if (this.saveTimer && this.saveDue <= due) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveDue = due;
    this.saveTimer = setTimeout(() => {
      try {
        this.save();
      } catch {
        /* Keep dirty state for retry; background I/O errors must not crash. */
      }
    }, delay);
    this.saveTimer.unref();
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
