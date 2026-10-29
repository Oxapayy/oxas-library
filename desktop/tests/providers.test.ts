import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Provider } from "../src/providers";
import { uuid } from "../src/model";
test("Jellyfin, Emby, Plex, WebDAV, direct, M3U, Xtream and mHub contracts", async (t) => {
  const child = spawn(
    process.env.PYTHON || (process.platform === "win32" ? "python" : "python3"),
    ["-u", "scripts/api-fixture-server.py"],
    {
      cwd: "..",
      env: { ...process.env, OXA_FIXTURE_PORT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let diagnostics = "";
  child.stderr.on("data", (data) => {
    diagnostics = (diagnostics + data).slice(-8192);
  });
  t.after(() => child.kill());
  const port = await new Promise<number>((resolve, reject) => {
    // Wait for this exact process to announce its bound ephemeral port. A TCP
    // probe cannot distinguish a slow child from another process owning a port.
    const timer = setTimeout(
      () =>
        reject(
          Error(`Protocol fixture did not announce readiness: ${diagnostics}`),
        ),
      15000,
    );
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };
    child.once("error", fail);
    child.once("exit", (code, signal) =>
      fail(
        Error(`Protocol fixture exited (${code ?? signal}): ${diagnostics}`),
      ),
    );
    let pending = "";
    child.stdout.on("data", (data) => {
      diagnostics = (diagnostics + data).slice(-8192);
      pending = (pending + data).slice(-8192);
      let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        try {
          const message = JSON.parse(line);
          if (
            message.fixtureReady === true &&
            Number.isInteger(message.port) &&
            message.port > 0 &&
            message.port <= 65535
          ) {
            clearTimeout(timer);
            resolve(message.port);
          }
        } catch {
          // Keep non-protocol output as bounded failure diagnostics.
        }
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const readiness = await fetch(base + "/invalid", {
    signal: AbortSignal.timeout(2000),
  });
  assert.equal(readiness.status, 200);
  assert.equal(await readiness.text(), "<html>Login</html>");
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
test("unchanged M3U playlists and guides are not downloaded again", async (t) => {
  const http = await import("node:http");
  const playlist =
    '#EXTM3U url-tvg="/guide.xml"\n#EXTINF:-1 tvg-id="one",One\nhttp://127.0.0.1/one.m3u8\n';
  const xml =
    '<tv><programme channel="one" start="20260101000000 +0000" stop="20260101010000 +0000"><title>Show</title></programme></tv>';
  const full: string[] = [];
  const server = http.createServer((req, res) => {
    const body = req.url === "/guide.xml" ? xml : playlist;
    const etag = req.url === "/guide.xml" ? '"g1"' : '"p1"';
    if (req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag });
      res.end();
      return;
    }
    full.push(req.url || "");
    res.writeHead(200, { ETag: etag, "Content-Type": "text/plain" });
    res.end(body);
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const port = (server.address() as any).port;
  const api = new Provider(
    {
      id: uuid(),
      name: "Fixture",
      kind: "M3U playlist",
      host: `127.0.0.1:${port}`,
      allowHTTP: true,
      allowProviderFetch: false,
    } as any,
    { endpoint: `http://127.0.0.1:${port}/list.m3u` } as any,
  );
  const first = await api.catalog();
  assert.equal(first.items.length, 1);
  assert.equal(first.programs.length, 1);
  assert.deepEqual(full, ["/list.m3u", "/guide.xml"]);
  // Without titles to fall back on, the playlist is always downloaded.
  await api.catalog();
  assert.equal(full.length, 4);
  const second = await api.catalog({
    items: () => first.items,
    programs: () => first.programs,
  });
  assert.equal(full.length, 4);
  assert.equal(second.items[0].id, first.items[0].id);
  assert.equal(second.programs[0].title, "Show");
});
