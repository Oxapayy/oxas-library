import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { empty, media, cloudMedia, hash, ordinal } from "../src/model";
import { libraryView, mergeMedia } from "../src/library-view";
import { matches, Provider } from "../src/providers";
import { Disk } from "../src/storage";
import { Cloud } from "../src/cloud";
import http from "node:http";
import { once } from "node:events";
import { bytes, ResponseLimitError } from "../src/network";

const source = {
  id: "A1B2C3D4-1111-4222-8333-ABCDEF123456",
  name: "Owned fixture",
  kind: "Jellyfin",
  host: "localhost",
  allowHTTP: true,
};

test("provider URL globs preserve literal, case-insensitive, anchored wildcard behavior", () => {
  const cases: [string, string, boolean][] = [
    ["https://example.org/watch/1", "*/watch/*", true],
    ["https://EXAMPLE.org/watch/1", "HTTPS://example.org/*", true],
    ["https://elsewhere.org/a", "https://example.org/*", false],
    ["abc", "a*c", true],
    ["ab", "a*b", true],
    ["a", "a*a", false],
    ["a", "*a*a", false],
    ["abc", "**", true],
    ["abc", "", false],
    ["", "*", true],
    ["", "", true],
    ["https://host/a+b?(x).mp4", "*/a+b?(x).mp4", true],
    ["https://host/abx.mp4", "*/a+b?(x).mp4", false],
  ];
  for (const [url, pattern, result] of cases)
    assert.equal(matches(url, pattern), result, `${url} / ${pattern}`);
  assert.equal(matches("a".repeat(8193), "*"), false);
  assert.equal(matches("a", "*".repeat(1025)), false);
  assert.equal(matches("a", null as any), false);
});

test("adversarial nonmatching provider patterns cannot lock the main thread", () => {
  // Isolate the regression so reintroducing an exponential regex is killed,
  // rather than hanging the complete test runner on synchronous backtracking.
  const output = execFileSync(
    process.execPath,
    [
      "-e",
      `
    const matches = ${matches.toString()};
    const raw = "https://example.org/" + "a".repeat(8000) + "z";
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      if (matches(raw, "*a".repeat(500) + "b")) process.exit(2);
      if (matches(raw, "*" + "a".repeat(900) + "b*")) process.exit(3);
    }
    console.log(Math.round(performance.now() - start));
  `,
    ],
    { timeout: 3000, encoding: "utf8" },
  );
  assert.ok(
    Number(output.trim()) < 2000,
    "bounded matching under repeated adversarial patterns",
  );
});

test("catalog projection joins once, retains progress and never exposes source credentials", () => {
  const state = empty();
  state.sources.push(source);
  state.credentials[source.id] = {
    endpoint: "https://private.example/token",
    username: "private-user",
    password: "private-password",
    token: "private-token",
    userID: "",
    guideURL: "",
  };
  const m = media(source, "one", "One");
  m.stream = "https://private.example/video?token=private";
  m.poster = "https://private.example/poster?token=private";
  const synced = cloudMedia(m);
  state.media = [synced, m];
  state.progress[synced.id] = { seconds: 42, duration: 200 };
  state.favorites = [m.id];
  state.newEpisodeIDs = [m.id];
  state.transfers = [
    { id: "transfer", media: m, state: "ready", bytes: 100, fraction: 1 },
  ];
  const view = libraryView(state, () => "oxa://media/opaque-token");
  assert.equal(
    view.media().length,
    1,
    "local catalog suppresses synced duplicates",
  );
  const out = view.media()[0];
  assert.equal(out.id, hash(m.id));
  assert.equal(
    out.progress.seconds,
    42,
    "synced progress survives source refresh",
  );
  assert.equal(out.favorite, true);
  assert.equal(out.download, true);
  assert.equal(out.newEpisode, true);
  assert.doesNotMatch(JSON.stringify(out), /private|stream|providerID/);
  assert.deepEqual(
    view.status(new Set([m.id])).map((m) => m.id),
    [hash(m.id)],
  );
  state.progress[m.id] = { seconds: 70, duration: 200 };
  assert.equal(
    view.wire(m).progress.seconds,
    70,
    "direct progress takes precedence",
  );
});

