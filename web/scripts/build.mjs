import { build } from 'esbuild';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
let config = {};
try { config = JSON.parse(await readFile('../Config/Cloud.local.json', 'utf8')); } catch {}
const appVersion = JSON.parse(await readFile(path.join(root, '../desktop/package.json'), 'utf8')).version;
const url = process.env.OXA_CLOUD_URL || config.url || '';
const key = process.env.OXA_CLOUD_PUBLIC_KEY || config.publishableKey || '';
if (url && (!url.startsWith('https://') || !key)) throw Error('Use HTTPS and a public client key.');
if (/sb_secret_|service_role/.test(key)) throw Error('Only public client configuration is allowed.');
if (key.startsWith('eyJ') && JSON.parse(Buffer.from(key.split('.')[1], 'base64url')).role !== 'anon') throw Error('Only anonymous legacy client keys are allowed.');
if (process.env.OXA_REQUIRE_CLOUD === '1' && (!url || !key)) throw Error('Hosted build requires public client configuration.');
export const modelAlias = {
  name: 'portable-model',
  setup(builder) {
    builder.onResolve({ filter: /^node:crypto$/ }, args => {
      if (!args.importer.endsWith('/desktop/src/model.ts')) return;
      return { path: path.join(root, 'src/crypto-model.ts') };
    });
  }
};
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.ts'], bundle: true, platform: 'browser', format: 'iife',
  outfile: 'dist/main.js', target: ['safari17', 'chrome120', 'firefox120'], minify: true,
  plugins: [modelAlias],
  nodePaths: [path.join(root, 'node_modules')],
  define: { __OXA_CLOUD_URL__: JSON.stringify(url), __OXA_CLOUD_PUBLIC_KEY__: JSON.stringify(key), __OXA_VERSION__: JSON.stringify(appVersion) },
});
await copyFile('src/index.html', 'dist/index.html');
await copyFile('../desktop/src/app.css', 'dist/app.css');
await copyFile('src/web.css', 'dist/web.css');
await copyFile('../website/assets/icon.png', 'dist/icon.png');
await writeFile('dist/THIRD-PARTY-NOTICES.txt', await readFile('../desktop/assets/THIRD-PARTY-NOTICES.txt'));
const nobleLicense = await readFile('node_modules/@noble/hashes/LICENSE', 'utf8');
await writeFile('dist/THIRD-PARTY-NOTICES.txt', (await readFile('dist/THIRD-PARTY-NOTICES.txt', 'utf8')) + '\n\n@noble/hashes 2.4.0\n\n' + nobleLicense);
await writeFile('dist/.account-origin', url ? new URL(url).origin : '');
let html = await readFile('dist/index.html', 'utf8');
for (const file of ['main.js', 'app.css', 'web.css']) {
  const data = await readFile('dist/' + file);
  const [name, extension] = file.split('.');
  const hashed = name + '.' + createHash('sha256').update(data).digest('hex').slice(0, 12) + '.' + extension;
  await writeFile('dist/' + hashed, data);
  html = html.replace('/web/' + file, '/web/' + hashed);
}
await writeFile('dist/index.html', html);
console.log('Built browser client without offline media or private gateway source.');
