# Oxa’s Library

An open-source, English-only iPhone app for your personal films, series and live TV. Connect sources you are authorized to use, resume episodes and save supported media offline.

[Download for iOS](https://github.com/Oxapayy/oxas-library/releases/tag/v1.2.0) · [Website](https://oxas-library.netlify.app) · [Report an issue](https://github.com/Oxapayy/oxas-library/issues)

## iOS release

The release asset is **Oxas-Library-v1.2.0-iOS-unsigned.ipa**. It requires iOS 18 or later. Import it into ESign or another sideloading tool, sign using your own valid certificate and provisioning profile, then install. No certificate/profile is supplied. Use the same bundle identifier and signing identity when updating to retain local data and Keychain access.

The shared macOS and Windows client source is in `desktop/`. Desktop installation packages are being prepared; the iOS release above remains available.

## What it does

- Combined film/series library, Continue Watching, watchlist and per-episode progress.
- Full-screen video surface across portrait/landscape, Fit/Fill, seeking, audio/subtitle selection, playback speed, AirPlay and Picture in Picture where supported.
- Manual Next episode and cancellable five-second countdown. Uses supplied credits start when available; otherwise prompts in the last 2% of the episode, capped at 30 seconds and at least five seconds. This is a timing fallback, not visual credits recognition.
- Select website playback servers by name, language and quality; retry refreshes stream metadata.
- Film, individual episode and season downloads over Wi-Fi/cellular where the provider supplies a compatible permitted file or VOD HLS stream. Downloaded videos remain local.
- Separate IPTV tab, channel/program search and XMLTV guide. Live recording is not included.
- Optional email/password account and verification/recovery codes through Supabase Auth/custom SMTP. Server connections, watchlist, progress and preferences sync between devices. Guest use remains available; startup prompt has a persistent “Don’t show this message again” option.

## Sources

| Type | Connection |
| --- | --- |
| Jellyfin / Emby | Reachable server URL, username/password; returned session stored in Keychain |
| Plex | Direct server URL and authorized Plex token |
| WebDAV | NAS media-folder URL, optional Basic authentication |
| Video URL | One direct supported video file or HLS link |
| M3U / Xtream Codes | Authorized playlist/provider URL; optional XMLTV guide |
| mHub v2 library | Supported website/addon catalog; setup suggests huhu.to without connecting automatically |

Catalog availability does not guarantee stream availability. huhu.to and all provider names remain the property of their operators. Provider access, codecs and offline permissions can change. The app does not execute provider scripts, implement DRM bypasses or solve interactive browser challenges. No films, channel packages or subscriptions are bundled.

HTTPS is required for public server/API connections. Trusted local HTTP can be enabled per source. **Allow HTTP streams** is a separate, default-off permission for unencrypted media links; it does not allow public HTTP login/catalog endpoints. Invalid/self-signed HTTPS certificates remain rejected. Provider-assisted requests require separate consent and never receive Oxa account tokens or stored server credentials.

## Privacy and sync

Local snapshots and journals use AES-GCM with a device-only Keychain key. Provider credentials are namespaced per account. Account sync transfers source credentials over HTTPS and restricts database access to the signed-in owner with RLS. Server credentials are no longer end-to-end encrypted or tied to the account password. Local device encryption remains enabled. Viewing metadata uses opaque cloud identifiers and omits playback URLs/headers/local paths.

Password changes and recovery preserve sources, watchlist and history. Updating an existing device migrates its readable legacy connections automatically. Older encrypted connections that are absent locally cannot be recovered without their original password/key; their records are preserved, never reset automatically. Account sync does not make a home server reachable remotely. Offline edits use a durable outbox and per-record server revisions. Downloads are never uploaded. No analytics SDK is included.

## Build and test

Requirements: macOS, Xcode with iOS SDK, XcodeGen, Python 3 for local fixtures. Supabase Swift SDK is pinned in `project.yml`.

```sh
xcodegen generate
./scripts/build-ipa.sh
```

This generates `build/Oxas-Library-unsigned.ipa`. Device signing is disabled. For simulator tests, use ad-hoc signing:

```sh
python3 scripts/fixture-server.py
# separate terminal
python3 scripts/api-fixture-server.py
# separate terminal
OXA_PROVIDER_FIXTURES=1 swift test
xcodebuild -project OxasLibrary.xcodeproj -scheme OxasLibrary \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro Max' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=- test
```

Fixture credentials are local examples. The generated 24-second video in `scripts/fixtures` is not bundled in the app. Swift core tests run without provider fixtures unless `OXA_PROVIDER_FIXTURES=1` is explicitly set. Production builds have no local provider-fetch exception.

This repository contains the client application, not the hosted backend implementation, database migrations or email-service configuration. Account services are optional. A source build works in guest mode by default. Copy `Config/Cloud.example.json` to `Config/Cloud.local.json` and supply an HTTPS project URL and public publishable/anonymous client key for your compatible account deployment. For iOS, also copy this private file to `Resources/Cloud.local.json` before generating the Xcode project. Both local files are ignored by Git. The desktop build also accepts `OXA_CLOUD_URL` and `OXA_CLOUD_PUBLIC_KEY` environment variables. Never use service-role, SMTP or administrator keys. Hosted release binaries necessarily contain their public connection values; these are not secret credentials.

### Desktop source builds

Use Node.js 24 and npm. The account backend is optional and excluded from this repository; a clean clone runs in guest mode. The same private `Config/Cloud.local.json` described above can configure a compatible account deployment.

```sh
cd desktop
npm ci
npm run typecheck
npm test
npm run test:ui
npm start
```

Build macOS packages on macOS with `npm run pack:mac`; build the combined x64/ARM64 Windows installer on Windows with `npm run pack:win`. The desktop GitHub Actions workflow tests macOS Apple Silicon/Intel and Windows x64/ARM64. Its manual package job uses privately stored public client connection values for official hosted builds. No backend implementation or administrator credentials are packaged.

macOS packages target version 14 and later. Windows packages target Windows 10/11 on x64 and ARM64. Releases have no publisher signing certificate or Apple notarization. macOS uses technical ad-hoc signing. Platform installation warnings are expected. Compatible codecs and source access still depend on the server; no universal provider or format claim is made.

The website is plain HTML/CSS/JavaScript in `website/`; `netlify.toml` publishes that folder. It uses real iPhone screenshots supplied by the project owner, an interactive screenshot selector and full-size viewer, keyboard-accessible platform tabs, requested translucent glass materials and reduced-motion/transparency fallbacks.

## License and attribution

[MIT](LICENSE) for application code and original assets. Third-party package licenses and the TMDB brand-asset exception are listed in [NOTICE.md](NOTICE.md). Optional TMDB metadata uses the user's own API read token and displays required attribution. Protocol reference: [mHub v2](https://github.com/MediaHubMX/protocol). Native playback/offline reference: [Apple AVFoundation](https://developer.apple.com/documentation/avfoundation/using-avfoundation-to-play-and-persist-http-live-streams).

Please report reproducible issues with app version, iOS version, provider type and error text. Never include credentials, access tokens or private stream URLs.

## Support development

Donations are optional. All app features remain free. Use the matching network.

- Bitcoin (BTC): `3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV`
- Litecoin (LTC): `MTToUVnMpepWixDhUPBBG1SgdmxjifArwF`
