# Oxa’s Library — Web blueprint

Status: final concept. The owner confirmed the existing Netlify hosting at oxapay.cc/web. The owner approved implementation and publication with Go.

## Product

An English-only browser version of Oxa’s Library with the existing apps’ black, translucent glass interface. Proposed URL: `https://oxapay.cc/web/`. The existing marketing website and native-app download links remain available separately.

The browser app has four navigation destinations: Library, Search, IPTV and Settings. It has no Downloads tab, download buttons, season-download controls, transfer queue or offline media storage.

## User flow

1. Open the web app. Restore the local browser profile and any existing Oxa session without blocking navigation.
2. Resolve the existing synced sources first. Automatically connect the huhu library when no equivalent source already exists. Match normalized provider URL/type and retain existing source UUIDs to avoid duplicate imports across devices.
3. Display the real provider catalog with posters, movie/series filters, source filters, Watchlist, Continue Watching and New Episodes. Keep the first connection/loading state visible and provide Retry on failure.
4. Show the optional English sign-in/register prompt under the same rules as the apps. Guest use and “Don’t show this message again” remain available.
5. Search films and series without listing every episode as a separate top-level search result. Open a series, choose a season and play or resume an episode.
6. Offer the provider’s available playback servers, preserving progress when switching or retrying. Support fullscreen, Fit/Fill, seeking, playback speed, volume, available audio tracks and English/German subtitles. Offer Picture in Picture where the browser supports it.
7. Provide manual Next episode and the existing cancellable three-second autoplay countdown. Use provider credits timing where available and the apps’ existing end-of-episode fallback otherwise.
8. Save viewing position, watched status and watchlist changes locally; sync through the same Oxa account when signed in. Password recovery preserves history, watchlist and server connections.
9. Use the separate IPTV page for channel search, favorites, groups and the XMLTV program guide. No recordings or push notifications.
10. Manage sources, playback preferences, account and the existing quiet Support Oxa section in Settings. Removing the default huhu source is respected; refresh must not silently add it again.

## Technology and hosting

- Public TypeScript web client. Reuse the desktop renderer, playback behavior, CSS, media schema and indexed library projection through explicit browser capabilities/adapters.
- Browser command bridge replaces Electron IPC. Fullscreen, caption-file selection and Picture in Picture use browser APIs.
- Browser IndexedDB stores account-scoped metadata, progress, favorites, source settings and the durable sync outbox. Writes, catalog processing and search remain asynchronous and bounded.
- The existing Supabase email/password account, confirmation/recovery codes and account-v2 sync protocol are reused. No Apple/Google sign-in, backend-schema reset or new account system.
- Keep account UUID, local state and outbox coherent through failed writes and account transitions. Freeze the checked owner/token pair for every sync request and discard stale replies after scope changes.
- A private same-origin provider gateway is necessary: the currently checked huhu mHub manifest does not permit direct browser fetches. Reuse provider parsing and the existing bounded network policy behind that gateway.
- Keep gateway implementation, signing secrets, private deployment configuration and hosted backend sources outside public Git and outside the static publish directory. Public source contains example configuration only; browser builds necessarily contain public client connection values.
- Hosting is the existing Netlify site at `https://oxapay.cc/web/`, confirmed by the owner. No paid upgrade or new subscription is authorized by this blueprint.

## Playback constraints and security

- Prefer browser-compatible HTTPS playback. Provider access and browser codec support still determine whether a specific stream can play.
- A Netlify function cannot relay an entire long video or indefinite live stream as one response. Use bounded validated Range requests for compatible progressive files and bounded manifest/segment handling for HLS. Do not ship a full-film proxy that is truncated by function limits.
- A source that needs indefinite raw MPEG-TS proxying may require a persistent streaming gateway rather than serverless functions. This must be reported as a compatibility limitation unless suitable hosting is provided.
- An HTTPS page cannot promise access to plain-HTTP LAN servers. A hosted gateway cannot reach a user's private home LAN. Show an actionable connection error; never bypass TLS or browser network protections.
- Enforce public-address validation/DNS pinning, redirect credential isolation, response/import budgets and XML protections in the hosted gateway. Deny loopback, metadata and private network destinations there.
- Use short-lived opaque/signed media capabilities, same-origin checks and rate limits. Do not expose an unrestricted URL proxy or put provider passwords/account tokens in public query parameters.
- Never send Oxa account tokens or unrelated server credentials to a library provider. Provider-assisted resolution retains its separate source consent.
- Apply a route-specific CSP for the actual account/API/media/image/caption/worker paths. Preserve strict policy on the marketing site.
- No service worker or cache stores video bytes for offline use. Browser metadata persistence is separate from offline media downloading.

## Verification and release gates

- Real populated provider-catalog check, default-source deduplication and fresh/reload/signed-in/guest states.
- Browser tests for all four tabs, movie/series-only search, series/season details, watchlist, resume persistence, New Episodes, source removal and responsive layouts.
- Owned fixture-media tests for MP4 Range playback, HLS manifests/segments, subtitles, seeking, fullscreen, manual Next and autoplay cancellation. A successful catalog import alone does not prove playback.
- Account tests for durable outbox, scope isolation, offline edits, sign-out failures, code verification/recovery and frozen-token sync; no history deletion on password reset.
- Large-library navigation test while metadata/progress updates continue. Do not weaken the native apps’ existing tests or alter their installed profiles.
- Gateway tests for private-address/redirect rejection, header isolation, capability expiry, range bounds and rate limits. Inspect the deployed CSP and actual response-size behavior.
- Publish only after functional checks pass; then add “Open Web App” to the main website and verify the live route. Existing private promo videos must remain absent.

## Implementation approval

The owner selected the existing Netlify hosting at `oxapay.cc/web/`. Implementation and publication were approved with Go. No separate paid server or hosting upgrade is approved.
