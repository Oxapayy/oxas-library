import { test } from "node:test";
import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import {
  BrowserDisk,
  BrowserStorageBackend,
  EncryptedRecord,
} from "../src/storage";
import { BrowserCloud } from "../src/cloud";
import {
  base64,
  createVault,
  open,
  seal,
  unlockVault,
  utf8,
} from "../src/vault";
import { cloudKey, empty, media } from "../../desktop/src/model";

const owner = "a1b2c3d4-1111-4222-8333-abcdef123456";
const generation = "B1B2C3D4-1111-4222-8333-ABCDEF123456";
const source = {
  id: "C1B2C3D4-1111-4222-8333-ABCDEF123456",
  name: "Fixture",
  kind: "Library URL",
  host: "huhu.to",
  allowHTTP: false,
};
class MemoryBackend implements BrowserStorageBackend {
  key?: CryptoKey;
  rows = new Map<string, EncryptedRecord>();
  fail = false;
  writes = 0;
  async initialize() {
    return (this.key ||= await crypto.subtle.generateKey(
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    ));
  }
  async entries(): Promise<[string, EncryptedRecord][]> {
    return [...this.rows].map(([name, value]) => [
      name,
      structuredClone(value),
    ]);
  }
  async putMany(rows: [string, EncryptedRecord][]) {
    if (this.fail) throw Error("QuotaExceededError fixture");
    this.writes++;
    for (const [name, value] of rows)
      this.rows.set(name, structuredClone(value));
  }
}
async function fixture(account = true) {
  const backend = new MemoryBackend(),
    disk = await new BrowserDisk("fixture", () => {}, backend).init();
  if (account) await disk.switch(owner);
  const m = media(source, "fixture-title", "A real fixture title");
  disk.state.media = [m];
  disk.state.sources = [source];
  disk.state.credentials[source.id] = {
    endpoint: "https://huhu.to/",
    username: "fixture",
    password: "fixture-password",
    token: "",
    userID: "",
    guideURL: "",
  };
  disk.state.progress[m.id] = { seconds: 42, duration: 300, playedAt: 123 };
  disk.state.favorites = [m.id];
  disk.state.accountFormat = 2;
  disk.save();
  await disk.flushPending();
  const cloud = new BrowserCloud(
    disk,
    () => {},
    () => {},
  );
  cloud.client.auth.stopAutoRefresh();
  if (account) {
    cloud.identity = { id: owner, email: "fixture@example.invalid" };
    cloud.settings = { user_id: owner, generation };
    cloud.cache();
    await disk.flushPending();
  }
  return {
    backend,
    disk,
    cloud,
    m,
    async close() {
      clearTimeout(cloud.timer);
      cloud.client.auth?.stopAutoRefresh?.();
      backend.fail = false;
      await disk.flushPending();
    },
  };
}
const session = (id = owner, token = "fixture-owner-token") => ({
  data: { session: { user: { id }, access_token: token } },
  error: null,
});
function client(identity = owner) {
  return {
    auth: { getSession: async () => session(identity), stopAutoRefresh() {} },
    rpc: (_name: string, _args: any) => ({
      setHeader: (_header: string, _value: string) =>
        Promise.resolve({
          data: { records: [], conflicts: [], generation },
          error: null,
        }),
    }),
  };
}

test("browser legacy AES-GCM matches native nonce/cipher/tag and owner context", async () => {
  const key = new Uint8Array(32).fill(7),
    nonce = new Uint8Array(12).fill(3),
    data = utf8("Unicode fixture — Grüezi");
  const native = createCipheriv("aes-256-gcm", key, nonce);
  native.setAAD(
    Buffer.from(`OxaLibrary:v1:${owner}:source:${generation}:fixture`),
  );
  const expected = Buffer.concat([
    nonce,
    native.update(data),
    native.final(),
    native.getAuthTag(),
  ]).toString("base64");
  const actual = await seal(
    data,
    key,
    owner.toUpperCase(),
    `source:${generation}:fixture`,
    nonce,
  );
  assert.equal(actual, expected);
  assert.equal(
    new TextDecoder().decode(
      await open(actual, key, owner, `source:${generation}:fixture`),
    ),
    "Unicode fixture — Grüezi",
  );
  await assert.rejects(
    open(actual, key, source.id, `source:${generation}:fixture`),
  );
  const fresh = await createVault(
    owner,
    "a sufficiently long password",
    key,
    generation,
  );
  assert.deepEqual(
    await unlockVault(fresh.settings, "a sufficiently long password"),
    key,
  );
  await assert.rejects(unlockVault(fresh.settings, "incorrect password"));
});

