import { test, expect, type Page } from "@playwright/test";

async function openLibrary(page: Page) {
  await page.goto("/web");
  const guest = page.getByRole("button", {
    name: "Continue as Guest",
    exact: true,
  });
  await expect(guest).toBeVisible();
  await page.locator("#hide-welcome").check();
  await guest.click();
  await expect(
    page.locator("#content button.poster").filter({ hasText: "Fixture Film" }),
  ).toBeVisible();
  await expect(
    page
      .locator("#content button.poster")
      .filter({ hasText: "Fixture Series" }),
  ).toBeVisible();
}

async function detail(page: Page, title: string) {
  await page.locator('#sidebar button[data-page="Library"]').click();
  const all = page.locator('#content [data-filter="All"]');
  if (await all.count()) await all.click();
  await page
    .locator("#content button.poster")
    .filter({ hasText: title })
    .click();
  await expect(page.locator("#sheet")).toBeVisible();
  await expect(page.locator("#sheet h1")).toHaveText(title);
}

async function chooseServer(page: Page, name = "Owned MP4") {
  await expect(page.locator("#sheet > header h2")).toHaveText(
    /Sources|Next Episode/,
  );
  await page
    .locator('#sheet button[data-action="play"]')
    .filter({ hasText: name })
    .click();
  await expect(page.locator("#player")).toBeVisible();
  await expect
    .poll(
      () =>
        page.locator("#video").evaluate((v: HTMLVideoElement) => v.readyState),
      { timeout: 20000 },
    )
    .toBeGreaterThanOrEqual(1);
  // Some browsers require a second user gesture after asynchronous resolution.
  if (await page.locator("#video").evaluate((v: HTMLVideoElement) => v.paused))
    await page.locator("#toggle-play").click();
  await expect
    .poll(
      () =>
        page.locator("#video").evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0.5);
}

