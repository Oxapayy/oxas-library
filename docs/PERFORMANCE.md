# Library responsiveness

The iOS client keeps each live collection observable independently. A download's byte counter does not invalidate the catalog or guide. Catalog lookups and guide/episode joins use indexes, local search and artwork decoding run away from the main actor, and decoded artwork has a 40 MiB cache and four workers. Episode rows are lazy. Progress publications are limited to four per second.

Encrypted snapshot and journal writes use one utility queue. Frequent writes coalesce without moving the first deadline indefinitely. Account transitions, background completion and explicit durability boundaries flush the latest state before releasing the old scope or the operating system's background handler. The persisted library format remains compatible with previous releases.

The shared desktop client builds catalog/guide joins once per publication, sends small progress patches, preserves unchanged DOM nodes and displays large collections in batches of 100. Progress saves are grouped; completion and account/quit boundaries remain durable. Storage failures retain dirty state and offer a retry rather than crashing or silently exiting. Artwork and active playback capabilities have separate lifetimes.

Provider metadata has finite response, aggregate and row limits. A source that repeats pages or exceeds an import limit produces a recoverable error instead of growing the library indefinitely. These limits apply to metadata, independently of supported video downloads. Provider URL globs are literal bounded matches, and season/episode values are validated before rendering.

## Validation

- `OXA_PROVIDER_FIXTURES=1 swift test` with `scripts/api-fixture-server.py` running exercises provider contracts, repeated-page rejection, large playlists/guides and parsing bounds.
- iOS app unit tests cover real encrypted persistence, coalescing/durability, observation independence, indexed lookups, artwork, search, cloud payload compatibility and background completion.
- iOS `PerformanceUITests` uses an isolated DEBUG fixture containing 20,500 media and 20,000 guide entries, with active transfer updates. It navigates all five tabs, searches films/series and channels, opens episode details and the guide, and verifies that progress continues changing. Test timing includes XCTest animation/idling overhead; it is a hang regression check, not a physical-device frame-rate measurement.
- `npm run typecheck`, `npm test`, `npm run test:ui` and `npm run test:interop` run in `desktop/`. Electron tests use separate temporary profiles and locally owned media. The large-library workflow contains 10,301 media and 9,000 guide entries during a real download, checks that poster nodes survive progress updates and records IPC/menu latency in `desktop/test-results/desktop-responsiveness.json`.
- Native macOS and Windows architecture checks run in the desktop GitHub Actions matrix. Source, tests and release artifacts must correspond to the same commit before publishing.

These tests do not certify every third-party provider, network connection or codec, and they do not modify a user's installed profile. Hosted account configuration is separate from client performance tests.
