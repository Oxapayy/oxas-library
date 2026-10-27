"""Keep local provider-test startup independent of runner DNS configuration."""
from pathlib import Path
import runpy
import threading
import unittest
from unittest.mock import patch
from urllib.request import urlopen


class FixtureStartupTests(unittest.TestCase):
    def test_numeric_loopback_bind_and_http_do_not_resolve_dns(self):
        fixture = runpy.run_path(str(Path(__file__).with_name("api-fixture-server.py")))
        # A runner with slow/broken reverse DNS must still start immediately.
        with patch("socket.getfqdn", side_effect=AssertionError("DNS is unavailable")):
            with fixture["FixtureHTTPServer"](("127.0.0.1", 0), fixture["Handler"]) as server:
                self.assertGreater(server.server_port, 0)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with urlopen(f"http://127.0.0.1:{server.server_port}/invalid", timeout=2) as response:
                        self.assertEqual(response.status, 200)
                        self.assertEqual(response.read(), b"<html>Login</html>")
                finally:
                    server.shutdown()
                    thread.join(timeout=2)
                self.assertFalse(thread.is_alive())


if __name__ == "__main__":
    unittest.main()
