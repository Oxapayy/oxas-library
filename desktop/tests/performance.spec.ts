import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createCipheriv, randomBytes } from "node:crypto";
import { empty, media, hash } from "../src/model";

test("large cached library remains responsive during a real download and preserves DOM", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-large-ui-"));
  const originalVideo = fs.readFileSync("../scripts/fixtures/test-video.mp4");
  const padding = Buffer.alloc(512 * 1024);
  padding.writeUInt32BE(padding.length, 0);
  padding.write("free", 4);
  const video = Buffer.concat([originalVideo, padding]);
  const server = http.createServer((req, res) => {
    if (req.url !== "/fixture.mp4") {
      res.writeHead(503);
      res.end();
      return;
    }
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Length", video.length);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    // Keep transfer progress active while menus are exercised.
    let offset = 0;
    const timer = setInterval(() => {
      if (res.destroyed) {
        clearInterval(timer);
        return;
      }
      const next = Math.min(offset + 16384, video.length);
      res.write(video.subarray(offset, next));
      offset = next;
      if (offset === video.length) {
        clearInterval(timer);
        res.end();
      }
    }, 80);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const source = {
    id: "A1B2C3D4-1111-4222-8333-ABCDEF123456",
    name: "Large cached library",
    kind: "Jellyfin",
    host: new URL(base).host,
    allowHTTP: true,
  };
  const direct = {
    ...source,
    id: "B1B2C3D4-1111-4222-8333-ABCDEF123456",
    name: "Owned video",
    kind: "Video URL",
  };
  const state = empty();
  state.sources = [source, direct];
  for (const s of state.sources)
    state.credentials[s.id] = {
      endpoint: base + (s.id === source.id ? "/offline/" : "/fixture.mp4"),
      username: "",
      password: "",
      token: "",
      userID: "",
      guideURL: "",
    };
  for (let i = 0; i < 5000; i++)
    state.media.push(
      media(source, `film-${i}`, `Film ${String(i).padStart(5, "0")}`),
    );
  for (let i = 0; i < 5000; i++)
    state.media.push({
      ...media(source, `episode-${i}`, `Episode ${i}`, "episode"),
      seriesID: `series-${Math.floor(i / 100)}`,
      season: 1,
      episode: (i % 100) + 1,
    });
  for (let i = 0; i < 300; i++)
    state.media.push({
      ...media(source, `channel-${i}`, `Channel ${i}`, "channel"),
      channelID: `channel-${i}`,
    });
  const now = Date.now() / 1000 - 978307200;
  for (let i = 0; i < 9000; i++)
    state.programs.push({
      id: `program-${i}`,
      sourceID: source.id,
      channelID: `channel-${i % 300}`,
      title: `Programme ${i}`,
      start: now - 30 + Math.floor(i / 300) * 3600,
      end: now + 3570 + Math.floor(i / 300) * 3600,
    });
  const target = {
    ...media(direct, "direct", "fixture.mp4"),
    stream: base + "/fixture.mp4",
  };
  state.media.push(target);
  const key = randomBytes(32);
  fs.writeFileSync(path.join(root, "device-key"), key);
  const write = (name: string, value: any) => {
    const nonce = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(name));
    fs.writeFileSync(
      path.join(root, name + ".vault"),
      Buffer.concat([
        nonce,
        cipher.update(JSON.stringify(value)),
        cipher.final(),
        cipher.getAuthTag(),
      ]),
    );
  };
  write("library-guest", state);
  write("ui", { hideWelcome: true });
  let app: any;
  try {
    app = await electron.launch({
      args: [".", "--test-mode"],
      env: { ...process.env, OXA_TEST_HOME: root },
    });
    const p = await app.firstWindow();
    await expect(p.locator(".poster")).toHaveCount(100);
    await p.getByRole("button", { name: "Show more (100 of 5001)" }).click();
    await expect(p.locator(".poster")).toHaveCount(200);
    const stateLatency = await p.evaluate(async () => {
      const start = performance.now();
      await window.oxa.command("state");
      return performance.now() - start;
    });
    expect(stateLatency).toBeLessThan(1500);
    await p.evaluate(async (id) => {
      await window.oxa.command("download", { id });
    }, hash(target.id));
    await p.evaluate(() => {
      (window as any).__transferUpdates = [];
      window.oxa.onUpdate((update) =>
        (window as any).__transferUpdates.push({
          partial: update.partial,
          programs: !!update.programs,
          rows: update.mediaUpdates?.length,
        }),
      );
    });
    // A byte update must retain the same poster DOM nodes, avoiding unnecessary
    // decoding/network/layout work on a page unrelated to Downloads.
    await p
      .locator(".poster")
      .first()
      .evaluate((node) => node.setAttribute("data-retained", "yes"));
    await expect
      .poll(() =>
        p.evaluate(
          async () =>
            (await window.oxa.command("state")).transfers[0]?.bytes || 0,
        ),
      )
      .toBeGreaterThan(262144);
    const updates = await p.evaluate(() => (window as any).__transferUpdates);
    expect(
      updates.some(
        (update: any) =>
          update.partial && !update.programs && update.rows === 1,
      ),
    ).toBeTruthy();
    await expect(p.locator('.poster[data-retained="yes"]')).toHaveCount(1);
    const latency: number[] = [];
    for (const page of ["IPTV", "Downloads", "Settings", "Library", "Search"]) {
      const start = Date.now();
      await p.locator(`[data-page="${page}"]`).click();
      await expect(
        p.getByRole("heading", { name: page, exact: true }),
      ).toBeVisible();
      latency.push(Date.now() - start);
      if (page === "IPTV") await expect(p.locator(".channel")).toHaveCount(100);
    }
    await p.getByLabel("Search your library").fill("Film 04999");
    await expect(p.locator(".search-results .row")).toHaveCount(1);
    await expect(p.locator(".search-results")).toContainText("Film 04999");
    expect(Math.max(...latency)).toBeLessThan(1000);
    await p.locator('[data-page="Downloads"]').click();
    await expect(p.getByRole("button", { name: "Play Offline" })).toBeVisible({
      timeout: 15000,
    });
    fs.mkdirSync("test-results", { recursive: true });
    fs.writeFileSync(
      "test-results/desktop-responsiveness.json",
      JSON.stringify(
        {
          catalogRows: state.media.length,
          guideRows: state.programs.length,
          stateLatencyMs: stateLatency,
          menuLatencyMs: latency,
        },
        null,
        2,
      ),
    );
  } finally {
    if (app) await app.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
