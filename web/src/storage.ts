import { empty, Snapshot } from "../../desktop/src/model";

export type PreparedScope = { scope: string; state: Snapshot };
export type EncryptedRecord = {
  iv: Uint8Array;
  bytes: ArrayBuffer;
  version: string;
};
export interface BrowserStorageBackend {
  initialize(): Promise<CryptoKey>;
  entries(): Promise<[string, EncryptedRecord][]>;
  putMany(rows: [string, EncryptedRecord][]): Promise<void>;
}
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
const scopeName = (scope: string) => {
  if (
    !/^(guest|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(
      scope,
    )
  )
    throw Error("Invalid account.");
  return scope.toLowerCase();
};
export class IndexedDBStorage implements BrowserStorageBackend {
  private db!: IDBDatabase;
  private versions = new Map<string, string>();
  constructor(private name: string) {}
  async initialize() {
    this.db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(this.name, 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("keys");
        request.result.createObjectStore("records");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(Error("Close another Oxa tab to update browser storage."));
    });
    this.db.onversionchange = () => this.db.close();
    const candidate = await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    // Read and install atomically so two fresh tabs do not create different keys.
    return await new Promise<CryptoKey>((resolve, reject) => {
      const tx = this.db.transaction("keys", "readwrite"),
        store = tx.objectStore("keys"),
        request = store.get("device");
      let key: CryptoKey;
      request.onsuccess = () => {
        key = request.result || candidate;
        if (!request.result) store.put(key, "device");
      };
      tx.oncomplete = () => resolve(key);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || Error("Browser storage is unavailable."));
    });
  }
  async entries() {
    return await new Promise<[string, EncryptedRecord][]>((resolve, reject) => {
      const tx = this.db.transaction("records", "readonly"),
        rows: [string, EncryptedRecord][] = [];
      const cursor = tx.objectStore("records").openCursor();
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (row) {
          rows.push([String(row.key), row.value]);
          this.versions.set(String(row.key), row.value.version);
          row.continue();
        }
      };
      tx.oncomplete = () => resolve(rows);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || Error("Could not read browser storage."));
    });
  }
  async putMany(rows: [string, EncryptedRecord][]) {
    await new Promise<void>((resolve, reject) => {
      const tx = this.db.transaction("records", "readwrite"),
        store = tx.objectStore("records");
      let conflict = false;
      for (const [name, value] of rows) {
        const current = store.get(name);
        current.onsuccess = () => {
          if (current.result?.version !== this.versions.get(name)) {
            conflict = true;
            tx.abort();
            return;
          }
          store.put(value, name);
        };
      }
      tx.oncomplete = () => {
        for (const [name, value] of rows)
          this.versions.set(name, value.version);
        resolve();
      };
      tx.onerror = tx.onabort = () =>
        reject(
          conflict
            ? Error(
                "Another Oxa tab changed this library. Keep this tab open and reload after syncing your changes.",
              )
            : tx.error || Error("Could not save browser storage."),
        );
    });
  }
}

