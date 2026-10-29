import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { createClient } from "@supabase/supabase-js";
import { createVault, unlockVault, seal, open } from "../src/crypto";
import {
  publicIP,
  urlCheck,
  bytes,
  request,
  cleanHeaders,
} from "../src/network";
import {
  media,
  cloudMedia,
  cloudKey,
  nextEpisode,
  nextThreshold,
  empty,
  cloudInput,
  episodeChanges,
} from "../src/model";
import { m3u, guide, Provider } from "../src/providers";
import { MediaTransport, sourceIsPublic, toVTT } from "../src/media-transport";
import { Downloads } from "../src/downloads";
import { Cloud } from "../src/cloud";
const owner = "A1B2C3D4-1111-4222-8333-ABCDEF123456";
const source = {
  id: owner,
  name: "Test Library",
  kind: "Video URL",
  host: "127.0.0.1",
  allowHTTP: true,
  allowInsecureStreams: false,
};
const credentials = (endpoint: string) => ({
  endpoint,
  username: "fixture",
  password: "fixture-password",
  token: "",
  userID: "",
  guideURL: "",
});
async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  return {
    base,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
test("vault rewrapping, owner/context binding, bounds and tamper rejection", async () => {
  const first = await createVault(owner, "a sufficiently long password");
  assert.deepEqual(
    await unlockVault(first.settings, "a sufficiently long password"),
    first.key,
  );
  await assert.rejects(unlockVault(first.settings, "the wrong password"));
  const second = await createVault(
    owner,
    "a new sufficiently long password",
    first.key,
    first.settings.generation,
  );
  assert.deepEqual(
    await unlockVault(second.settings, "a new sufficiently long password"),
    first.key,
  );
  const sealed = seal(
    Buffer.from("private connection"),
    first.key,
    owner,
    "source:1",
  );
  assert.equal(
    open(sealed, first.key, owner.toLowerCase(), "source:1").toString(),
    "private connection",
  );
  assert.throws(() =>
    open(sealed, first.key, "22222222-1111-4222-8333-abcdef123456", "source:1"),
  );
  assert.throws(() => open(sealed, first.key, owner, "source:2"));
  const modified = Buffer.from(sealed, "base64");
  modified[15] ^= 1;
  assert.throws(() =>
    open(modified.toString("base64"), first.key, owner, "source:1"),
  );
  await assert.rejects(
    unlockVault(
      { ...first.settings, iterations: 1 },
      "a sufficiently long password",
    ),
  );
});
test("cloud metadata is Swift-decodable and strips credential-bearing identifiers", () => {
  const m = media(
    source,
    "https://example.org/video?password=private",
    "Title",
  );
  m.stream = "https://example.org/private";
  m.poster = m.stream;
  m.subtitleURL = m.stream;
  m.playbackHeaders = { Authorization: "secret" };
  const out = cloudMedia(m);
  assert.equal(out.subtitleDelay, 0);
  assert.equal(out.cloudIdentity, cloudKey(m));
  assert.match(out.providerID, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(out).includes("password=private"));
  assert.ok(
    !out.stream && !out.poster && !out.subtitleURL && !out.playbackHeaders,
  );
  assert.equal(cloudKey(out), cloudKey(m));
});
test("public network policy rejects private, mapped and reserved destinations", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "192.168.1.1",
    "100.64.1.2",
    "203.0.113.5",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "fd00::1",
    "2001:db8::1",
    "2002:7f00:1::",
  ])
    assert.equal(publicIP(ip), false, ip);
  for (const ip of [
    "1.1.1.1",
    "8.8.8.8",
    "192.5.5.241",
    "2606:4700:4700::1111",
  ])
    assert.equal(publicIP(ip), true, ip);
  assert.throws(() => urlCheck("https://user:secret@example.com"));
  assert.throws(() => urlCheck("http://example.com"));
  assert.throws(() => urlCheck("http://example.com", { allowHTTP: true }));
  assert.equal(urlCheck("http://127.0.0.1", source).hostname, "127.0.0.1");
  assert.equal(sourceIsPublic({ ...source, host: "library.example" }), true);
  assert.equal(sourceIsPublic(source), false);
});
test("bounded transport and cross-origin redirect do not leak authorization", async () => {
  let received: any;
  const target = await serve((req, res) => {
    received = req.headers;
    res.end("ok");
  });
  const start = await serve((_req, res) => {
    res.writeHead(302, { Location: target.base });
    res.end();
  });
  try {
    const r = await bytes(start.base, {
      source,
      headers: {
        Authorization: "secret",
        "X-Plex-Token": "private",
        Cookie: "forbidden",
      },
    });
    assert.equal(r.data.toString(), "ok");
    assert.ok(
      !received.authorization && !received["x-plex-token"] && !received.cookie,
    );
    await assert.rejects(bytes(target.base, { source, limit: 1 }));
    await assert.rejects(request(target.base, { source, publicOnly: true }));
    assert.deepEqual(
      cleanHeaders({
        Cookie: "private",
        Authorization: "secret",
        Accept: "text/plain",
      }),
      { Accept: "text/plain" },
    );
  } finally {
    await start.close();
    await target.close();
  }
});
test("M3U, XMLTV and episode ordering retain stable source identities", () => {
  const rows = m3u(
    '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",My Channel\n/live.m3u8\n',
    source,
    "https://example.org/list.m3u",
  );
  assert.equal(rows[0].stream, "https://example.org/live.m3u8");
  assert.equal(rows[0].channelID, "one");
  const programs = guide(
    '<tv><programme start="20261026200000 +0100" stop="20261026210000 +0100" channel="one"><title>Tonight</title></programme></tv>',
    source,
  );
  assert.equal(programs[0].end - programs[0].start, 3600);
  assert.throws(() =>
    guide('<!DOCTYPE tv [<!ENTITY x "unsafe">]><tv/>', source),
  );
  assert.throws(() => m3u("<html/>", source, "https://example.org"));
  const e1 = {
      ...media(source, "e1", "Pilot", "episode"),
      seriesID: "series",
      season: 1,
      episode: 1,
    },
    e2 = { ...e1, id: "e2", episode: 2 },
    e3 = { ...e1, id: "e3", season: 2, episode: 1 };
  assert.equal(nextEpisode([e3, e2, e1], e1)?.id, "e2");
  assert.equal(nextEpisode([e3, e2, e1], e2)?.id, "e3");
  assert.equal(nextThreshold(2400), 2370);
  assert.equal(nextThreshold(2400, 2300), 2300);
});
test("custom media transport enforces registered files and range requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-media-"));
  fs.writeFileSync(path.join(root, "video.mp4"), "0123456789");
  fs.writeFileSync(
    path.join(root, "captions.vtt"),
    toVTT("1\n00:00:01,000 --> 00:00:02,000\nHello"),
  );
  const transport = new MediaTransport();
  try {
    const url = transport.file(root, "video.mp4"),
      r = await transport.handle(
        new Request(url, { headers: { Range: "bytes=3-6" } }),
      );
    assert.equal(r.status, 206);
    assert.equal(await r.text(), "3456");
    assert.equal(
      (
        await transport.handle(
          new Request(url, { headers: { Range: "bytes=100-" } }),
        )
      ).status,
      416,
    );
    assert.equal(
      (await transport.handle(new Request("oxa://media/unregistered"))).status,
      404,
    );
    fs.symlinkSync(
      path.join(root, "../"),
      path.join(root, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    assert.notEqual(
      (
        await transport.handle(
          new Request(transport.file(root, "escape/nonexistent")),
        )
      ).status,
      200,
    );
    transport.forget();
    assert.equal((await transport.handle(new Request(url))).status, 404);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("file download resumes partial files and rejects HTML as media", async () => {
  const raw = Buffer.from("fixture video contents");
  let range = "";
  const fixture = await serve((req, res) => {
    if (req.url === "/bad") {
      res.setHeader("Content-Type", "text/html");
      res.end("<html>Not video</html>");
      return;
    }
    range = String(req.headers.range || "");
    const n = Number(range.match(/bytes=(\d+)-/)?.[1] || 0);
    res.writeHead(n ? 206 : 200, {
      "Content-Length": raw.length - n,
      "Content-Type": "video/mp4",
    });
    res.end(raw.subarray(n));
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-download-")),
    dest = path.join(root, "video.mp4");
  const manager = new Downloads(
    {} as any,
    () => null,
    () => {},
  );
  try {
    fs.writeFileSync(dest + ".part", raw.subarray(0, 5));
    const count = await manager.file(
      fixture.base,
      dest,
      { source },
      new AbortController().signal,
      () => {},
    );
    assert.equal(range, "bytes=5-");
    assert.equal(count, raw.length);
    assert.deepEqual(fs.readFileSync(dest), raw);
    await assert.rejects(
      manager.file(
        fixture.base + "/bad",
        dest + "bad",
        { source },
        new AbortController().signal,
        () => {},
      ),
    );
    assert.ok(!fs.existsSync(dest + "bad"));
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("large artwork catalogs and segment churn do not evict playback roots", async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "oxa-transport-retention-"),
  );
  fs.writeFileSync(path.join(root, "video.mp4"), "0123456789");
  const fixture = await serve((_req, res) => {
    res.setHeader("Content-Type", "image/png");
    res.end("owned image");
  });
  const transport = new MediaTransport();
  try {
    const playback = transport.file(root, "video.mp4");
    const firstArtwork = transport.artwork(fixture.base + "/poster-0", source);
    for (let i = 1; i <= 20001; i++)
      transport.artwork(fixture.base + `/poster-${i}`, source);
    assert.equal(
      (await transport.handle(new Request(firstArtwork))).status,
      200,
    );
    assert.equal(
      await (await transport.handle(new Request(playback))).text(),
      "0123456789",
    );
    const oldChild = transport.file(root, "video.mp4", true);
    let lastChild = "";
    for (let i = 0; i < 20001; i++)
      lastChild = transport.file(root, "video.mp4", true);
    assert.equal(
      (await transport.handle(new Request(oldChild))).status,
      404,
      "bounded segment cache evicts old segments only",
    );
    assert.equal((await transport.handle(new Request(lastChild))).status, 200);
    assert.equal(
      (await transport.handle(new Request(playback))).status,
      200,
      "active root survives segment churn",
    );
    transport.closePlayback();
    assert.equal((await transport.handle(new Request(playback))).status, 404);
    assert.equal(
      (await transport.handle(new Request(firstArtwork))).status,
      200,
      "closing video keeps catalog artwork valid",
    );
    transport.forget();
    assert.equal(
      (await transport.handle(new Request(firstArtwork))).status,
      404,
      "account scope change forgets every capability",
    );
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("HLS VOD download rewrites extensionless playlists and rejects live streams", async () => {
  let mode = "vod";
  const fixture = await serve((req, res) => {
    if (req.url === "/master") {
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\n/variant\n");
    } else if (req.url === "/variant")
      res.end(
        "#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n/segment.ts\n" +
          (mode === "vod" ? "#EXT-X-ENDLIST\n" : ""),
      );
    else res.end("segment data");
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-hls-")),
    snapshot = empty();
  let saves = 0;
  const disk: any = {
    state: snapshot,
    scope: "guest",
    mediaRoot: root,
    save: () => saves++,
  };
  const manager = new Downloads(
    disk,
    () =>
      ({
        source,
        opts: (extra: any) => ({ source, ...extra }),
        playback: async (m: any) => ({
          media: m,
          url: fixture.base + "/master",
          headers: {},
          format: "hls",
        }),
      }) as any,
    () => {},
  );
  try {
    snapshot.transfers.push({
      id: "vod",
      state: "queued",
      media: media(source, "vod", "VOD"),
    });
    await manager.pump();
    assert.equal(snapshot.transfers[0].state, "ready");
    const folder = fs.readdirSync(root)[0],
      manifest = fs.readFileSync(path.join(root, folder, "index.m3u8"), "utf8");
    assert.match(manifest, /asset-\d+\.m3u8/);
    mode = "live";
    snapshot.transfers.push({
      id: "live",
      state: "queued",
      media: media(source, "live", "Live"),
    });
    await manager.pump();
    assert.equal(snapshot.transfers[1].state, "failed");
    assert.ok(saves > 0);
  } finally {
    await fixture.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("Swift golden vectors decrypt and desktop payloads are ready for the Swift decoder", async () => {
  const fixture = JSON.parse(
      fs.readFileSync("tests/fixtures/swift.json", "utf8"),
    ),
    key = Buffer.from(fixture.key, "base64");
  assert.deepEqual(await unlockVault(fixture.settings, fixture.password), key);
  const source = JSON.parse(
    open(
      fixture.encryptedSource,
      key,
      fixture.owner,
      fixture.sourcePurpose,
    ).toString(),
  );
  assert.equal(source.credentials.username, "fixture");
  const fresh = await createVault(
    fixture.owner,
    fixture.password,
    key,
    fixture.settings.generation,
  );
  const m = cloudMedia(media(source.source, "film", "Fixture Film"));
  const output = {
    settings: fresh.settings,
    encryptedSource: seal(
      Buffer.from(JSON.stringify(source)),
      key,
      fixture.owner,
      fixture.sourcePurpose,
    ),
    watch: {
      media: m,
      progress: {
        seconds: 12.5,
        duration: 24,
        completed: false,
        playedAt: 123456789,
      },
    },
  };
  fs.mkdirSync("test-results", { recursive: true });
  fs.writeFileSync("test-results/desktop-interop.json", JSON.stringify(output));
});
function fakeCloud() {
  const vault: any = {};
  const disk: any = {
    state: empty(),
    scope: owner.toLowerCase(),
    read: (k: string, f: any) => vault[k] ?? f,
    write: (k: string, v: any) => (vault[k] = v),
    save: () => {},
    flushPending: () => {},
    prepareSwitch(scope: string) {
      return {
        scope: scope.toLowerCase(),
        state:
          scope.toLowerCase() === this.scope.toLowerCase()
            ? this.state
            : empty(),
      };
    },
    commitSwitch(staged: any) {
      this.scope = staged.scope;
      this.state = staged.state;
    },
    switch(scope: string) {
      this.scope = scope;
      this.state = empty();
    },
  };
  const c = new Cloud(
    disk,
    () => {},
    () => {},
  );
  c.client.auth.stopAutoRefresh();
  c.identity = { id: owner.toLowerCase(), email: "fixture@example.org" };
  c.key = Buffer.alloc(32);
  c.settings = { generation: "B1B2C3D4-1111-4222-8333-ABCDEF123456" };
  return { c, disk, vault };
}
const syncSession = (id = owner) => ({
  data: { session: { user: { id }, access_token: "fixture-sync-token" } },
  error: null,
});
const syncRPC =
  (handler: (name: string, args: any) => any) => (name: string, args: any) => ({
    setHeader(header: string, value: string) {
      assert.equal(header, "Authorization");
      assert.equal(value, "Bearer fixture-sync-token");
      return handler(name, args);
    },
  });
test("offline sign-out clears persisted sessions and rejects late writes from the old client", async () => {
  const { c, disk, vault } = fakeCloud(),
    oldStorage = c.client.auth.storage;
  vault.auth = { "example-session": "private refresh token" };
  c.client = {
    auth: {
      signOut: async () => {
        throw Error("offline");
      },
      stopAutoRefresh: () => {},
    },
  };
  await c.signout();
  assert.equal(c.identity, undefined);
  assert.equal(disk.scope, "guest");
  assert.deepEqual(vault.auth, {});
  await oldStorage.setItem("late-session", "old credentials");
  assert.deepEqual(vault.auth, {});
  const { data } = await c.client.auth.getSession();
  assert.equal(data.session, null);
  await c.client.auth.stopAutoRefresh();
});
test("synced metadata strips private paths and validates numeric progress", () => {
  const m = media(source, "id", "Title"),
    raw = {
      ...cloudMedia(m),
      stream: "https://private.example/token",
      poster: "https://private.example/art",
      duration: "<invalid>",
    };
  const parsed = cloudInput(raw);
  assert.equal(parsed.duration, 0);
  assert.ok(!parsed.stream && !parsed.poster);
  assert.throws(() => cloudInput({ ...raw, sourceID: "not-an-owner" }));
  assert.throws(() => cloudInput({ ...raw, kind: "<script>" }));
});
test("vault reset drops stale encrypted source edits before syncing the new generation", async () => {
  const { c, disk } = fakeCloud();
  disk.state.journal.generation = "OLD";
  disk.state.journal.cursor = 42;
  disk.state.journal.pending["source:old"] = {
    kind: "source",
    key: "old",
    payload: { value: "stale" },
    mutationID: "old",
  };
  c.client = {
    auth: { getSession: async () => syncSession() },
    rpc: syncRPC(async (_name: string, args: any) => {
      assert.equal(args.after_revision, 0);
      assert.equal(args.changes.length, 0);
      return {
        data: { generation: c.settings.generation, conflicts: [], records: [] },
      };
    }),
  };
  await c.sync();
  assert.deepEqual(disk.state.journal.pending, {});
  assert.equal(
    disk.state.journal.generation,
    c.settings.generation.toUpperCase(),
  );
});
test("sync preserves a newer edit made during a request and advances revisions", async () => {
  const { c, disk } = fakeCloud(),
    m = media(source, "movie", "Film"),
    key = cloudKey(m),
    id = "progress:" + key;
  disk.state.media = [m];
  disk.state.progress[m.id] = {
    seconds: 10,
    duration: 100,
    completed: false,
    playedAt: 1,
  };
  const payload = (n: number) => ({
    value: Buffer.from(
      JSON.stringify({
        media: cloudMedia(m),
        progress: { seconds: n, duration: 100, completed: false, playedAt: 1 },
      }),
    ).toString("base64"),
  });
  disk.state.journal.pending[id] = {
    kind: "progress",
    key,
    payload: payload(10),
    deleted: false,
    base_revision: 0,
    mutationID: "first",
  };
  let count = 0;
  c.client = {
    auth: { getSession: async () => syncSession() },
    rpc: syncRPC(async (_name: string, params: any) => {
      count++;
      if (count === 1) {
        disk.state.progress[m.id].seconds = 25;
        disk.state.journal.pending[id] = {
          ...disk.state.journal.pending[id],
          payload: payload(25),
          mutationID: "second",
        };
      } else {
        assert.equal(params.changes[0].base_revision, 7);
        assert.equal(
          JSON.parse(
            Buffer.from(params.changes[0].payload.value, "base64").toString(),
          ).progress.seconds,
          25,
        );
      }
      return {
        data: {
          generation: c.settings.generation,
          conflicts: [],
          records: [
            {
              kind: "progress",
              key,
              payload: payload(count === 1 ? 10 : 25),
              deleted: false,
              revision: count === 1 ? 7 : 8,
            },
          ],
        },
      };
    }),
  };
  await c.sync();
  assert.equal(count, 2);
  assert.equal(disk.state.progress[m.id].seconds, 25);
  assert.equal(disk.state.journal.cursor, 8);
  assert.deepEqual(disk.state.journal.pending, {});
});
test("stale account request cannot apply records to another account", async () => {
  const { c, disk } = fakeCloud();
  c.client = {
    auth: { getSession: async () => syncSession() },
    rpc: syncRPC(async () => {
      c.epoch++;
      disk.scope = "22222222-1111-4222-8333-abcdef123456";
      disk.state = empty();
      return {
        data: {
          generation: c.settings.generation,
          conflicts: [],
          records: [
            {
              kind: "source",
              key: owner,
              payload: { value: "invalid" },
              revision: 1,
            },
          ],
        },
      };
    }),
  };
  await c.sync();
  assert.equal(disk.state.sources.length, 0);
  assert.equal(disk.state.journal.cursor, 0);
});
test("sync refuses an SDK session belonging to another account before sending changes", async () => {
  const { c, disk } = fakeCloud();
  const pending = {
    kind: "preferences",
    key: "playback",
    payload: { value: "private queued account change" },
    mutationID: "queued",
  };
  disk.state.journal.pending["preferences:playback"] = pending;
  let sessionReads = 0,
    requests = 0;
  c.client = {
    auth: {
      getSession: async () => {
        sessionReads++;
        return syncSession("22222222-1111-4222-8333-abcdef123456");
      },
    },
    rpc: () => {
      requests++;
      throw Error("A mismatched SDK session must never reach RPC construction");
    },
  };
  await c.sync();
  assert.equal(sessionReads, 1);
  assert.equal(requests, 0);
  assert.equal(disk.state.journal.pending["preferences:playback"], pending);
  assert.equal(disk.state.journal.cursor, 0);
  assert.equal(c.lastSync, undefined);
});
test("sync rechecks epoch and account scope after awaiting the SDK session", async () => {
  for (const change of ["epoch", "scope"]) {
    const { c, disk } = fakeCloud();
    let resolveSession: (value: ReturnType<typeof syncSession>) => void,
      sessionStarted: () => void,
      requests = 0;
    const started = new Promise<void>((resolve) => (sessionStarted = resolve));
    const session = new Promise<ReturnType<typeof syncSession>>(
      (resolve) => (resolveSession = resolve),
    );
    c.client = {
      auth: {
        getSession: () => {
          sessionStarted();
          return session;
        },
      },
      rpc: () => {
        requests++;
        throw Error("An obsolete account must not construct an RPC");
      },
    };
    const syncing = c.sync();
    await started;
    if (change === "epoch") c.epoch++;
    else disk.scope = "22222222-1111-4222-8333-abcdef123456";
    resolveSession(syncSession());
    await syncing;
    assert.equal(requests, 0, `${change} changed during session lookup`);
    assert.equal(disk.state.journal.cursor, 0);
    assert.equal(c.lastSync, undefined);
  }
});
test("real Supabase RPC keeps the checked bearer when the SDK session changes before fetch", async () => {
  const { c, disk } = fakeCloud();
  const checkedToken = "checked-account-a-token",
    replacementToken = "newly-signed-in-account-b-token";
  const tokensRead: string[] = [],
    requests: { authorization: string; changes: any[] }[] = [];
  const client = createClient(
    "https://sdk-fixture.invalid",
    "fixture-public-key",
    {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        fetch: async (input, init) => {
          assert.equal(
            new URL(String(input)).pathname,
            "/rest/v1/rpc/sync_library",
          );
          assert.equal(tokensRead.at(-1), replacementToken);
          requests.push({
            authorization: new Headers(init?.headers).get("Authorization"),
            changes: JSON.parse(String(init?.body)).changes,
          });
          return new Response(
            JSON.stringify({
              generation: c.settings.generation,
              conflicts: [],
              records: [],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        },
      },
    },
  );
  await client.auth.stopAutoRefresh();
  client.auth.getSession = async () => {
    const first = tokensRead.length === 0,
      token = first ? checkedToken : replacementToken;
    tokensRead.push(token);
    return {
      data: {
        session: {
          user: { id: first ? owner : "22222222-1111-4222-8333-abcdef123456" },
          access_token: token,
        } as any,
      },
      error: null,
    };
  };
  c.client = client;
  disk.state.sources = [source];
  disk.state.credentials[source.id] = credentials(
    "https://owned-fixture.invalid",
  );
  c.source(source);
  clearTimeout(c.timer);
  await c.sync();
  assert.deepEqual(tokensRead, [checkedToken, replacementToken]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, `Bearer ${checkedToken}`);
  assert.equal(requests[0].changes[0].kind, "source");
  assert.equal(requests[0].changes[0].payload.format, "account-v2");
  assert.deepEqual(disk.state.journal.pending, {});
  assert.notEqual(c.lastSync, undefined);
  await client.auth.stopAutoRefresh();
});
test("failed password change cannot later replace the current password wrapper", async () => {
  const { c, vault } = fakeCloud(),
    current = await createVault(owner, "old valid password"),
    pending = await createVault(
      owner,
      "new valid password",
      current.key,
      current.settings.generation,
    );
  c.settings = current.settings;
  c.key = current.key;
  vault["pending-wrap"] = pending.settings;
  c.fetchSettings = async () => current.settings;
  c.client = {
    from: () => {
      throw Error("must not update the wrapper");
    },
  };
  await c.finishWrap("old valid password");
  assert.equal(vault["pending-wrap"], null);
  assert.deepEqual(
    await unlockVault(current.settings, "old valid password"),
    current.key,
  );
});

test("account sources sync without a vault key and recovery preserves all library data", async () => {
  const { c, disk } = fakeCloud();
  c.key = undefined;
  disk.switch = function (scope: string) {
    this.scope = scope.toLowerCase();
  };
  const s = { ...source, id: source.id.toUpperCase() };
  disk.state.sources = [s];
  disk.state.credentials[s.id] = credentials("http://127.0.0.1:8789");
  const m = media(s, "finished", "Finished episode", "episode");
  disk.state.media = [m];
  disk.state.progress[m.id] = {
    seconds: 24,
    duration: 24,
    completed: true,
    playedAt: 1,
  };
  disk.state.favorites = [m.id];
  c.source(s);
  const record = disk.state.journal.pending["source:" + s.id];
  assert.equal(record.payload.format, "account-v2");
  const other = fakeCloud();
  other.c.key = undefined;
  other.c.apply(record);
  assert.equal(other.disk.state.credentials[s.id].password, "fixture-password");
  c.fetchSettings = async () => c.settings;
  const before = structuredClone(disk.state);
  let changedPassword = false;
  c.client = {
    auth: {
      getSession: async () => syncSession(),
      getUser: async () => ({
        data: { user: { id: c.identity.id, email: c.identity.email } },
      }),
      updateUser: async ({ password }: any) => {
        changedPassword = password === "a new account password";
        return {};
      },
    },
    rpc: syncRPC(async (name: string) => {
      assert.equal(
        name,
        "sync_library",
        "recovery must never reset/delete a source vault",
      );
      return {
        data: { records: [], conflicts: [], generation: c.settings.generation },
      };
    }),
  };
  c.recovery = true;
  await c.auth("reset", { password: "a new account password" });
  clearTimeout(c.timer);
  assert.equal(changedPassword, true);
  for (const key of ["sources", "credentials", "progress", "favorites"])
    assert.deepEqual(disk.state[key], before[key]);
  assert.equal(c.ready, true);
  assert.equal(c.key, undefined);
});

test("completed series retain new episodes without marking the original catalog new", () => {
  const state = empty();
  const e1 = {
    ...media(source, "e1", "First", "episode"),
    seriesID: "show",
    season: 1,
    episode: 1,
  };
  const e2 = { ...e1, id: "second", episode: 2 };
  state.media = [e1];
  state.progress[e1.id] = { seconds: 24, completed: true };
  episodeChanges(state, source.id, "show", [e1]);
  assert.deepEqual(state.newEpisodeIDs, []);
  episodeChanges(state, source.id, "show", [e1, e2]);
  assert.deepEqual(state.newEpisodeIDs, [e2.id]);
  episodeChanges(state, source.id, "show", [e1, e2]);
  assert.deepEqual(state.newEpisodeIDs, [e2.id]);
});

test("account deletion reauthenticates and uses the edge function DELETE contract", async () => {
  const { c } = fakeCloud();
  const events: string[] = [];
  c.client.auth.signInWithPassword = async (args: any) => {
    assert.equal(args.email, "fixture@example.org");
    assert.equal(args.password, "current-password");
    events.push("reauth");
    return { error: null };
  };
  const invoke = async (name: string, args: any) => {
    assert.equal(name, "delete-account");
    assert.equal(args.method, "DELETE");
    events.push("delete");
    return { error: null };
  };
  c.client = { auth: c.client.auth, functions: { invoke } };
  c.signout = async () => {
    events.push("signout");
  };
  await c.deleteAccount("current-password");
  assert.deepEqual(events, ["reauth", "delete", "signout"]);
  c.client.auth.signInWithPassword = async () => ({
    error: Error("wrong password"),
  });
  await assert.rejects(c.deleteAccount("wrong"), /current password/);
  assert.equal(
    events.length,
    3,
    "failed reauthentication never invokes deletion",
  );
});
test("update check picks the newest matching desktop installer", async () => {
  const { pick, newer } = await import("../src/updates");
  const asset = (name: string) => ({
    name,
    browser_download_url: "https://github.com/x/" + name,
  });
  const release = (tag: string, files: string[], extra = {}) => ({
    tag_name: tag,
    html_url: "https://github.com/x/" + tag,
    assets: [...files.map(asset), asset("SHA256SUMS")],
    ...extra,
  });
  assert.equal(newer("1.0.10", "1.0.9"), true);
  assert.equal(newer("1.0.2", "1.0.2"), false);
  assert.equal(newer("1.0.1", "1.0.2"), false);
  const releases = [
    release("v1.4.0", ["Oxas-Library-v1.4.0-iOS-unsigned.ipa"]),
    release("desktop-v1.2.0", ["Oxa-Library-Setup-1.2.0.exe"], {
      prerelease: true,
    }),
    release("desktop-v1.1.0", [
      "Oxa-Library-Setup-1.1.0.exe",
      "Oxas-Library-Desktop-1.1.0-macOS-arm64.dmg",
      "Oxas-Library-Desktop-1.1.0-macOS-x64.dmg",
    ]),
    {
      ...release("desktop-v1.0.3", ["Oxa-Library-Setup-1.0.3.exe"]),
      assets: [asset("Oxa-Library-Setup-1.0.3.exe"), asset("SHA256SUMS.txt")],
    },
  ];
  assert.equal(pick(releases, "1.0.2", "win32", "x64")?.version, "1.1.0");
  assert.equal(
    pick(releases, "1.0.2", "darwin", "arm64")?.file,
    "Oxas-Library-Desktop-1.1.0-macOS-arm64.dmg",
  );
  assert.equal(
    pick(releases, "1.0.2", "darwin", "x64")?.file,
    "Oxas-Library-Desktop-1.1.0-macOS-x64.dmg",
  );
  assert.equal(pick(releases, "1.1.0", "win32", "x64"), undefined);
  assert.equal(
    pick(releases.slice(3), "1.0.2", "win32", "x64")?.sums,
    "https://github.com/x/SHA256SUMS.txt",
  );
  assert.equal(pick(releases, "1.0.2", "linux", "x64"), undefined);
});
