"""Assemble a Vercel deployment of oxapay.cc in a separate folder.

Run after building web/ and the private gateway (web-private/build.mjs).
Static files go to <out>/public, so the gateway bundle in <out>/lib is never
served; <out>/api holds the function and <out>/vercel.json the routes and the
headers that Netlify read from netlify.toml and website/_headers.
"""
from pathlib import Path
import json
import shutil
import subprocess
import sys

root = Path(__file__).resolve().parent.parent
if len(sys.argv) != 2:
    raise SystemExit('Usage: prepare-vercel.py <output folder outside the repository>')
out = Path(sys.argv[1]).resolve()
if out == root or root in out.parents:
    raise SystemExit('Choose an output folder outside the repository.')
gateway = root / 'web-private' / 'functions' / 'oxa-api.mjs'
if not gateway.is_file():
    raise SystemExit('Build the private gateway first: node web-private/build.mjs')

for script in ['prepare-website.py', 'prepare-web-site.py']:
    subprocess.run([sys.executable, str(root / 'scripts' / script)], check=True)

if out.exists():
    shutil.rmtree(out)
shutil.copytree(root / 'website', out / 'public', ignore=shutil.ignore_patterns('_headers', '.taste-skill', '.DS_Store'))
(out / 'lib').mkdir(parents=True)
shutil.copy(gateway, out / 'lib' / 'oxa-gateway.mjs')
(out / 'api').mkdir()
shutil.copy(root / 'scripts' / 'vercel' / 'oxa.mjs', out / 'api' / 'oxa.mjs')
(out / 'package.json').write_text(json.dumps({'private': True, 'type': 'module', 'engines': {'node': '24.x'}}, indent=2) + '\n')

# Netlify's _headers rows: a path, then indented "Name: value" lines.
def vercel_source(route):
    if route.endswith('/*'):
        return route[:-2] + '/(.*)'
    return route.replace('*', '(.*)')

headers = [{'source': '/(.*)', 'headers': [
    {'key': 'X-Content-Type-Options', 'value': 'nosniff'},
    {'key': 'Referrer-Policy', 'value': 'strict-origin-when-cross-origin'},
    {'key': 'Permissions-Policy', 'value': 'camera=(), microphone=(), geolocation=()'},
]}]
for route in ['/', '/index.html', '/download', '/terms', '/privacy', '/app.js', '/styles.css']:
    headers.append({'source': route, 'headers': [{'key': 'Cache-Control', 'value': 'public, max-age=0, must-revalidate'}]})
current = None
for line in (root / 'website' / '_headers').read_text().splitlines():
    if not line.strip():
        current = None
    elif not line.startswith(' '):
        current = {'source': vercel_source(line.strip()), 'headers': []}
        headers.append(current)
    else:
        key, value = line.strip().split(':', 1)
        current['headers'].append({'key': key.strip(), 'value': value.strip()})

config = {
    '$schema': 'https://openapi.vercel.sh/vercel.json',
    'framework': None,
    'buildCommand': '',
    'installCommand': '',
    'outputDirectory': 'public',
    'cleanUrls': False,
    'trailingSlash': False,
    'functions': {'api/oxa.mjs': {'maxDuration': 60}},
    'rewrites': [
        {'source': '/web/api/:op', 'destination': '/api/oxa?op=:op'},
        {'source': '/web', 'destination': '/web/index.html'},
        {'source': '/download', 'destination': '/download.html'},
        {'source': '/terms', 'destination': '/terms.html'},
        {'source': '/privacy', 'destination': '/privacy.html'},
    ],
    'redirects': [
        {'source': '/app', 'destination': '/web', 'permanent': True},
        {'source': '/app/:path*', 'destination': '/web/:path*', 'permanent': True},
    ],
    'headers': headers,
}
(out / 'vercel.json').write_text(json.dumps(config, indent=2) + '\n')
print(f'Prepared the Vercel deployment in {out}')
