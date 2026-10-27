# Oxa’s Library for the web

The English browser client lives at **https://oxapay.cc/web**. It automatically connects the huhu catalog and offers Library, Search, IPTV and Settings with the same player, watchlist, Continue Watching and New Episodes behavior as the apps where browser formats permit it. There are no offline downloads, media caches, transfer queues or download controls in this client.

The existing marketing website stays at https://oxapay.cc. Its section controls scroll without adding URL fragments. Unknown pages use a custom 404 with home and web-app links.

## Build the public client

Use Node.js24 and npm:

```sh
cd web
npm ci
npm run typecheck
npm test
npm run build
```

`web/dist/` contains the static browser client. Public source includes no hosted account values by default. To connect your own compatible account service, use the root `Config/Cloud.example.json` as described in the main README, or supply `OXA_CLOUD_URL` and `OXA_CLOUD_PUBLIC_KEY` at build time. Only an HTTPS endpoint and a public publishable/anonymous client key are accepted. `OXA_REQUIRE_CLOUD=1` makes a hosted build fail when configuration is absent. Administrator, SMTP and service-role credentials must never enter this build.

The renderer and presentation styles are shared with `desktop/`; an explicit web capability removes native download and filesystem actions. Stable identities, catalog projection, next-episode ordering and new-episode tracking use the shared model. Browser storage and cloud sync are separate adapters, with asynchronous encrypted IndexedDB writes, account-scoped outboxes and WebCrypto legacy migration.

## Provider gateway contract

The hosted gateway implementation is intentionally private and excluded from this client repository. A source build must supply its own compatible same-origin gateway; compiling the frontend does not provision that service.

- `POST /web/api/provider`: JSON containing an operation, current source/credentials and the relevant media, choice, season, page or search query. Supported operations are catalog, detail, episodes, sources, playback, page, search and opt-in metadata search. Replies contain result, source, credentials and an original-artwork-URL to opaque-capability-URL mapping.
- `POST /web/api/artwork`: current source/credentials and a bounded list of artwork URLs; returns opaque same-origin URLs.
- `GET/HEAD /web/api/media?token=…`: short-lived encrypted capability for approved artwork, HLS playlists/segments or validated bounded progressive byte ranges.
- `GET/HEAD /web/api/caption?token=…`: approved subtitle capability, served as VTT.

The browser never forwards its Oxa bearer token to a library provider. Provider-assisted resolution remains a separate source permission. Gateway credentials/signing keys and implementation belong outside static output and public Git. The installed website's server code is not part of a client-only build.

## Browser limits

Reachable HTTPS sources, supported codecs and server byte-range/HLS behavior determine playback availability. A hosted gateway cannot reach a private home LAN. Plain HTTP LAN sources belong in the native app. Continuous raw MPEG-TS relaying needs a persistent streaming host; the serverless web player reports an actionable compatibility error instead of truncating a long stream. A successful catalog import does not guarantee a given playback server works.

The browser stores metadata and account state, not offline video files. Clearing website data removes that browser's local guest profile; a signed-in account can restore its synced library. Failed writes retain dirty changes and show Retry Saving. Password recovery keeps connections, history and watchlist. Closing the web player waits for its progress checkpoint before the close visibly completes.

## Verification

State tests cover native-compatible legacy AES-GCM, nonextractable IndexedDB keys, quota/corruption failures, atomic account transitions, source deduplication, recovery preservation and per-RPC frozen bearer binding. Browser integration tests use owned fixture media through actual gateway capabilities for MP4 ranges, HLS, captions, fullscreen, seeking/resume, autoplay cancellation, next-season loading, guide/search, source removal and responsive layouts.

`web/tests/browser.spec.ts` requires a compatible owned-media fixture gateway and accepts `OXA_WEB_TEST_URL`; the private hosted gateway is not distributed with those tests. Marketing navigation/404 tests can run independently using `npx playwright test --config playwright.site.config.ts` from `web/`. Chromium must be installed, or `OXA_BROWSER_EXECUTABLE` can name a compatible browser executable. Test browser profiles are isolated.

Native downloads, private promo films and the user's installed application profiles are separate from the browser application.