test("large catalog and guide projection are linear in catalog size", () => {
  const state = empty();
  let identityReads = 0,
    channelReads = 0;
  for (let i = 0; i < 10000; i++) {
    const row = media(
      source,
      String(i),
      `Title ${i}`,
      i < 1000 ? "channel" : "episode",
    );
    Object.defineProperty(row, "providerID", {
      get: () => {
        identityReads++;
        return String(i);
      },
    });
    Object.defineProperty(row, "channelID", {
      get: () => {
        channelReads++;
        return i < 1000 ? `channel-${i}` : undefined;
      },
    });
    state.media.push(row);
  }
  for (let i = 0; i < 30000; i++)
    state.programs.push({
      id: `program-${i}`,
      sourceID: source.id,
      channelID: `channel-${i % 1000}`,
      title: `Programme ${i}`,
      start: i,
      end: i + 60,
    });
  const view = libraryView(state, () => undefined);
  assert.equal(view.media().length, 10000);
  assert.equal(view.programs().length, 30000);
  assert.equal(
    identityReads,
    10000,
    "one identity computation per row, not per row pair",
  );
  assert.ok(
    channelReads <= 22000,
    "guide joins do not rescan channel IDs per programme",
  );
  assert.equal(view.programs()[29999].mediaID, hash(state.media[999].id));
});

test("catalog merge preserves fields and metadata while resolving duplicate rows", () => {
  const state = empty();
  state.media = [media(source, "one", "Old"), media(source, "two", "Two")];
  state.media[0].poster = "old poster";
  state.metadata = { [state.media[0].id]: { title: "Custom title" } };
  mergeMedia(state, [
    media(source, "one", "Server title"),
    media(source, "three", "Three"),
    { ...media(source, "three", "Latest"), year: 2026 },
  ]);
  assert.equal(state.media.length, 3);
  assert.equal(state.media[0].title, "Custom title");
  assert.equal(state.media[0].poster, "old poster");
  assert.equal(state.media[2].title, "Latest");
  assert.equal(state.media[2].year, 2026);
});

test("provider ordinals reject delegated-action markup before it reaches episode controls", async () => {
  const attack =
    '\"><button data-action="account" data-args=\'{"action":"reset","password":"attacker"}\'>Injected</button><option value="';
  for (const value of [
    attack,
    {},
    [],
    NaN,
    Infinity,
    -1,
    1.5,
    100001,
    "1e3",
    "",
    "1.5",
  ])
    assert.equal(ordinal(value), undefined);
  assert.equal(ordinal("12"), 12);
  assert.equal(ordinal(0), 0);
  const provider = new Provider(source, {
    endpoint: "https://example.org",
    username: "",
    password: "",
    token: "",
    userID: "",
    guideURL: "",
  });
  const addon = {
    id: "fixture",
    baseURL: "https://example.org",
    resources: ["item"],
    catalogs: [],
  };
  const row = provider.mhItem(
    {
      id: "show",
      type: "series",
      name: "A Series",
      episode: attack,
      season: attack,
    },
    addon,
  );
  assert.equal(row.season, undefined);
  assert.equal(row.episode, undefined);
  assert.equal(
    provider.jelly({
      Id: "one",
      ParentIndexNumber: attack,
      IndexNumber: attack,
    }).season,
    undefined,
  );
  assert.equal(
    provider.plex({ ratingKey: "one", parentIndex: attack, index: attack })
      .episode,
    undefined,
  );
  const show = provider.mhItem(
    { id: "show", type: "series", name: "A Series" },
    addon,
  );
  provider.discover = async () => ({ addons: [addon] });
  provider.mh = async () => ({
    id: "show",
    name: "A Series",
    type: "series",
    catalogs: [
      { id: "bad", season: attack },
      { id: "valid", season: "2" },
    ],
  });
  const detail = await provider.detail(show);
  assert.deepEqual(
    detail.media.websiteItem.seasons.map((s: any) => s.number),
    [2],
  );
  // Previously cached provider values are also sanitized at the IPC boundary.
  const state = empty();
  state.media = [{ ...show, season: attack, episode: attack }];
  const output = libraryView(state, () => undefined).media()[0];
  assert.equal(output.season, undefined);
  assert.equal(output.episode, undefined);
});

