# Oxa’s Library

An open-source, English-only iPhone app for your personal films, series and live TV. Connect sources you are authorized to use, resume episodes and save supported media offline.

[Download for iOS](https://github.com/Oxapayy/oxas-library/releases/latest) · [Website](https://oxas-library.netlify.app) · [Report an issue](https://github.com/Oxapayy/oxas-library/issues)

## iOS release

The release asset is **Oxas-Library-v1.2.0-iOS-unsigned.ipa**. It requires iOS 18 or later. Import it into ESign or another sideloading tool, sign using your own valid certificate and provisioning profile, then install. No certificate/profile is supplied. Use the same bundle identifier and signing identity when updating to retain local data and Keychain access.

macOS and Windows are **coming soon**. The current native app targets iPhone.

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

Local snapshots and journals use AES-GCM with a device-only Keychain key. Provider credentials are namespaced per account. Cloud source credentials are encrypted on-device with an AES-GCM random key wrapped using password-derived PBKDF2-SHA256; owner, record and generation are authenticated. RLS restricts records to their owner. Viewing metadata is not end-to-end encrypted; cloud identifiers are opaque hashes and playback URLs/headers/local paths are omitted.

A normal password change rewraps the same key. **Password recovery resets encrypted server connections** and requires reconnecting them; watchlist/history are retained. Account sync does not make a home server reachable remotely. Offline edits use a durable outbox and per-record server revisions. Downloads are never uploaded. No analytics SDK is included.

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

To self-host account services, apply `supabase/migrations/`, deploy `supabase/functions/delete-account`, configure Supabase Auth/custom SMTP with `supabase/templates/`, set your own project URL and **publishable** key in `CloudConfiguration.swift`, and enable `app_configuration.auth_emails_ready` after verifying delivery. Never put service-role or SMTP secrets in the app or repository. The hosted build's publishable project key is public configuration, not a privileged key. Accounts belong to the configured deployment.

The website is plain HTML/CSS/JavaScript in `website/`; `netlify.toml` publishes that folder. It uses original app screenshots and preview artwork, an interactive resume control, keyboard-accessible platform tabs and reduced-motion fallbacks.

## License and attribution

[MIT](LICENSE) for application code and original assets. Third-party package licenses and the TMDB brand-asset exception are listed in [NOTICE.md](NOTICE.md). Optional TMDB metadata uses the user's own API read token and displays required attribution. Protocol reference: [mHub v2](https://github.com/MediaHubMX/protocol). Native playback/offline reference: [Apple AVFoundation](https://developer.apple.com/documentation/avfoundation/using-avfoundation-to-play-and-persist-http-live-streams).

Please report reproducible issues with app version, iOS version, provider type and error text. Never include credentials, access tokens or private stream URLs.
