# Oxa’s Library desktop

English-only macOS 14+ (Apple Silicon and Intel) and Windows 10/11 (x64 and ARM64) clients. The Windows NSIS installer selects the device architecture automatically. Installation packages are unsigned; macOS packages use an ad hoc signature and are not notarized.

## Build

Install Node.js 24, then run these commands in `desktop/`:

```sh
npm ci
npm run typecheck
npm test
npm start
```

A clean clone works as a guest. To enable your own account service, copy `../Config/Cloud.example.json` to `../Config/Cloud.local.json` and configure your HTTPS endpoint and publishable client key. Never use an admin/service-role key. The hosted backend implementation is private and is not included in this client repository.

```sh
npm run pack:mac  # run on macOS; produces Apple Silicon and Intel DMG/ZIP packages
npm run pack:win  # run on Windows; produces one x64/ARM64 installer
```

`npm run test:ui` launches real Electron playback with owned local video fixtures. Run `npm run test:interop` on macOS after `npm test` to check Swift interoperability. The CI workflow runs native checks on both architectures of macOS and Windows.

The isolated renderer cannot access Node.js, server credentials or external websites. Main-process requests validate network destinations and TLS, and the operating system protects local library storage. Optional account sync uses HTTPS and owner-restricted database records; it does not use a separate library password. Downloads stay on the device. Completed viewing history is retained for new-episode discovery on refresh. No push notifications or recordings are included.
