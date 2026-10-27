import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { Provider } from "../src/providers";
import { uuid } from "../src/model";
test("Jellyfin, Emby, Plex, WebDAV, direct, M3U, Xtream and mHub contracts", async (t) => {
  const probe = http.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = (probe.address() as any).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const child = spawn(
    process.platform === "win32" ? "python" : "python3",
    ["scripts/api-fixture-server.py"],
    {
      cwd: "..",
      env: { ...process.env, OXA_FIXTURE_PORT: String(port) },
      stdio: "ignore",
    },
  );
  let startupError: any;
  child.on("error", (e) => (startupError = e));
  t.after(() => child.kill());
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (startupError) throw startupError;
    try {
      await fetch(base + "/invalid");
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  assert.ok(ready, "local protocol fixture started");
  const api = (kind: string, endpoint = base) =>
    new Provider(
      {
        id: uuid(),
        name: "Fixture",
        kind,
        host: `127.0.0.1:${port}`,
        allowHTTP: true,
        allowProviderFetch: false,
      },
      {
        endpoint,
        username: "fixture",
        password: "fixture-password",
        token: kind === "Plex" ? "fixture-token" : "",
        userID: "",
        guideURL: "",
      },
    );
  for (const kind of ["Jellyfin", "Emby"]) {
    const p = api(kind),
      catalog = await p.catalog();
    assert.equal(catalog.items.length, 2);
    assert.equal(p.credentials.token, "fixture-token");
    const play = await p.playback(catalog.items[0]);
    assert.match(play.url, /Videos\/movie-1\/stream.mp4/);
  }
  const plex = api("Plex"),
    pc = await plex.catalog();
  assert.deepEqual(pc.items.map((m) => m.kind).sort(), [
    "episode",
    "movie",
    "series",
  ]);
  assert.match(
    (await plex.playback(pc.items[0])).url,
    /library\/parts\/file.mp4/,
  );
  const dav = await api("NAS / WebDAV", base + "/dav/").catalog();
  assert.equal(dav.items[0].title, "NAS Film");
  const direct = await api("Video URL", base + "/file.mp4").catalog();
  assert.equal(direct.items[0].stream, base + "/file.mp4");
  await assert.rejects(api("Video URL", base + "/invalid").catalog());
  const playlist = await api("M3U playlist", base + "/list.m3u").catalog();
  assert.equal(playlist.items[0].kind, "channel");
  assert.equal(playlist.programs[0].title, "Fixture Program");
  assert.equal(playlist.items[0].stream, base + "/live.m3u8");
  const xtream = api("Xtream Codes"),
    xc = await xtream.catalog();
  assert.equal(xc.items.length, 3);
  assert.equal(
    (await xtream.episodes(xc.items.find((m) => m.kind === "series")!))[0]
      .episode,
    1,
  );
  const website = api("Library URL", base + "/website/"),
    catalog = await website.catalog();
  assert.ok(catalog.items.some((m) => m.kind === "movie"));
  assert.ok(catalog.items.some((m) => m.kind === "series"));
  assert.ok(catalog.items.some((m) => m.kind === "channel"));
  const series = catalog.items.find((m) => m.kind === "series")!,
    episodes = await website.episodes(series, 1);
  assert.equal(episodes[0].title, "First Episode");
  const movie = catalog.items.find((m) => m.kind === "movie")!,
    sources = await website.sources(movie);
  assert.ok(sources.sources.some((s) => s.name === "Playable candidate"));
  const play = await website.playback(
    movie,
    sources.sources.find((s) => s.name === "Playable candidate"),
  );
  assert.equal(play.url, base + "/test-stream.mp4");
  assert.equal(play.headers.Authorization, undefined);
  assert.equal(play.media.subtitleURL, base + "/en.vtt");
  assert.equal(
    (await website.search("Remote")).some(
      (m) => m.title === "Remote Only Film",
    ),
    true,
  );
  const page = catalog.pages.find((p) => p.cursor);
  assert.equal(
    (await website.page(page, await website.discover())).items[0].title,
    "Second Library Film",
  );
  await assert.rejects(
    website.playback(
      movie,
      sources.sources.find((s) => s.name === "Assisted server"),
    ),
  );
});
