import { defineConfig } from "@playwright/test";
import fs from "node:fs";

const baseURL = process.env.OXA_WEB_TEST_URL || "http://127.0.0.1:4333";
const brave = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
const executablePath =
  process.env.OXA_BROWSER_EXECUTABLE ||
  (process.platform === "darwin" && fs.existsSync(brave) ? brave : undefined);

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/browser.spec.ts",
  timeout: 90000,
  expect: { timeout: 15000 },
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "test-results",
  use: {
    baseURL,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: { executablePath },
  },
  webServer: process.env.OXA_WEB_TEST_URL
    ? undefined
    : {
        command: "node ../web-private/dev-server.mjs --fixture --port 4333",
        url: baseURL + "/web",
        reuseExistingServer: !process.env.CI,
        timeout: 30000,
      },
});
