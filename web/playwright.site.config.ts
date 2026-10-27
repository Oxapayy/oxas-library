import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
export default defineConfig({
  testDir: './tests', testMatch: '**/site.spec.ts', workers: 1, timeout: 30000,
  outputDir: 'test-results-site', reporter: 'list',
  use: { viewport: { width: 1440, height: 900 }, launchOptions: { executablePath: process.env.OXA_BROWSER_EXECUTABLE || (process.platform === 'darwin' && fs.existsSync(brave) ? brave : undefined) } }
});
