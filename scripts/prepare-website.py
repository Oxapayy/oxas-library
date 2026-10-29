"""Publish content-addressed frontend assets so browser/CDN caches cannot mix releases."""
from hashlib import sha256
from pathlib import Path
import re

root = Path(__file__).resolve().parent.parent / 'website'
# Every marketing page shares one script and one stylesheet; 404.html loads the unversioned copies.
pages = ['index.html', 'download.html', 'terms.html', 'privacy.html']
html = {page: (root / page).read_text() for page in pages}
for name, extension in [('app', 'js'), ('styles', 'css')]:
    content = (root / f'{name}.{extension}').read_bytes()
    filename = f'{name}.{sha256(content).hexdigest()[:12]}.{extension}'
    for old in (root / 'assets').glob(f'{name}.*.{extension}'):
        if re.fullmatch(rf'{name}\.[a-f0-9]{{12}}\.{extension}', old.name) and old.name != filename:
            old.unlink()
    (root / 'assets' / filename).write_bytes(content)
    for page in pages:
        html[page], count = re.subn(rf'(["\'])/?(?:assets/)?{name}(?:\.[a-f0-9]{{12}})?\.{extension}\1', f'"/assets/{filename}"', html[page])
        if count != 1:
            raise RuntimeError(f'Expected exactly one {name} asset reference in {page}, got {count}')
for page in pages:
    (root / page).write_text(html[page])
print('Prepared versioned website assets.')
