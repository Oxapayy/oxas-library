"""Local deterministic integration fixtures. Never shipped inside the iPhone app."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import json
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).parent / "fixtures"
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)
    def log_message(self, fmt, *args):
        pass  # Never log URL query strings, even in fixture tests.

ThreadingHTTPServer(("127.0.0.1", 8787), Handler).serve_forever()