test("browser persistence encrypts credentials and restores account state with a nonextractable device key", async () => {
  const f = await fixture();
  try {
    assert.equal(f.backend.key?.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", f.backend.key!));
    const record = f.backend.rows.get("library-" + owner)!;
    assert.ok(
      !new TextDecoder().decode(record.bytes).includes("fixture-password"),
    );
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, owner);
    assert.equal(
      restored.state.credentials[source.id].password,
      "fixture-password",
    );
    assert.equal(restored.state.progress[f.m.id].seconds, 42);
    assert.deepEqual(restored.state.favorites, [f.m.id]);
    assert.deepEqual(restored.state.transfers, []);
  } finally {
    await f.close();
  }
});

test("quota failure retains dirty progress and cannot partially commit guest ownership", async () => {
  const f = await fixture();
  try {
    f.disk.state.progress[f.m.id].seconds = 99;
    f.disk.saveSoon();
    f.backend.fail = true;
    await assert.rejects(f.disk.prepareSwitch("guest"), /Quota/);
    assert.equal(f.disk.scope, owner);
    assert.equal(f.disk.state.progress[f.m.id].seconds, 99);
    assert.ok(f.disk.saveError);
    f.backend.fail = false;
    const staged = await f.disk.prepareSwitch("guest");
    f.backend.fail = true;
    await assert.rejects(
      f.disk.commitSwitch(staged, { account: null, auth: {} }),
      /Quota/,
    );
    assert.equal(f.disk.scope, owner);
    assert.equal(f.disk.read("account", null).identity.id, owner);
    f.backend.fail = false;
    await f.disk.flushPending();
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, owner);
    assert.equal(restored.state.progress[f.m.id].seconds, 99);
  } finally {
    await f.close();
  }
});

test("same-account staging preserves edits made while account APIs await", async () => {
  const f = await fixture();
  try {
    const next = await f.disk.prepareSwitch(owner);
    f.disk.state.progress[f.m.id].seconds = 121;
    f.disk.saveSoon();
    await f.disk.commitSwitch(next);
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.state.progress[f.m.id].seconds, 121);
  } finally {
    await f.close();
  }
});

test("an unreadable inactive account never replaces the guest library", async () => {
  const f = await fixture(false);
  try {
    f.backend.rows.set("library-" + owner, {
      iv: new Uint8Array(12),
      bytes: new Uint8Array(40).buffer,
      version: "corrupt-fixture",
    });
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, "guest");
    assert.equal(restored.state.media[0].title, f.m.title);
    await assert.rejects(restored.prepareSwitch(owner), /unreadable/);
    assert.equal(restored.scope, "guest");
    assert.equal(restored.state.media[0].title, f.m.title);
  } finally {
    await f.close();
  }
});

test("failed signout never clears the visible account or its persisted scope", async () => {
  const f = await fixture();
  try {
    let ends = 0;
    f.cloud.client = {
      ...client(),
      auth: {
        ...client().auth,
        signOut: async () => {
          ends++;
          f.backend.fail = true;
        },
      },
    };
    const identity = f.cloud.identity;
    await assert.rejects(f.cloud.signout(), /Quota/);
    assert.equal(ends, 1);
    assert.equal(f.cloud.identity, identity);
    assert.equal(f.disk.scope, owner);
    assert.equal(f.cloud.ready, false);
    assert.equal(f.disk.state.progress[f.m.id].seconds, 42);
    assert.equal(f.disk.read("account", null).identity.id, owner);
    f.backend.fail = false;
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, owner);
  } finally {
    await f.close();
  }
});

test("mismatched SDK account sends zero sync RPCs and retains the outbox", async () => {
  const f = await fixture();
  try {
    f.cloud.progress(f.m);
    const before = structuredClone(f.disk.state.journal);
    let calls = 0;
    f.cloud.client = {
      ...client(source.id),
      rpc() {
        calls++;
        throw Error("must not construct a mismatched RPC");
      },
    };
    await f.cloud.sync();
    assert.equal(calls, 0);
    assert.deepEqual(f.disk.state.journal.pending, before.pending);
    assert.equal(f.disk.state.journal.cursor, before.cursor);
    assert.equal(f.disk.scope, owner);
    assert.equal(f.cloud.identity.id, owner);
  } finally {
    await f.close();
  }
});

test("real Supabase builder keeps verified bearer after a later SDK session swap", async () => {
  const f = await fixture();
  try {
    let reads = 0,
      authorization = "";
    const sdk = createClient("https://example.invalid", "fixture-public-key", {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (_url, init) => {
          authorization = new Headers(init?.headers).get("Authorization") || "";
          return Response.json({ records: [], conflicts: [], generation });
        },
      },
    });
    sdk.auth.getSession = async () =>
      (reads++ === 0
        ? session(owner, "verified-owner-token")
        : session(source.id, "later-other-owner-token")) as any;
    f.cloud.client = sdk;
    f.cloud.progress(f.m);
    await f.cloud.sync();
    assert.ok(
      reads >= 2,
      "both owner guard and SDK fetch wrapper read the session",
    );
    assert.equal(authorization, "Bearer verified-owner-token");
    assert.equal(f.disk.scope, owner);
    assert.deepEqual(f.disk.state.journal.pending, {});
  } finally {
    await f.close();
  }
});

