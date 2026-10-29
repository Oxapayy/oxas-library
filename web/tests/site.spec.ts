import { test, expect } from '@playwright/test';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
let server: http.Server, origin: string;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../website');
test.beforeAll(async () => {
  server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url!, 'http://127.0.0.1').pathname);
    let file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
    let status = 200;
    // Clean page URLs such as /download map to download.html, as on the host.
    if (!path.extname(file) && fs.existsSync(file + '.html')) file += '.html';
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { file = path.join(root, '404.html'); status = 404; }
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.png') ? 'image/png' : 'image/jpeg';
    res.writeHead(status, { 'Content-Type': type }); res.end(fs.readFileSync(file));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = 'http://127.0.0.1:' + (server.address() as any).port;
});
test.afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
test('marketing section controls keep the address clean and link to /web', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/');
  await expect(page.locator('a[href^="#"]')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Open Web App', exact: true })).toHaveAttribute('href', '/web');
  await page.getByRole('button', { name: 'Explore', exact: true }).click();
  await expect(page).toHaveURL(origin + '/');
  await expect(page.locator('#inside h2')).toBeFocused();
  await page.locator('.nav-download').click();
  await expect(page).toHaveURL(origin + '/download');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Download Oxa’s Library');
  await page.goto(origin + '/#downloads');
  await expect(page).toHaveURL(origin + '/');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(origin + '/');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.getByRole('link', { name: 'Open Web App', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
test('unknown paths return the designed 404 with home and web links at both widths', async ({ page }, info) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const response = await page.goto(origin + '/this-page-does-not-exist');
    expect(response!.status()).toBe(404);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('in your library');
    await expect(page.getByRole('link', { name: /Open Web App/ })).toHaveAttribute('href', '/web');
    await expect(page.getByRole('link', { name: /Back to home/ })).toHaveAttribute('href', '/');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('404-' + width + '.png'), fullPage: true });
  }
});

test('the download page, legal pages and cookie notice work', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/download');
  await expect(page.locator('#support code')).toHaveCount(2);
  await expect(page.locator('#support code').first()).toBeVisible();
  for (const name of ['Mac', 'iPhone', 'Windows', 'Web']) await expect(page.getByRole('heading', { level: 2, name, exact: true })).toBeVisible();
  const notice = page.getByRole('region', { name: 'Cookie notice' });
  await expect(notice).toBeVisible();
  await notice.getByRole('button', { name: 'Decline' }).click();
  await expect(notice).toBeHidden();
  await page.goto(origin + '/');
  await expect(notice).toBeHidden();
  await page.getByRole('button', { name: 'Cookie Settings' }).click();
  await expect(notice).toBeVisible();
  for (const [link, heading] of [['Terms of Service', 'Terms of Service'], ['Privacy Policy', 'Privacy Policy']]) {
    await page.goto(origin + '/');
    await page.getByRole('contentinfo').getByRole('link', { name: link }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(heading);
  }
  await expect(page.locator('body')).not.toContainText('App code under the MIT licence');
  expect(errors).toEqual([]);
});
