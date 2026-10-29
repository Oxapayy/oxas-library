"""Copy a prebuilt browser client and emit route-specific security policies.

The hosted gateway is built/deployed separately from ignored private source.
A public source checkout can build web/ against its own compatible gateway.
"""
from pathlib import Path
from urllib.parse import urlsplit
import json
import os
import shutil

root = Path(__file__).resolve().parent.parent
publish = root / 'website'
client = root / 'web' / 'dist'
if not (client / 'index.html').is_file():
    raise RuntimeError('Build the browser client in web/ before preparing the site.')
dest = publish / 'web'
if dest.exists():
    shutil.rmtree(dest)
shutil.copytree(client, dest, ignore=shutil.ignore_patterns('tests', '*.map', '.account-origin'))

config = {}
try:
    config = json.loads((root / 'Config' / 'Cloud.local.json').read_text())
except FileNotFoundError:
    pass
prebuilt_origin = (client / '.account-origin').read_text().strip() if (client / '.account-origin').exists() else ''
account = os.environ.get('OXA_CLOUD_URL') or config.get('url', '') or prebuilt_origin
origin = ''
if account:
    parsed = urlsplit(account)
    if parsed.scheme != 'https' or not parsed.netloc or parsed.username or parsed.password:
        raise RuntimeError('Use an HTTPS public account endpoint.')
    origin = ' https://' + parsed.netloc
marketing = "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
app = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https://image.tmdb.org; media-src 'self' blob: https:; connect-src 'self'" + origin + " https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
rows = []
for route in ['/', '/index.html', '/404.html', '/download', '/download.html', '/terms', '/terms.html', '/privacy', '/privacy.html', '/assets/*', '/styles.css', '/app.js']:
    rows += [route, '  Content-Security-Policy: ' + marketing, '']
for route in ['/web', '/web/*']:
    # Video servers often refuse foreign referrers but accept none.
    rows += [route, '  Content-Security-Policy: ' + app, '  Cache-Control: public, max-age=0, must-revalidate', '  Referrer-Policy: no-referrer', '']
# Content-hashed bundles never change; let browsers keep them for a year.
for route in ['/web/main.*', '/web/app.*']:
    rows += [route, '  Cache-Control: public, max-age=31536000, immutable', '']
(publish / '_headers').write_text('\n'.join(rows))
print('Prepared browser app, clean routes and distinct security policies.')