test("same-account recovery keeps real persisted sources, credentials, history and watchlist", async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.disk.state),
      identity = f.cloud.identity,
      settings = f.cloud.settings;
    f.cloud.fetchSettings = async () => settings;
    f.cloud.client = {
      ...client(),
      auth: {
        ...client().auth,
        getUser: async () => ({ data: { user: identity } }),
        updateUser: async ({ password }: any) => {
          assert.equal(password, "a new valid password");
          return {};
        },
      },
    };
    f.cloud.recovery = true;
    await f.cloud.auth("reset", { password: "a new valid password" });
    for (const key of [
      "sources",
      "credentials",
      "media",
      "progress",
      "favorites",
    ])
      assert.deepEqual(f.disk.state[key], before[key]);
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, owner);
    assert.equal(restored.state.progress[f.m.id].seconds, 42);
    assert.deepEqual(restored.state.favorites, before.favorites);
    assert.equal(f.cloud.settings.generation, generation);
  } finally {
    await f.close();
  }
});

test("guest default huhu merges into a synced matching source without duplicate connections", async () => {
  const f = await fixture(false);
  try {
    const syncedSource = { ...source, id: owner.toUpperCase() },
      target = empty();
    target.sources = [syncedSource];
    target.credentials[syncedSource.id] = {
      ...f.disk.state.credentials[source.id],
      endpoint: "https://huhu.to",
    };
    target.accountFormat = 2;
    f.disk.write("library-" + owner, target);
    await f.disk.flushPending();
    f.cloud.fetchSettings = async () => ({ user_id: owner, generation });
    f.cloud.client = client();
    await f.cloud.attach(
      { id: owner, email: "fixture@example.invalid" },
      "a valid password",
      true,
    );
    assert.equal(f.disk.state.sources.length, 1);
    assert.equal(f.disk.state.sources[0].id, syncedSource.id);
    assert.equal(f.disk.state.media[0].sourceID, syncedSource.id);
    assert.equal(f.disk.state.progress[f.disk.state.media[0].id].seconds, 42);
    assert.deepEqual(f.disk.state.favorites, [f.disk.state.media[0].id]);
  } finally {
    await f.close();
  }
});

test("an immediate sign-in waits for account restoration before changing the SDK session", async () => {
  const f = await fixture();
  try {
    let enter!: () => void,
      release!: () => void,
      signs = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = f.cloud.identity,
      settings = f.cloud.settings;
    f.cloud.fetchSettings = async () => settings;
    f.cloud.client = {
      ...client(),
      auth: {
        ...client().auth,
        getUser: async () => {
          enter();
          await gate;
          return { data: { user: identity } };
        },
        signInWithPassword: async () => {
          signs++;
          return { data: { user: identity } };
        },
      },
    };
    const boot = f.cloud.boot();
    await entered;
    const signIn = f.cloud.auth("signin", {
      email: identity.email,
      password: "fixture password",
      includeGuest: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(
      signs,
      0,
      "the restoring SDK session must not be replaced mid-restore",
    );
    release();
    await boot;
    await signIn;
    assert.equal(signs, 1);
    assert.equal(f.cloud.identity.id, owner);
    assert.equal(f.disk.scope, owner);
  } finally {
    await f.close();
  }
});

test("signout during account restoration cannot be undone by a late restore reply", async () => {
  const f = await fixture();
  try {
    let enter!: () => void,
      release!: () => void,
      ends = 0;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const identity = f.cloud.identity,
      settings = f.cloud.settings;
    f.cloud.fetchSettings = async () => settings;
    f.cloud.client = {
      ...client(),
      auth: {
        ...client().auth,
        getUser: async () => {
          enter();
          await gate;
          return { data: { user: identity } };
        },
        signOut: async () => {
          ends++;
          return {};
        },
      },
    };
    const boot = f.cloud.boot();
    await entered;
    const signOut = f.cloud.signout();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(ends, 0);
    release();
    await boot;
    await signOut;
    assert.equal(ends, 1);
    assert.equal(f.disk.scope, "guest");
    assert.equal(f.cloud.identity, undefined);
    const restored = await new BrowserDisk(
      "fixture",
      () => {},
      f.backend,
    ).init();
    assert.equal(restored.scope, "guest");
    assert.equal(restored.read("account", null), null);
  } finally {
    await f.close();
  }
});