test("progress checkpoints coalesce and flush before account switches", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-checkpoints-"));
  const disk = new Disk(root, true);
  let writes = 0;
  const atomic = disk.atomic.bind(disk);
  disk.atomic = (...args) => {
    writes++;
    atomic(...args);
  };
  try {
    for (let i = 0; i < 100; i++) {
      disk.state.progress.one = { seconds: i };
      disk.saveSoon();
    }
    assert.equal(
      writes,
      0,
      "progress callbacks do not write an encrypted catalog per tick",
    );
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(writes, 1, "one timer checkpoints the latest state");
    assert.equal(disk.read("library-guest", {}).progress.one.seconds, 99);
    disk.state.progress.one.seconds = 120;
    disk.saveSoon();
    disk.switch(source.id);
    assert.equal(
      writes,
      2,
      "switch checkpoints the outgoing account immediately",
    );
    assert.equal(disk.read("library-guest", {}).progress.one.seconds, 120);
    assert.deepEqual(disk.state.progress, {});
  } finally {
    disk.save();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("failed background checkpoints stay recoverable and cannot discard a scope", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-save-error-"));
  let notices = 0;
  const disk = new Disk(root, true, () => notices++);
  const atomic = disk.atomic.bind(disk);
  try {
    disk.state.progress.one = { seconds: 42 };
    disk.atomic = () => {
      throw Object.assign(Error("fixture disk full"), { code: "ENOSPC" });
    };
    disk.saveSoon();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.match(disk.saveError, /could not be saved/);
    assert.equal(notices, 1);
    assert.equal(disk.scope, "guest");
    assert.equal(disk.state.progress.one.seconds, 42);
    assert.throws(() => disk.switch(source.id), /fixture disk full/);
    assert.equal(
      disk.scope,
      "guest",
      "failed flush keeps the current in-memory scope",
    );
    disk.atomic = atomic;
    disk.save();
    assert.equal(disk.saveError, undefined);
    assert.equal(notices, 2);
    assert.equal(disk.read("library-guest", {}).progress.one.seconds, 42);
  } finally {
    disk.atomic = atomic;
    disk.save();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("metadata has a shared response budget while video downloads stay independent", async () => {
  const server = http.createServer((_req, res) => res.end("1234"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const budget = { remaining: 6 };
    await bytes(base, { source, budget });
    assert.equal(budget.remaining, 2);
    await assert.rejects(bytes(base, { source, budget }), ResponseLimitError);
    const provider = new Provider(source, {
      endpoint: base,
      username: "",
      password: "",
      token: "",
      userID: "",
      guideURL: "",
    });
    assert.equal(provider.opts().limit, 8 * 1024 * 1024);
    assert.equal(provider.opts().budget.remaining, 64 * 1024 * 1024);
    assert.equal(
      provider.opts().budget,
      provider.opts().budget,
      "pages and followed series share one import budget",
    );
    provider.opts().budget.remaining = 0;
    assert.equal(provider.opts({ media: true }).budget, undefined);
    assert.equal(
      (await bytes(base, provider.opts({ media: true }))).data.length,
      4,
    );
    provider.authenticate = async () => {};
    provider.j = async () => ({
      Items: Array(100001).fill({ Id: "one", Name: "Item" }),
      TotalRecordCount: 100001,
    });
    await assert.rejects(
      provider.catalog(),
      ResponseLimitError,
      "oversized catalogs fail before mapping or publication",
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

function diskCloud() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-account-lifecycle-"));
  const disk = new Disk(root, true);
  disk.switch(source.id);
  const m = media(source, "private-title", "Owned private title");
  disk.state.media = [m];
  disk.state.progress[m.id] = { seconds: 42, duration: 200, playedAt: 1 };
  disk.state.favorites = [m.id];
  disk.state.accountFormat = 2;
  disk.save();
  let switched = 0;
  const cloud = new Cloud(
    disk,
    () => switched++,
    () => {},
  );
  cloud.client.auth.stopAutoRefresh();
  cloud.identity = { id: source.id.toLowerCase(), email: "owner@example.org" };
  cloud.settings = { generation: "B1B2C3D4-1111-4222-8333-ABCDEF123456" };
  cloud.key = Buffer.alloc(32, 7);
  cloud.cache();
  const atomic = disk.atomic.bind(disk);
  return {
    root,
    disk,
    cloud,
    m,
    atomic,
    switched: () => switched,
    cleanup() {
      clearTimeout(cloud.timer);
      cloud.client.auth?.stopAutoRefresh?.();
      disk.atomic = atomic;
      disk.save();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

test("signout flushes pending progress before auth or identity changes", async () => {
  const f = diskCloud();
  let revoked = 0;
  f.cloud.client = {
    auth: {
      signOut: async () => {
        revoked++;
      },
      stopAutoRefresh: () => {},
    },
  };
  const identity = f.cloud.identity,
    settings = f.cloud.settings;
  try {
    f.disk.state.progress[f.m.id].seconds = 75;
    f.disk.saveSoon();
    f.disk.atomic = (file, data) => {
      if (path.basename(file).startsWith("library-"))
        throw Error("ENOSPC fixture");
      f.atomic(file, data);
    };
    await assert.rejects(f.cloud.signout(), /ENOSPC/);
    assert.equal(revoked, 0, "preflight fails before auth signout");
    assert.equal(f.cloud.identity, identity);
    assert.equal(f.cloud.settings, settings);
    assert.equal(f.disk.scope, source.id.toLowerCase());
    assert.equal(f.disk.state.progress[f.m.id].seconds, 75);
    assert.equal(f.switched(), 0);
    assert.equal(f.disk.read("account", {}).identity.id, identity.id);
    await assert.rejects(f.cloud.attach(identity, "password"), /ENOSPC/);
    assert.equal(f.cloud.identity, identity);
    assert.equal(f.disk.scope, identity.id);
    assert.equal(f.cloud.settings, settings);
  } finally {
    f.cleanup();
  }
});

test("signout also preserves account ownership when an in-flight edit cannot flush", async () => {
  const f = diskCloud();
  let release: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  f.cloud.client = {
    auth: { signOut: () => pending, stopAutoRefresh: () => {} },
  };
  const identity = f.cloud.identity;
  try {
    const result = f.cloud.signout();
    f.disk.state.progress[f.m.id].seconds = 90;
    f.disk.saveSoon();
    f.disk.atomic = (file, data) => {
      if (path.basename(file).startsWith("library-"))
        throw Error("ENOSPC during logout");
      f.atomic(file, data);
    };
    release();
    await assert.rejects(result, /ENOSPC/);
    assert.equal(f.cloud.identity, identity);
    assert.equal(f.disk.scope, identity.id);
    assert.equal(f.disk.state.progress[f.m.id].seconds, 90);
    assert.equal(
      f.cloud.ready,
      false,
      "sync stays paused after interrupted auth transition",
    );
    assert.equal(f.switched(), 0);
  } finally {
    f.cleanup();
  }
});

test("corrupt target account cannot commit identity, keys or scope", async () => {
  const f = diskCloud();
  const other = "C1B2C3D4-1111-4222-8333-ABCDEF123456".toLowerCase();
  const identity = f.cloud.identity,
    settings = f.cloud.settings,
    key = f.cloud.key;
  let fetched = false,
    rpc = false;
  f.cloud.fetchSettings = async () => {
    fetched = true;
    return settings;
  };
  f.cloud.client = {
    auth: { stopAutoRefresh: () => {} },
    rpc: async () => {
      rpc = true;
    },
  };
  try {
    fs.writeFileSync(
      path.join(f.root, `library-${other}.vault`),
      "corrupt fixture",
    );
    await assert.rejects(
      f.cloud.attach({ id: other, email: "other@example.org" }, "password"),
      /storage is invalid/,
    );
    assert.equal(f.cloud.identity, identity);
    assert.equal(f.cloud.settings, settings);
    assert.equal(f.cloud.key, key);
    assert.equal(f.disk.scope, identity.id);
    assert.equal(f.disk.state.media[0].id, f.m.id);
    assert.equal(
      fetched,
      false,
      "invalid target is rejected before account setup",
    );
    assert.equal(f.cloud.ready, false);
    f.cloud.progress(f.m);
    await f.cloud.sync();
    assert.equal(rpc, false);
    assert.deepEqual(f.disk.state.journal.pending, {});
    assert.equal(f.switched(), 0);
    f.disk.write("account", {
      identity: { id: other, email: "other@example.org" },
      settings,
    });
    await f.cloud.boot();
    assert.equal(
      f.cloud.identity,
      identity,
      "boot also stages a cached account before assigning identity",
    );
    assert.equal(f.disk.scope, identity.id);
  } finally {
    f.cleanup();
  }
});

test("ready, queue and sync refuse a mismatched account scope", async () => {
  const f = diskCloud();
  let rpc = false;
  f.cloud.client = {
    auth: { stopAutoRefresh: () => {} },
    rpc: async () => {
      rpc = true;
    },
  };
  try {
    f.disk.switch("guest");
    assert.equal(f.cloud.ready, false);
    f.cloud.progress(f.m);
    await f.cloud.sync();
    assert.equal(rpc, false);
    assert.deepEqual(f.disk.state.journal.pending, {});
  } finally {
    f.cleanup();
  }
});

test("same-account password recovery preserves the real on-disk library", async () => {
  const f = diskCloud();
  const identity = f.cloud.identity,
    settings = f.cloud.settings;
  const before = structuredClone(f.disk.state);
  f.cloud.fetchSettings = async () => settings;
  f.cloud.client = {
    auth: {
      stopAutoRefresh: () => {},
      getUser: async () => ({ data: { user: identity } }),
      updateUser: async () => ({}),
    },
    rpc: async () => ({
      data: { records: [], conflicts: [], generation: settings.generation },
    }),
  };
  try {
    f.cloud.recovery = true;
    await f.cloud.auth("reset", { password: "a new valid password" });
    assert.equal(f.disk.scope, identity.id);
    assert.equal(f.cloud.identity.id, identity.id);
    assert.equal(f.cloud.ready, true);
    for (const key of [
      "sources",
      "credentials",
      "media",
      "progress",
      "favorites",
    ])
      assert.deepEqual(f.disk.state[key], before[key]);
    assert.deepEqual(
      f.disk.read("library-" + identity.id, {}).progress,
      before.progress,
    );
  } finally {
    f.cleanup();
  }
});
