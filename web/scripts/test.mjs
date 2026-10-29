import { build } from 'esbuild';
import { readdir, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { modelAlias } from './build.mjs';

await mkdir('dist/tests', { recursive: true });
const files = (await readdir('tests')).filter(name => name.endsWith('.test.ts'));
for (const file of files) await build({
  entryPoints: ['tests/' + file], bundle: true, platform: 'node', format: 'esm',
  outfile: 'dist/tests/' + file.replace(/\.ts$/, '.mjs'), target: 'node24',
  plugins: [modelAlias], nodePaths: [path.resolve('node_modules')],
  define: { __OXA_VERSION__: JSON.stringify('0.0.0-test'), __OXA_CLOUD_URL__: JSON.stringify('https://example.invalid'), __OXA_CLOUD_PUBLIC_KEY__: JSON.stringify('fixture-public-key') },
});
const child = spawn(process.execPath, ['--test', ...files.map(file => 'dist/tests/' + file.replace(/\.ts$/, '.mjs'))], { stdio: 'inherit' });
child.on('exit', code => process.exit(code ?? 1));