export class BrowserDisk {
  scope = "guest";
  state: Snapshot = empty();
  saveError?: string;
  private key!: CryptoKey;
  private cache = new Map<string, any>();
  private unreadable = new Set<string>();
  private pending = new Map<string, { revision: number; value: any }>();
  private revision = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private due = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private backend: BrowserStorageBackend;
  private loaded = false;
  constructor(
    name = "oxa-web-v1",
    private storageChanged: () => void = () => {},
    backend?: BrowserStorageBackend,
  ) {
    this.backend = backend || new IndexedDBStorage(name);
  }
  async init() {
    this.key = await this.backend.initialize();
    for (const [name, value] of await this.backend.entries()) {
      try {
        if (
          !(value?.iv instanceof Uint8Array) ||
          value.iv.length !== 12 ||
          value.bytes.byteLength > 64 * 1024 * 1024
        )
          throw Error("Invalid browser record.");
        const bytes = await crypto.subtle.decrypt(
          {
            name: "AES-GCM",
            iv: value.iv as BufferSource,
            additionalData: encoder.encode(name) as BufferSource,
          },
          this.key,
          value.bytes,
        );
        this.cache.set(name, JSON.parse(decoder.decode(bytes)));
      } catch {
        this.unreadable.add(name);
      }
    }
    const active = this.read("active-scope", "guest");
    this.scope = scopeName(active);
    this.state = this.normalize(this.read("library-" + this.scope, empty()));
    this.loaded = true;
    return this;
  }
  private normalize(value: any): Snapshot {
    if (
      !value ||
      !Array.isArray(value.sources) ||
      !Array.isArray(value.media) ||
      !Array.isArray(value.programs) ||
      !Array.isArray(value.favorites) ||
      !value.credentials ||
      typeof value.credentials !== "object" ||
      !value.progress
    )
      throw Error(
        "Your saved browser library is invalid. It has not been replaced.",
      );
    return {
      ...empty(),
      ...value,
      transfers: [],
      journal: value.journal || { cursor: 0, revisions: {}, pending: {} },
    };
  }
  read(name: string, fallback: any) {
    if (this.unreadable.has(name))
      throw Error(
        "This saved browser library is unreadable. It has not been replaced.",
      );
    return this.cache.has(name) ? this.cache.get(name) : fallback;
  }
  write(name: string, value: any) {
    if (!this.loaded) throw Error("Browser storage is not ready.");
    if (this.unreadable.has(name))
      throw Error(
        "This saved browser library is unreadable. It has not been replaced.",
      );
    const copy = structuredClone(value);
    this.cache.set(name, copy);
    this.pending.set(name, { revision: ++this.revision, value: copy });
    this.schedule(350);
  }
  private markLibrary() {
    const name = "library-" + this.scope;
    // Retain the scoped object, not a single global dirty bit. Edits made while
    // a scope switch awaits storage must still save to the outgoing account.
    this.pending.set(name, { revision: ++this.revision, value: this.state });
    this.cache.set(name, this.state);
  }
  save() {
    this.markLibrary();
    this.schedule(100);
  }
  saveSoon(delay = 1000) {
    this.markLibrary();
    this.schedule(delay);
  }
  // An earlier deadline replaces a later one.
  private schedule(delay: number) {
    const due = Date.now() + delay;
    if (this.timer && this.due <= due) return;
    clearTimeout(this.timer);
    this.due = due;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flushPending().catch(() => {});
    }, delay);
  }
  private queue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => {});
    return result;
  }
  private async encryptRows(rows: [string, any][]) {
    return await Promise.all(
      rows.map(async ([name, value]): Promise<[string, EncryptedRecord]> => {
        const bytes = encoder.encode(JSON.stringify(value));
        if (bytes.length > 64 * 1024 * 1024)
          throw Error(
            "The browser library exceeds the local storage size limit.",
          );
        const iv = crypto.getRandomValues(new Uint8Array(12));
        return [
          name,
          {
            iv,
            version: crypto.randomUUID(),
            bytes: await crypto.subtle.encrypt(
              {
                name: "AES-GCM",
                iv: iv as BufferSource,
                additionalData: encoder.encode(name) as BufferSource,
              },
              this.key,
              bytes as BufferSource,
            ),
          },
        ];
      }),
    );
  }
  private failure(error: unknown) {
    this.saveError =
      "Your latest changes could not be saved in this browser. Check available storage and retry before closing this tab.";
    this.storageChanged();
    return error;
  }
  async flushPending() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.queue(async () => {
      const pending = [...this.pending.entries()].map(
        ([name, row]) =>
          [
            name,
            { revision: row.revision, value: structuredClone(row.value) },
          ] as const,
      );
      if (!pending.length) return;
      try {
        await this.backend.putMany(
          await this.encryptRows(
            pending.map(([name, row]) => [name, row.value]),
          ),
        );
        for (const [name, row] of pending)
          if (this.pending.get(name)?.revision === row.revision)
            this.pending.delete(name);
        if (this.saveError) {
          this.saveError = undefined;
          this.storageChanged();
        }
      } catch (error) {
        throw this.failure(error);
      }
      if (this.pending.size) this.schedule(350);
    });
  }
  async prepareSwitch(scope: string): Promise<PreparedScope> {
    await this.flushPending();
    const next = scopeName(scope);
    return {
      scope: next,
      state:
        next === this.scope
          ? this.state
          : this.normalize(
              structuredClone(this.read("library-" + next, empty())),
            ),
    };
  }
  async commitSwitch(next: PreparedScope, records: Record<string, any> = {}) {
    const scope = scopeName(next.scope),
      state = this.normalize(next.state);
    await this.flushPending();
    await this.queue(async () => {
      const values: [string, any][] = [
        ["library-" + scope, state],
        ["active-scope", scope],
        ...Object.entries(records),
      ];
      const revisions = new Map(
        values.map(([name]) => [name, this.pending.get(name)?.revision]),
      );
      try {
        await this.backend.putMany(await this.encryptRows(values));
      } catch (error) {
        throw this.failure(error);
      }
      for (const [name, value] of values) {
        if (this.pending.get(name)?.revision === revisions.get(name))
          this.pending.delete(name);
        this.cache.set(name, this.pending.get(name)?.value ?? value);
      }
      this.scope = scope;
      this.state = state;
    });
  }
  async switch(scope: string) {
    await this.commitSwitch(await this.prepareSwitch(scope));
  }
}
export { BrowserDisk as Disk };
