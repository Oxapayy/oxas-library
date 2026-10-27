import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
test("guest library, real playback, resume, downloads, offline and source removal", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oxa-ui-"));
  const video = fs.readFileSync(
    path.resolve("../scripts/fixtures/test-video.mp4"),
  );
  let unavailable = false;
  const server = http.createServer((req, res) => {
    if (unavailable) {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.method === "HEAD") {
      res.setHeader("Content-Type", "video/mp4");
      res.end();
      return;
    }
    const start = Number(
      String(req.headers.range || "").match(/bytes=(\d+)-/)?.[1] || 0,
    );
    res.writeHead(start ? 206 : 200, {
      "Content-Type": "video/mp4",
      "Content-Length": video.length - start,
      "Accept-Ranges": "bytes",
      ...(start
        ? {
            "Content-Range": `bytes ${start}-${video.length - 1}/${video.length}`,
          }
        : {}),
    });
    res.end(video.subarray(start));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${(server.address() as any).port}/fixture.mp4`;
  let app: any;
  try {
    app = await electron.launch({
      args: [".", "--test-mode"],
      env: { ...process.env, OXA_TEST_HOME: root },
    });
    let page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Welcome to Oxa’s Library" }),
    ).toBeVisible();
    await page.getByLabel("Don’t show this message again").check();
    await page.getByRole("button", { name: "Continue as Guest" }).click();
    await page.getByRole("button", { name: "Connect Your Own Server" }).click();
    await page.getByLabel("Name", { exact: true }).fill("Owned fixture");
    await page.getByLabel("Source type").selectOption("Video URL");
    await page.getByLabel("Server or library URL").fill(endpoint);
    await page
      .getByText("Allow local HTTP for this source", { exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect Source", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: /fixture.mp4/ }),
    ).toBeVisible();
    await page.getByRole("button", { name: /fixture.mp4/ }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(0.2);
    await page.locator("#seek").fill("350");
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(8);
    const beforeFullscreen = await page
      .locator("video")
      .evaluate((v: HTMLVideoElement) => v.currentTime);
    await page.getByRole("button", { name: "Toggle full screen" }).click();
    await expect
      .poll(() =>
        page.locator("video").evaluate((v: HTMLVideoElement) => v.currentTime),
      )
      .toBeGreaterThan(beforeFullscreen + 0.25);
    await page.getByRole("button", { name: "Toggle full screen" }).click();
    await page
      .getByRole("button", { name: "Close player", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Continue Watching" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /fixture.mp4/ })
      .last()
      .click();
    await page.getByRole("button", { name: "Download", exact: true }).click();
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Play Offline" }),
    ).toBeVisible({ timeout: 15000 });
    unavailable = true;
    await app.close();
    app = await electron.launch({
      args: [".", "--test-mode"],
      env: { ...process.env, OXA_TEST_HOME: root },
    });
    page = await app.firstWindow();
    await expect(
      page.getByRole("heading", { name: "Library", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Welcome to Oxa’s Library" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("button", { name: "Downloads", exact: true }).click();
    await page.getByRole("button", { name: "Play Offline" }).click();
    await expect
      .poll(() =>
        page
          .locator("video")
          .evaluate((v: HTMLVideoElement) => !v.paused && v.currentTime > 0),
      )
      .toBeTruthy();
    await page
      .getByRole("button", { name: "Close player", exact: true })
      .click();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Take your favorites with you." }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByText("No sources connected.", { exact: true }),
    ).toBeVisible();
    fs.mkdirSync("test-results", { recursive: true });
    await page.screenshot({ path: "test-results/settings.png" });
    const errors = await page.evaluate(() => ({
      node: typeof (window as any).require,
      process: typeof (window as any).process,
    }));
    expect(errors).toEqual({ node: "undefined", process: "undefined" });
  } finally {
    if (app) await app.close();
    await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