async function seek(page: Page, fraction: number) {
  await page
    .locator("#seek")
    .evaluate((input: HTMLInputElement, value: number) => {
      input.value = String(value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }, fraction * 1000);
}

async function wakePlayer(page: Page) {
  await page.locator("#player").dispatchEvent("mousemove");
}

test("automatic library, film/series-only search, details and Watchlist have no download controls", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await openLibrary(page);
  expect(new URL(page.url()).pathname).toBe("/web");
  expect(new URL(page.url()).hash).toBe("");
  await expect(page.locator("#sidebar nav button")).toHaveCount(4);
  await expect(
    page.locator(
      'button[data-page="Downloads"],button[data-action="download"],button[data-action="downloadDirectory"]',
    ),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath("desktop-library.png"),
    fullPage: true,
  });

  await page.locator('#sidebar [data-page="Search"]').click();
  await page.locator("#search-query").fill("Fixture");
  await page
    .getByRole("button", { name: "Search", exact: true })
    .last()
    .click();
  await expect(page.locator("#content .search-results button")).toHaveCount(2);
  await expect(page.locator("#content .search-results")).not.toContainText(
    "First Light",
  );
  await expect(page.locator("#content .search-results")).not.toContainText(
    "Second Look",
  );
  await detail(page, "Fixture Series");
  await expect(
    page.locator('#sheet button[data-action="download"]'),
  ).toHaveCount(0);
  await expect(page.locator("#sheet .episode")).toHaveCount(2);
  await page.locator("#season").selectOption("2");
  await expect(page.locator("#sheet .episode h3")).toHaveText("A New Chapter");
  await page.locator('#sheet button[data-action="favorite"]').click();
  await expect(
    page.locator('#sheet button[data-action="favorite"]'),
  ).toContainText("Saved");
  await page.locator('#sheet [data-action="sheet.close"]').click();
  await page.locator('[data-filter="Watchlist"]').click();
  await expect(page.locator("#content button.poster")).toHaveCount(1);

  await page.locator('#sidebar [data-page="Settings"]').click();
  await expect(page.locator("#content")).not.toContainText(/download/i);
  await expect(page.locator("#content [data-provider-assistance]")).toHaveCount(
    1,
  );
  await expect(
    page.locator("#content [data-provider-assistance]"),
  ).not.toBeChecked();
  await page.locator("#content [data-provider-assistance]").check();
  await page.reload();
  await expect(page.locator("#account")).not.toBeVisible();
  await expect(
    page.locator("#content button.poster").filter({ hasText: "Fixture Film" }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("MP4 ranges, captions, fullscreen, resume after reload and HLS media work through real capabilities", async ({
  page,
}) => {
  await openLibrary(page);
  const started = Date.now();
  await detail(page, "Fixture Film");
  await page.locator('#sheet button[data-action="play"]').click();
  const assistance = page.locator("#sheet [data-provider-assistance]");
  await expect(assistance).not.toBeChecked();
  await assistance.check();
  await expect(page.locator('#sheet button[data-action="play"]')).toHaveCount(
    2,
  );
  await chooseServer(page);
  const source = await page
    .locator("#video")
    .evaluate((v: HTMLVideoElement) => v.currentSrc);
  expect(new URL(source).pathname).toBe("/web/api/media");
  await expect
    .poll(() =>
      page
        .locator("#video")
        .evaluate((v: HTMLVideoElement) => v.textTracks[0]?.cues?.length || 0),
    )
    .toBeGreaterThan(0);
  await page.locator("#fullscreen").click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement?.id))
    .toBe("player");
  await page.locator("#fullscreen").click();
  await seek(page, 0.4);
  await expect
    .poll(() =>
      page.locator("#video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(8);
  await page.locator("#close-player").click();
  await expect(page.locator("#player")).toBeHidden();
  await page.reload();
  await expect(
    page.locator("#content .continue-card").filter({ hasText: "Fixture Film" }),
  ).toBeVisible();
  await page
    .locator("#content .continue-card")
    .filter({ hasText: "Fixture Film" })
    .click();
  await chooseServer(page);
  await expect
    .poll(() =>
      page.locator("#video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(8);
  await page.locator("#close-player").click();
  await detail(page, "Fixture Film");
  await page.locator('#sheet button[data-action="play"]').click();
  await chooseServer(page, "Owned HLS");
  const requests = await (await page.request.get("/__fixture/requests")).json();
  const active = requests.filter((r: any) => r.at >= started);
  expect(active.some((r: any) => r.path === "/video.mp4" && r.range)).toBe(
    true,
  );
  expect(active.some((r: any) => r.path === "/video.m3u8")).toBe(true);
  expect(active.some((r: any) => r.path.startsWith("/segment-"))).toBe(true);
});

test("episode autoplay can be cancelled and manual Next crosses a season boundary", async ({
  page,
}) => {
  await openLibrary(page);
  await detail(page, "Fixture Series");
  await page
    .locator("#sheet .episode")
    .filter({ hasText: "First Light" })
    .locator('[data-action="play"]')
    .click();
  await chooseServer(page);
  await seek(page, 0.9);
  await expect(page.locator("#up-next")).toContainText("Next episode plays in");
  await page.locator('#up-next [data-action="player.cancel-next"]').click();
  await expect(page.locator("#up-next")).toBeHidden();
  await wakePlayer(page);
  await page.locator("#next").click();
  // The previously selected server is retained for the next episode.
  await expect(page.locator("#player-subtitle")).toContainText("Second Look");
  await expect
    .poll(() =>
      page.locator("#video").evaluate((v: HTMLVideoElement) => v.currentTime),
    )
    .toBeGreaterThan(0.5);
  await wakePlayer(page);
  await page.locator("#next").click();
  await expect(page.locator("#player-subtitle")).toContainText("A New Chapter");
});

test("IPTV channel search, guide and live-player HLS use the separate TV tab", async ({
  page,
}) => {
  await openLibrary(page);
  await page.locator('#sidebar [data-page="IPTV"]').click();
  await expect(page.locator("#content .channel")).toHaveCount(2);
  await page.locator("#channel-query").fill("One");
  await expect(page.locator("#content .channel")).toHaveCount(1);
  await page.locator('#content [data-action="guide"]').click();
  await expect(page.locator("#sheet")).toContainText("Owned Program 1");
  await page.locator('#sheet [data-action="sheet.close"]').click();
  await page.locator('#content [data-action="play"]').click();
  await expect(page.locator("#player")).toBeVisible();
  await expect
    .poll(
      () =>
        page.locator("#video").evaluate((v: HTMLVideoElement) => v.currentTime),
      { timeout: 20000 },
    )
    .toBeGreaterThan(0.5);
  await expect(page.locator("#next")).toBeHidden();
});

test("removing the automatic huhu source is respected after a reload", async ({
  page,
}) => {
  await openLibrary(page);
  await page.locator('#sidebar [data-page="Settings"]').click();
  await page.locator('#content [data-action="source.confirm-remove"]').click();
  await expect(page.locator("#sheet")).not.toContainText(/download/i);
  await page.locator('#sheet [data-action="source.remove"]').click();
  await expect(page.locator("#content")).toContainText("No sources connected.");
  await page.reload();
  await expect(page.locator("#content")).toContainText(
    "Your library starts here.",
  );
  await expect(page.locator("#content button.poster")).toHaveCount(0);
});

test("phone layout keeps four glass tabs, readable controls and no horizontal overflow", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openLibrary(page);
  await expect(page.locator(".web-brandbar")).toBeVisible();
  await expect(page.locator("#sidebar nav button")).toHaveCount(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("phone-library.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 768, height: 1024 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("tablet-library.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#sidebar [data-page="Settings"]').click();
  await expect(page.locator("#content")).not.toContainText(/download/i);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await page.screenshot({
    path: info.outputPath("phone-settings.png"),
    fullPage: true,
  });
});
