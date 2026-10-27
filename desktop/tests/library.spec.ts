import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
test("website episodes, HLS, next episode, full-season offline files, MPEG-TS and guide", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-library-ui-"));
  const injectedOrdinal =
    '\"><button data-action="account" data-args=\'{"action":"reset"}\'>Injected provider action</button><option value="';
  let base = "";
  let released = false;
  const video = fs.readFileSync("../scripts/fixtures/test-video.mp4"),
    art = fs.readFileSync(
      "../Resources/Assets.xcassets/preview-film1.imageset/art.png",
    );
  const item = (id: string) => ({
    id,
    type: "video",
    name:
      id === "e1"
        ? "First Episode"
        : id === "e2"
          ? "Second Episode"
          : "New Episode",
    season: 1,
    episode: id === "e1" ? 1 : id === "e2" ? 2 : 3,
    runtime: 24,
    ids: { tmdb: `43:1:${id === "e1" ? 1 : id === "e2" ? 2 : 3}` },
    sources: [{ url: base + "/watch/" + id, name: "Local File" }],
  });
  const series = {
    id: "series",
    type: "series",
    name: "Fixture Series",
    description: "Owned media used for desktop verification.",
    images: { poster: "/poster.png", backdrops: ["/poster.png"] },
    catalogs: [
      { id: "season-one", type: "video", name: "Season 1", season: 1 },
      {
        id: "hostile-season",
        type: "video",
        name: "Untrusted",
        season: injectedOrdinal,
      },
    ],
  };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url!, base),
      send = (data: any) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(data));
      };
    if (u.pathname === "/mhub-addon.json") {
      send({
        id: "fixture",
        name: "Owned Library",
        specVersion: 2,
        resources: ["catalog", "item", "resolve"],
        urlPatterns: ["*/watch/*"],
        catalogs: [
          { id: "shows", name: "Series", type: "series" },
          { id: "channels", name: "Live TV", type: "live" },
        ],
      });
      return;
    }
    if (u.pathname === "/catalog/series/shows.json") {
      send({ items: [series] });
      return;
    }
    if (u.pathname === "/catalog/live/channels.json") {
      send({
        items: [
          {
            id: "channel",
            type: "live",
            name: "Fixture Live",
            url: base + "/watch/live",
            epg: [
              {
                title: "Now on Fixture",
                start: new Date(Date.now() - 60000).toISOString(),
                end: new Date(Date.now() + 3600000).toISOString(),
              },
            ],
          },
        ],
      });
      return;
    }
    if (u.pathname === "/item/live/channel.json") {
      send({
        id: "channel",
        type: "live",
        name: "Fixture Live",
        url: base + "/watch/live",
      });
      return;
    }
    if (u.pathname === "/catalog/video/season-one.json") {
      send({
        items: [item("e1"), item("e2"), ...(released ? [item("e3")] : [])],
      });
      return;
    }
    if (u.pathname === "/item/series/series.json") {
      send(series);
      return;
    }
    if (u.pathname.startsWith("/item/video/")) {
      send(item(u.pathname.includes("e1") ? "e1" : "e2"));
      return;
    }
    if (u.pathname === "/resolve") {
      const live = u.searchParams.get("url")?.endsWith("/live"),
        first = u.searchParams.get("url")?.endsWith("/e1");
      send({
        url:
          base + (live ? "/live.mpegts" : first ? "/video.m3u8" : "/video.mp4"),
        format: live ? "mpegts" : first ? "hls" : "mp4",
        creditsStart: 19,
        subtitles: [{ url: base + "/en.vtt", language: "en" }],
      });
      return;
    }
    if (u.pathname === "/poster.png") {
      res.setHeader("Content-Type", "image/png");
      res.end(art);
      return;
    }
    if (u.pathname === "/en.vtt") {
      res.setHeader("Content-Type", "text/vtt");
      res.end(
        "WEBVTT\n\n00:00:00.000 --> 00:00:24.000\nOwned fixture captions\n",
      );
      return;
    }
    if (u.pathname === "/video.mp4") {
      res.setHeader("Content-Type", "video/mp4");
      res.setHeader("Content-Length", video.length);
      res.end(req.method === "HEAD" ? undefined : video);
      return;
    }
    const file =
      u.pathname === "/live.mpegts"
        ? "video.mpegts"
        : path.basename(u.pathname);
    if (/^(video\.m3u8|video\.mpegts|segment-\d+\.bin)$/.test(file)) {
      const data = fs.readFileSync("tests/fixtures/" + file);
      res.setHeader(
        "Content-Type",
        file.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      );
      res.setHeader("Content-Length", data.length);
      res.end(req.method === "HEAD" ? undefined : data);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  let app: any;
  try {
    app = await electron.launch({
      args: [".", "--test-mode"],
      env: { ...process.env, OXA_TEST_HOME: root },
    });
    const p = await app.firstWindow();
    await p.getByRole("button", { name: "Continue as Guest" }).click();
    await p.getByRole("button", { name: "Connect Your Own Server" }).click();
    await p.getByLabel("Name", { exact: true }).fill("Owned Library");
    await p.getByLabel("Server or library URL").fill(base);
    await p
      .getByLabel("Allow local HTTP for this source", { exact: true })
      .check();
    await p.getByRole("button", { name: "Connect Source" }).click();
    await p.getByRole("button", { name: /Fixture Series/ }).click();
    await expect(
      p.getByRole("heading", { name: "First Episode" }),
    ).toBeVisible();
    await expect(p.locator('#sheet [data-action="account"]')).toHaveCount(0);
    await expect(
      p.getByText("Injected provider action", { exact: true }),
    ).toHaveCount(0);
    await expect(p.locator("#season option")).toHaveCount(1);
    await p.getByRole("button", { name: "☆ Watchlist", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "★ Saved", exact: true }),
    ).toBeVisible();
    await p.getByRole("button", { name: "★ Saved", exact: true }).click();
    await expect(
      p.getByRole("button", { name: "☆ Watchlist", exact: true }),
    ).toBeVisible();
    await p
      .locator(".episode")
      .filter({ hasText: "First Episode" })
      .getByRole("button", { name: "Play", exact: true })
      .click();
    await p.getByRole("button", { name: /Local File/ }).click();
    await expect
      .poll(() =>
        p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await expect
      .poll(() =>
        p
          .locator("video")
          .evaluate((v: HTMLVideoElement) =>
            Array.from(v.textTracks).some((t) => t.activeCues?.length),
          ),
      )
      .toBeTruthy();
    await p.getByRole("button", { name: "Next episode", exact: true }).click();
    await expect(p.locator("#player-subtitle")).toContainText("Second Episode");
    await expect
      .poll(() =>
        p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await p.getByRole("button", { name: "Close player", exact: true }).click();
    await p
      .getByRole("button", { name: /Fixture Series/ })
      .last()
      .click();
    await p
      .locator(".episode")
      .filter({ hasText: "First Episode" })
      .getByRole("button", { name: /^(Play|Resume)$/ })
      .click();
    await p.getByRole("button", { name: /Local File/ }).click();
    await expect
      .poll(() =>
        p.locator("video").evaluate((v: HTMLVideoElement) => v.duration),
      )
      .toBeGreaterThan(20);
    await expect
      .poll(() =>
        p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.4);
    await p.locator("#seek").fill("850");
    await expect(p.locator("#up-next")).toBeVisible();
    await expect(p.locator("#player-subtitle")).toContainText(
      "Second Episode",
      { timeout: 10000 },
    );
    await p.getByRole("button", { name: "Close player", exact: true }).click();
    await p
      .getByRole("button", { name: /Fixture Series/ })
      .last()
      .click();
    await p.getByRole("button", { name: "Download Season 1" }).click();
    await p.getByRole("button", { name: /Local File/ }).click();
    await p.getByRole("button", { name: "Downloads", exact: true }).click();
    await expect(p.getByRole("button", { name: "Play Offline" })).toHaveCount(
      2,
      { timeout: 15000 },
    );
    await p.getByRole("button", { name: "IPTV", exact: true }).click();
    await expect(p.getByText("Now on Fixture", { exact: true })).toBeVisible();
    await p.getByRole("button", { name: "Program Guide" }).click();
    await expect(
      p.getByRole("heading", { name: "Now on Fixture" }),
    ).toBeVisible();
    await p.getByRole("button", { name: "Close", exact: true }).click();
    await p.getByRole("button", { name: "Play", exact: true }).click();
    await p.getByRole("button", { name: /Fixture Live/ }).click();
    await expect
      .poll(() =>
        p.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await p.getByRole("button", { name: "Close player", exact: true }).click();
    await p.getByRole("button", { name: "Library", exact: true }).click();
    released = true;
    await p.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(
      p.getByRole("heading", { name: "New Episodes", exact: true }),
    ).toBeVisible();
    await expect(
      p.locator(".continue-card").filter({ hasText: "New Episode" }),
    ).toBeVisible();
    await p
      .getByRole("button", { name: "Search", exact: true })
      .first()
      .click();
    await expect(p.locator(".search-results button")).toHaveCount(1);
    await expect(p.locator(".search-results")).not.toContainText(
      "First Episode",
    );
    await p.getByRole("button", { name: "Library", exact: true }).click();
    fs.mkdirSync("test-results", { recursive: true });
    await p.screenshot({ path: "test-results/library.png" });
    for (const width of [1440, 900, 680]) {
      await app.evaluate(
        ({ BrowserWindow }, width) =>
          BrowserWindow.getAllWindows()[0].setSize(width, 820),
        width,
      );
      await expect
        .poll(() =>
          p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        )
        .toBeTruthy();
      await p.screenshot({ path: `test-results/library-${width}.png` });
    }
    // Export the real rendered DOM for the skill's visual meter. Functional behavior
    // is exercised above in Electron; this static snapshot is never shipped.
    const html = await p.evaluate(async () => {
      const copy = document.documentElement.cloneNode(true) as HTMLElement;
      copy.querySelectorAll("script").forEach((s) => s.remove());
      const original = Array.from(document.querySelectorAll("img")),
        images = Array.from(copy.querySelectorAll("img"));
      for (let i = 0; i < original.length; i++) {
        const data = await (await fetch(original[i].src)).blob();
        images[i].src = await new Promise<string>((r) => {
          const f = new FileReader();
          f.onload = () => r(String(f.result));
          f.readAsDataURL(data);
        });
      }
      return "<!doctype html>" + copy.outerHTML;
    });
    fs.mkdirSync("../.taste-skill/desktop-static", { recursive: true });
    fs.writeFileSync("../.taste-skill/desktop-static/index.html", html);
    fs.copyFileSync("dist/app.css", "../.taste-skill/desktop-static/app.css");
  } finally {
    if (app) await app.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
