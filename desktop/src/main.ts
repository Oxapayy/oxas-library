import {
  app,
  BrowserWindow,
  protocol,
  ipcMain,
  Menu,
  dialog,
  shell,
  session,
  nativeTheme,
  clipboard,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Disk } from "./storage";
import { libraryView, mergeMedia } from "./library-view";
import { Provider } from "./providers";
import { Cloud } from "./cloud";
import { Downloads } from "./downloads";
import { MediaTransport } from "./media-transport";
import {
  empty,
  kinds,
  uuid,
  hash,
  cloudKey,
  appleNow,
  bounded,
  ordered,
  nextEpisode,
  episodeChanges,
  Media,
  Source,
  Credentials,
} from "./model";
import { urlCheck, local } from "./network";
import { metadataSearch } from "./metadata";
import { Updates } from "./updates";
protocol.registerSchemesAsPrivileged([
  {
    scheme: "oxa",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);
const testMode = !app.isPackaged && process.argv.includes("--test-mode");
if (testMode)
  app.setPath(
    "userData",
    process.env.OXA_TEST_HOME ||
      path.join(app.getPath("temp"), "oxa-desktop-tests"),
  );
let win: BrowserWindow, disk: Disk, cloud: Cloud, downloads: Downloads;
let updates: Updates | undefined;
const transport = new MediaTransport();
let active: any = null;
let refreshing = new Set<string>();
const sourceErrors = new Map<string, string>();
let artwork = new Map<string, string>();
let sourceChoices = new Map<string, any>();
const metadataChoices = new Map<string, any>();
let lastUpdate = 0;
const sourceAttempts = new Set<string>();
const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' oxa: data:; media-src 'self' oxa: blob:; connect-src 'self' oxa:; worker-src blob:; object-src 'none'; base-uri 'none'; frame-src 'none'; form-action 'none'";
const wireID = (id: string) => hash(id);
// Wire IDs are SHA-256 hashes. Index them once per media array instead of
// hashing the whole catalogue on every progress tick or detail lookup.
let wireIndex:
  | { media: Media[]; length: number; byID: Map<string, Media> }
  | undefined;
function item(id: string) {
  const media = disk.state.media;
  const build = () =>
    (wireIndex = {
      media,
      length: media.length,
      byID: new Map(media.map((m) => [wireID(m.id), m])),
    });
  if (
    !wireIndex ||
    wireIndex.media !== media ||
    wireIndex.length !== media.length
  )
    build();
  let indexed = wireIndex.byID.get(id);
  // Merges replace rows in place; rebuild once when the cached row went stale.
  if (indexed && !media.includes(indexed)) indexed = build().byID.get(id);
  const m =
    indexed ||
    disk.state.transfers.find(
      (t) => t.state === "ready" && wireID(t.media.id) === id,
    )?.media;
  if (!m)
    throw Error("This title is no longer in the library. Refresh its source.");
  return m;
}
function api(m: Media | Source) {
  const id = "sourceID" in m ? m.sourceID : m.id;
  const source = disk.state.sources.find((s) => s.id === id),
    credentials = disk.state.credentials[id];
  if (!source || !credentials) throw Error("Reconnect this media source.");
  return new Provider(source, credentials);
}
function art(raw: string, sourceID: string) {
  if (!raw) return undefined;
  const key = sourceID + raw;
  if (artwork.has(key)) return artwork.get(key);
  const source = disk.state.sources.find((s) => s.id === sourceID);
  if (!source) return undefined;
  const a = api(source);
  let headers = {};
  try {
    if (new URL(raw).origin === new URL(a.base).origin) headers = a.headers;
    const url = transport.artwork(raw, source, headers);
    artwork.set(key, url);
    return url;
  } catch {
    return undefined;
  }
}
function wire(m: Media) {
  return libraryView(disk.state, art).wire(m);
}
function view() {
  const projection = libraryView(disk.state, art);
  return {
    sources: disk.state.sources.map((s) => ({
      id: s.id,
      name: s.name,
      kind: s.kind,
      host: s.host,
      refreshedAt: s.refreshedAt,
      allowHTTP: s.allowHTTP,
      allowProviderFetch: s.allowProviderFetch,
      allowInsecureStreams: s.allowInsecureStreams,
      refreshing: refreshing.has(s.id),
      error: sourceErrors.get(s.id),
    })),
    media: projection.media(),
    programs: projection.programs(),
    transfers: projection.transfers(),
    preferences: disk.state.preferences,
    storageError: disk.saveError,
    hideWelcome: disk.read("ui", {}).hideWelcome || false,
    account: {
      email: cloud?.identity?.email,
      signedIn: !!cloud?.identity,
      unlocked: !!cloud?.ready,
      syncing: cloud?.syncing,
      message: cloud?.message,
      lastSync: cloud?.lastSync,
    },
    version: app.getVersion(),
    platform: process.platform,
    update:
      updates &&
      !(
        updates.status.state === "available" &&
        disk.read("ui", {}).skipUpdate === updates.status.version
      )
        ? updates.status
        : { state: "none" },
  };
}
type UpdateSection = "all" | "transfers" | "progress";
let updateTimer: ReturnType<typeof setTimeout> | undefined;
const pendingUpdates = new Set<UpdateSection>();
const pendingStatusIDs = new Set<string>();
function changed(section: UpdateSection = "all", mediaID?: string) {
  if (!win || win.isDestroyed() || !disk) return;
  pendingUpdates.add(section);
  if (mediaID) pendingStatusIDs.add(mediaID);
  if (!updateTimer)
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      if (!win || win.isDestroyed()) {
        pendingUpdates.clear();
        pendingStatusIDs.clear();
        return;
      }
      let payload: any;
      if (pendingUpdates.has("all")) payload = view();
      else {
        const projection = libraryView(disk.state, art);
        if (pendingUpdates.has("transfers"))
          for (const transfer of disk.state.transfers)
            pendingStatusIDs.add(transfer.media.id);
        payload = {
          partial: true,
          mediaUpdates: projection.status(pendingStatusIDs),
        };
        if (pendingUpdates.has("transfers"))
          payload.transfers = projection.transfers();
      }
      pendingUpdates.clear();
      pendingStatusIDs.clear();
      win.webContents.send("oxa:update", payload);
    }, 32);
  for (const id of sourceAttempts)
    if (!disk.state.sources.some((s) => s.id === id)) sourceAttempts.delete(id);
  for (const source of disk.state.sources)
    if (!sourceAttempts.has(source.id)) {
      sourceAttempts.add(source.id);
      queueMicrotask(() => void refresh(source.id));
    }
}
function scopeGuard(sourceID?: string) {
  const epoch = cloud.epoch,
    scope = disk.scope;
  return () => {
    if (
      epoch !== cloud.epoch ||
      scope !== disk.scope ||
      (sourceID && !disk.state.sources.some((s) => s.id === sourceID))
    )
      throw Error(
        "The account or source changed. Retry from your current library.",
      );
  };
}
function merge(items: Media[]) {
  mergeMedia(disk.state, items);
}
async function refresh(id: string) {
  if (refreshing.has(id)) return;
  const source = disk.state.sources.find((s) => s.id === id);
  if (!source) return;
  sourceAttempts.add(id);
  const epoch = cloud.epoch,
    scope = disk.scope;
  refreshing.add(id);
  sourceErrors.delete(id);
  changed();
  try {
    const provider = api(source);
    const result = await provider.catalog();
    if (
      epoch !== cloud.epoch ||
      scope !== disk.scope ||
      !disk.state.sources.some((s) => s.id === id)
    )
      return;
    const followed = disk.state.media.filter(
      (m) =>
        m.sourceID === id &&
        m.kind === "series" &&
        disk.state.media.some(
          (e) =>
            e.sourceID === id &&
            e.seriesID === m.providerID &&
            disk.state.progress[e.id]?.seconds > 0,
        ),
    );
    for (const series of followed.slice(0, 100)) {
      try {
        const episodes =
          series.websiteItem || source.kind === "Xtream Codes"
            ? await provider.episodes(series)
            : result.items.filter(
                (m) => m.kind === "episode" && m.seriesID === series.providerID,
              );
        if (epoch !== cloud.epoch || scope !== disk.scope) return;
        episodeChanges(disk.state, id, series.providerID, episodes);
        result.items.push(...episodes);
      } catch {
        /* Keep the last successful episode list when a provider is offline. */
      }
    }
    const resultIDs = new Set(result.items.map((m) => m.id));
    const oldEpisodes = disk.state.media.filter(
      (m) => m.sourceID === id && m.kind === "episode" && !resultIDs.has(m.id),
    );
    disk.state.media = disk.state.media.filter((m) => m.sourceID !== id);
    merge([...result.items, ...oldEpisodes]);
    disk.state.programs = disk.state.programs
      .filter((p) => p.sourceID !== id)
      .concat(result.programs);
    disk.state.pages = (disk.state.pages || [])
      .filter((p: any) => p.sourceID !== id)
      .concat(result.pages);
    source.refreshedAt = appleNow();
    if (result.warning) sourceErrors.set(id, result.warning);
    disk.state.credentials[id] = provider.credentials;
    disk.save();
    cloud.source(source);
  } catch {
    if (
      epoch === cloud.epoch &&
      scope === disk.scope &&
      disk.state.sources.some((s) => s.id === id)
    )
      sourceErrors.set(
        id,
        "Could not refresh this source. Check its address, login and network access. Cached titles are kept.",
      );
  } finally {
    refreshing.delete(id);
    changed();
  }
}
function sourceInput(args: any) {
  const allowed = new Set([
    "name",
    "kind",
    "endpoint",
    "username",
    "password",
    "token",
    "guideURL",
    "allowHTTP",
    "allowProviderFetch",
    "allowInsecureStreams",
  ]);
  for (const k of Object.keys(args))
    if (!allowed.has(k) && k !== "id") throw Error("Invalid source field.");
  if (
    !kinds.includes(args.kind) ||
    typeof args.name !== "string" ||
    !args.name.trim() ||
    args.name.length > 160
  )
    throw Error("Enter a source name and supported type.");
  for (const k of ["endpoint", "username", "password", "token", "guideURL"])
    if (
      args[k] != null &&
      (typeof args[k] !== "string" || args[k].length > 16384)
    )
      throw Error("Source details are too long.");
  const s: any = {
    id:
      typeof args.id === "string" && /^[0-9a-f-]{36}$/i.test(args.id)
        ? args.id
        : uuid(),
    name: args.name.trim(),
    kind: args.kind,
    allowHTTP: args.allowHTTP === true,
    allowProviderFetch: args.allowProviderFetch === true,
    allowInsecureStreams: args.allowInsecureStreams === true,
  };
  const url = urlCheck(String(args.endpoint), s, args.kind === "Video URL");
  s.host = url.host;
  const c: Credentials = {
    endpoint: url.href,
    username: args.username || "",
    password: args.password || "",
    token: args.token || "",
    userID: "",
    guideURL: args.guideURL || "",
  };
  if (c.guideURL) urlCheck(c.guideURL, s);
  return { s, c };
}
async function seasonRows(m: Media, season?: number) {
  if (m.websiteItem || api(m).source.kind === "Xtream Codes")
    return api(m).episodes(m, season);
  return ordered(
    disk.state.media.filter(
      (x) =>
        x.sourceID === m.sourceID &&
        x.seriesID === m.providerID &&
        x.kind === "episode" &&
        (season == null || x.season === season),
    ),
  );
}
async function detail(id: string) {
  let m = item(id);
  const guard = scopeGuard(m.sourceID);
  const result = await api(m).detail(m);
  guard();
  merge([result.media, ...result.episodes]);
  m = result.media;
  let episodes = disk.state.media.filter(
    (x) => x.sourceID === m.sourceID && x.seriesID === m.providerID,
  );
  if (
    m.kind === "series" &&
    !m.websiteItem &&
    ["Xtream Codes"].includes(api(m).source.kind)
  ) {
    episodes = await api(m).episodes(m);
    guard();
    merge(episodes);
  }
  disk.save();
  return {
    media: wire(m),
    episodes: ordered(episodes).map(libraryView(disk.state, art).wire),
    seasons: m.websiteItem?.seasons || [],
  };
}
async function playback(id: string, choiceID?: string, transferID?: string) {
  const m = item(id);
  const t = transferID
    ? disk.state.transfers.find(
        (t) => t.id === transferID && t.state === "ready",
      )
    : disk.state.transfers.find(
        (t) => cloudKey(t.media) === cloudKey(m) && t.state === "ready",
      );
  if (t) {
    transport.closePlayback();
    const root = path.join(disk.mediaRoot, hash(t.id));
    active = { media: m, choice: undefined };
    return {
      media: wire(m),
      url: transport.file(root, t.entry),
      format: t.format,
      caption: t.caption ? transport.file(root, "captions.vtt") : undefined,
      resume: disk.state.progress[m.id]?.completed
        ? 0
        : disk.state.progress[m.id]?.seconds || 0,
    };
  }
  if (m.id.startsWith("cloud:")) {
    const actual = disk.state.media.find(
      (x) => !x.id.startsWith("cloud:") && cloudKey(x) === cloudKey(m),
    );
    if (actual) return playback(wireID(actual.id), choiceID);
    throw Error(
      "Refresh or reconnect the original source to play this synced title.",
    );
  }
  const provider = api(m),
    guard = scopeGuard(m.sourceID);
  let prepared = m,
    choice: any;
  if (m.websiteItem) {
    if (choiceID) {
      const candidate = sourceChoices.get(choiceID);
      if (!candidate || candidate.mediaID !== m.id)
        throw Error("Source selection expired. Choose the server again.");
      choice = candidate.choice;
      prepared = candidate.media;
    } else {
      const all = await provider.sources(m);
      guard();
      merge([all.media]);
      sourceChoices.clear();
      const choices = all.sources.map((c: any) => {
        const token = uuid();
        sourceChoices.set(token, {
          mediaID: m.id,
          media: all.media,
          choice: c,
        });
        return {
          id: token,
          name: c.name,
          languages: c.languages,
          quality: c.quality,
          providerName: c.providerName,
          kind: c.kind,
        };
      });
      if (!choices.length)
        throw Error("No playback server is available for this title.");
      return { choices, media: wire(all.media) };
    }
  }
  const play = await provider.playback(
    prepared,
    choice,
    false,
    disk.state.preferences.subtitleLanguage,
  );
  guard();
  active = { media: play.media, choice: play.choice };
  merge([play.media]);
  transport.closePlayback();
  let caption;
  try {
    if (
      play.media.subtitleURL &&
      disk.state.preferences.subtitleLanguage !== "off"
    )
      caption = await transport.caption(
        play.media.subtitleURL,
        provider.source,
        play.headers,
      );
  } catch {}
  guard();
  disk.save();
  return {
    media: wire(play.media),
    url: transport.register(
      play.url,
      provider.source,
      play.headers,
      play.format,
    ),
    format:
      play.format ||
      (new URL(play.url).pathname.endsWith(".m3u8") ? "hls" : undefined),
    caption,
    resume: disk.state.progress[m.id]?.completed
      ? 0
      : disk.state.progress[m.id]?.seconds || 0,
  };
}
const actions = new Set([
  "state",
  "storage.retry",
  "source.add",
  "source.edit",
  "source.remove",
  "refresh",
  "detail",
  "season",
  "more",
  "search",
  "play",
  "next",
  "progress",
  "favorite",
  "download",
  "transfer.cancel",
  "transfer.retry",
  "transfer.delete",
  "preferences",
  "donation.copy",
  "welcome",
  "account",
  "signout",
  "sync",
  "deleteAccount",
  "downloadDirectory",
  "external",
  "fullscreen",
  "closePlayer",
  "caption.import",
  "metadata.token",
  "metadata.search",
  "metadata.apply",
  "licenses",
]);
async function execute(action: string, args: any = {}) {
  if (
    !actions.has(action) ||
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    JSON.stringify(args).length > 131072
  )
    throw Error("Invalid application request.");
  switch (action) {
    case "state":
      return view();
    case "storage.retry":
      disk.save();
      changed();
      return view();
    case "licenses":
      return fs.readFileSync(
        path.join(__dirname, "../assets/THIRD-PARTY-NOTICES.txt"),
        "utf8",
      );
    case "metadata.token": {
      const token = String(args.token || "").trim();
      if (token.length > 8192 || /[\r\n]/.test(token))
        throw Error("Invalid metadata access token.");
      disk.write("metadata-" + disk.scope, { token });
      disk.state.preferences.externalMetadata = !!token;
      disk.save();
      changed();
      return view();
    }
    case "metadata.search": {
      const m = item(args.id),
        guard = scopeGuard(),
        token = disk.read("metadata-" + disk.scope, {}).token;
      if (!disk.state.preferences.externalMetadata || !token)
        throw Error(
          "Add your TMDB read token in Settings before searching for metadata.",
        );
      const rows = await metadataSearch(m.title, m.kind, token);
      guard();
      metadataChoices.clear();
      return rows.map((row) => {
        const id = uuid();
        metadataChoices.set(id, { mediaID: m.id, fields: row });
        return { id, ...row, poster: art(row.poster, m.sourceID) };
      });
    }
    case "metadata.apply": {
      const m = item(args.id),
        choice = metadataChoices.get(args.choiceID);
      if (!choice || choice.mediaID !== m.id)
        throw Error("Metadata selection expired. Search again.");
      disk.state.metadata ??= {};
      disk.state.metadata[m.id] = choice.fields;
      Object.assign(m, choice.fields);
      disk.save();
      changed();
      return detail(args.id);
    }
    case "caption.import": {
      if (!active) throw Error("Start a video before adding subtitles.");
      const previous = active,
        guard = scopeGuard(),
        result = await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          filters: [{ name: "Subtitles", extensions: ["vtt", "srt"] }],
        });
      guard();
      if (result.canceled || active !== previous) return null;
      const file = result.filePaths[0];
      if (
        !/\.(vtt|srt)$/i.test(file) ||
        fs.statSync(file).size > 2 * 1024 * 1024
      )
        throw Error("Choose a VTT or SRT subtitle file smaller than 2 MB.");
      return {
        url: transport.captionText(await fs.promises.readFile(file, "utf8")),
      };
    }
    case "donation.copy": {
      const addresses = {
        bitcoin: "3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV",
        litecoin: "MTToUVnMpepWixDhUPBBG1SgdmxjifArwF",
      };
      if (!addresses[args.network]) throw Error("Unknown network.");
      clipboard.writeText(addresses[args.network]);
      return true;
    }
    case "source.add":
    case "source.edit": {
      const { s, c } = sourceInput(args);
      if (action === "source.add") {
        // Adding the same server again updates it instead of doubling the library.
        const same = (raw: string) => {
          try {
            const u = new URL(raw);
            return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, "");
          } catch {
            return raw;
          }
        };
        const existing = disk.state.sources.find(
          (x) =>
            x.kind === s.kind &&
            same(disk.state.credentials[x.id]?.endpoint || "") ===
              same(c.endpoint),
        );
        if (existing) {
          s.id = existing.id;
          disk.state.sources = disk.state.sources.filter((x) => x.id !== s.id);
        }
      }
      if (action === "source.edit") {
        const old = disk.state.sources.find((x) => x.id === s.id);
        if (!old) throw Error("Source no longer exists.");
        disk.state.sources = disk.state.sources.filter((x) => x.id !== s.id);
      }
      disk.state.sources.push(s);
      disk.state.credentials[s.id] = c;
      disk.save();
      cloud.source(s);
      void refresh(s.id);
      return view();
    }
    case "source.remove": {
      const s = disk.state.sources.find((x) => x.id === args.id);
      if (s) {
        cloud.source(s, true);
        disk.state.sources = disk.state.sources.filter((x) => x.id !== s.id);
        disk.state.media = disk.state.media.filter((x) => x.sourceID !== s.id);
        disk.state.programs = disk.state.programs.filter(
          (x) => x.sourceID !== s.id,
        );
        disk.state.pages = (disk.state.pages || []).filter(
          (x: any) => x.sourceID !== s.id,
        );
        delete disk.state.credentials[s.id];
        disk.save();
        artwork.clear();
        transport.forgetArtwork();
        changed();
      }
      return view();
    }
    case "refresh":
      for (const s of disk.state.sources)
        if (!args.id || args.id === s.id) void refresh(s.id);
      return view();
    case "detail":
      return detail(args.id);
    case "season": {
      const m = item(args.id),
        guard = scopeGuard(m.sourceID),
        rows = await seasonRows(m, Number(args.number));
      guard();
      merge(rows);
      disk.save();
      changed();
      return rows.map(libraryView(disk.state, art).wire);
    }
    case "more": {
      const guard = scopeGuard();
      for (const p of (disk.state.pages || []).filter((p: any) => p.cursor)) {
        const s = disk.state.sources.find((s) => s.id === p.sourceID);
        if (!s) continue;
        // One offline source must not stop the others from loading more.
        try {
          const provider = api(s);
          const result = await provider.page(p, await provider.discover());
          guard();
          merge(result.items);
          Object.assign(p, result.page);
        } catch (error) {
          guard();
          sourceErrors.set(
            s.id,
            "Could not load more from this source. Retry later.",
          );
        }
      }
      disk.save();
      changed();
      return view();
    }
    case "search": {
      const query = String(args.query || "")
        .trim()
        .slice(0, 200);
      if (query.length < 2) return [];
      const epoch = cloud.epoch,
        scope = disk.scope;
      const rows: Media[] = [];
      for (const s of disk.state.sources)
        try {
          rows.push(...(await api(s).search(query)));
        } catch {}
      if (epoch !== cloud.epoch || scope !== disk.scope) return [];
      merge(rows);
      disk.save();
      changed();
      return rows.map(libraryView(disk.state, art).wire);
    }
    case "play":
      return playback(args.id, args.choiceID, args.transferID);
    case "next": {
      if (!active) return null;
      const previous = active,
        guard = scopeGuard();
      let m = nextEpisode(disk.state.media, active.media);
      if (!m && active.media.websiteItem) {
        const parent = disk.state.media.find(
          (x) =>
            x.sourceID === active.media.sourceID &&
            x.providerID === active.media.seriesID &&
            x.kind === "series",
        );
        if (parent) {
          const number = parent.websiteItem?.seasons
            ?.filter((x: any) => x.number > (active.media.season || 0))
            .sort((a: any, b: any) => a.number - b.number)[0]?.number;
          if (number != null) {
            const rows = await api(parent).episodes(parent, number);
            guard();
            if (active !== previous) return null;
            merge(rows);
          }
          m = nextEpisode(disk.state.media, active.media);
        }
      }
      if (!m) return null;
      const prior = active.choice;
      if (m.websiteItem && prior) {
        const choices = await api(m).sources(m);
        guard();
        if (active !== previous) return null;
        const choice = choices.sources.find(
          (c) =>
            c.name === prior.name &&
            c.quality === prior.quality &&
            JSON.stringify(c.languages) === JSON.stringify(prior.languages),
        );
        if (choice) {
          const id = uuid();
          sourceChoices.set(id, {
            mediaID: m.id,
            media: choices.media,
            choice,
          });
          return playback(wireID(m.id), id);
        }
      }
      return playback(wireID(m.id));
    }
    case "progress": {
      const m = item(args.id),
        seconds = bounded(args.seconds),
        duration = bounded(args.duration);
      if (m.kind === "episode" && m.seriesID) {
        disk.state.followedSeries ??= {};
        const identity = m.sourceID + ":" + m.seriesID;
        disk.state.followedSeries[identity] ??= disk.state.media
          .filter(
            (e) =>
              e.sourceID === m.sourceID &&
              e.seriesID === m.seriesID &&
              e.kind === "episode",
          )
          .map((e) => e.id);
        disk.state.newEpisodeIDs = (disk.state.newEpisodeIDs || []).filter(
          (id) => id !== m.id,
        );
      }
      disk.state.progress[m.id] = {
        seconds,
        duration,
        completed:
          args.ended === true ||
          (duration > 0 && seconds >= duration - Math.min(30, duration * 0.03)),
        playedAt: appleNow(),
      };
      disk.saveSoon();
      cloud.progress(m);
      if (Date.now() - lastUpdate > 2500) {
        lastUpdate = Date.now();
        changed("progress", m.id);
      }
      return true;
    }
    case "favorite": {
      const m = item(args.id),
        present = !disk.state.favorites.includes(m.id);
      disk.state.favorites = disk.state.favorites.filter((x) => x !== m.id);
      if (present) disk.state.favorites.push(m.id);
      disk.save();
      cloud.watchlist(m, present);
      changed();
      return view();
    }
    case "download": {
      const parent = item(args.id),
        guard = scopeGuard(parent.sourceID);
      const rows =
        args.season != null
          ? await seasonRows(parent, Number(args.season))
          : [parent];
      guard();
      if (!rows.length)
        throw Error("No episodes are available in this season.");
      merge(rows);
      const m = rows[0];
      let selected: any;
      if (m.websiteItem) {
        const candidate = sourceChoices.get(args.choiceID);
        if (!candidate || candidate.mediaID !== m.id) {
          const result = await playback(wireID(m.id));
          return { ...result, download: true, season: args.season };
        }
        selected = candidate.choice;
      }
      downloads.add(rows, selected);
      return { queued: true };
    }
    case "transfer.cancel":
      downloads.cancel(args.id);
      return view();
    case "transfer.retry":
      downloads.retry(args.id);
      return view();
    case "transfer.delete":
      downloads.delete(args.id);
      return view();
    case "preferences": {
      const p = disk.state.preferences;
      if (args.audioLanguage && ["en", "de"].includes(args.audioLanguage))
        p.audioLanguage = args.audioLanguage;
      if (
        args.subtitleLanguage &&
        ["en", "de", "off"].includes(args.subtitleLanguage)
      )
        p.subtitleLanguage = args.subtitleLanguage;
      if (typeof args.autoplay === "boolean") p.autoplay = args.autoplay;
      disk.save();
      cloud.preferences();
      changed();
      return view();
    }
    case "welcome":
      disk.write("ui", { ...disk.read("ui", {}), hideWelcome: !!args.hide });
      return true;
    case "account": {
      const r = await cloud.auth(String(args.action), args);
      disk.save();
      changed();
      if (cloud.ready) for (const s of disk.state.sources) void refresh(s.id);
      return r;
    }
    case "signout":
      await cloud.signout();
      return view();
    case "sync":
      await cloud.sync();
      for (const s of disk.state.sources)
        if (
          !disk.state.media.some(
            (m) => m.sourceID === s.id && !m.id.startsWith("cloud:"),
          )
        )
          void refresh(s.id);
      return view();
    case "deleteAccount":
      await cloud.deleteAccount(String(args.password || ""));
      return view();
    case "downloadDirectory": {
      if (
        downloads.running ||
        disk.state.transfers.some(
          (t) => t.state === "queued" || t.state === "downloading",
        )
      )
        throw Error(
          "Finish or cancel active downloads before moving the download folder.",
        );
      const guard = scopeGuard(),
        oldRoot = disk.mediaRoot;
      const result = await dialog.showOpenDialog(win, {
        properties: ["openDirectory", "createDirectory"],
      });
      if (!result.canceled) {
        guard();
        const target = path.join(
          result.filePaths[0],
          "Oxa-Library-Downloads",
          disk.scope,
        );
        if (path.resolve(target) === path.resolve(oldRoot)) return view();
        if (path.resolve(target).startsWith(path.resolve(oldRoot) + path.sep))
          throw Error(
            "Choose a download folder outside the current download directory.",
          );
        if (fs.existsSync(target) && fs.readdirSync(target).length)
          throw Error(
            "This download folder already contains data. Choose an empty location.",
          );
        await fs.promises.cp(oldRoot, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
        });
        guard();
        disk.state.preferences.downloadDirectory = result.filePaths[0];
        disk.save();
        await fs.promises.rm(oldRoot, { recursive: true, force: true });
        changed();
      }
      return view();
    }
    case "update.check": {
      if (!updates) throw Error("Updates are unavailable in this build.");
      if (args.manual)
        disk.write("ui", { ...disk.read("ui", {}), skipUpdate: undefined });
      await updates.check();
      if (updates.checkFailed)
        throw Error("Could not check for updates. Check your connection.");
      return view();
    }
    case "update.download":
      void updates?.download();
      return view();
    case "update.install": {
      if (!updates?.installer || !fs.existsSync(updates.installer))
        throw Error("Download the update again.");
      const failure = await shell.openPath(updates.installer);
      if (failure) throw Error("The installer could not be opened.");
      // The Windows installer replaces the running app, so close it first.
      // On macOS the disk image opens in Finder for dragging into Applications.
      if (process.platform === "win32") setTimeout(() => app.quit(), 1500);
      return true;
    }
    case "update.skip":
      disk.write("ui", {
        ...disk.read("ui", {}),
        skipUpdate: updates?.status.version,
      });
      return view();
    case "external": {
      const targets: any = {
        website: "https://oxapay.cc",
        github: "https://github.com/Oxapayy/oxas-library",
        release: `https://github.com/Oxapayy/oxas-library/releases/tag/desktop-v${app.getVersion()}`,
        updateNotes: updates?.offer?.notes,
      };
      if (targets[args.target]) await shell.openExternal(targets[args.target]);
      return true;
    }
    case "fullscreen":
      win.setFullScreen(!win.isFullScreen());
      return win.isFullScreen();
    case "closePlayer":
      active = null;
      transport.closePlayback();
      return true;
  }
}
function createWindow() {
  win = new BrowserWindow({
    width: 1300,
    height: 880,
    minWidth: 680,
    minHeight: 520,
    title: "Oxa’s Library",
    backgroundColor: "#00000000",
    titleBarStyle: "hiddenInset",
    ...(process.platform === "darwin"
      ? {
          vibrancy: "under-window" as const,
          visualEffectState: "active" as const,
        }
      : {
          backgroundMaterial: "acrylic" as const,
          titleBarOverlay: {
            color: "#00000000",
            symbolColor: "#ffffff",
            height: 42,
          },
        }),
    icon: path.join(__dirname, "../assets/icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== "oxa://app/index.html") event.preventDefault();
  });
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  void win.loadURL("oxa://app/index.html");
  win.on("closed", () => {
    win = undefined;
  });
}
app.whenReady().then(async () => {
  try {
    nativeTheme.themeSource = "dark";
    disk = new Disk(app.getPath("userData"), testMode, () => changed());
    cloud = new Cloud(
      disk,
      () => {
        downloads?.suspend();
        refreshing.clear();
        sourceAttempts.clear();
        sourceErrors.clear();
        transport.forget();
        artwork.clear();
        sourceChoices.clear();
        metadataChoices.clear();
        active = null;
      },
      changed,
    );
    downloads = new Downloads(
      disk,
      (m) => api(m),
      () => changed("transfers"),
    );
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_w, permission, cb) =>
      cb(permission === "fullscreen"),
    );
    ses.setPermissionCheckHandler(
      (_w, permission) => permission === "fullscreen",
    );
    ses.webRequest.onBeforeRequest(
      { urls: ["http://*/*", "https://*/*", "file://*/*"] },
      (_details, callback) => callback({ cancel: true }),
    );
    protocol.handle("oxa", async (req) => {
      const u = new URL(req.url);
      if (u.hostname === "media" || u.hostname === "caption") {
        if (
          req.headers.get("origin") &&
          !["oxa://app"].includes(req.headers.get("origin"))
        )
          return new Response(null, { status: 403 });
        const response =
          req.method === "OPTIONS"
            ? new Response(null, { status: 204 })
            : u.hostname === "media"
              ? await transport.handle(req)
              : transport.captionResponse(req);
        response.headers.set("Access-Control-Allow-Origin", "oxa://app");
        response.headers.set("Access-Control-Allow-Headers", "Range");
        response.headers.set(
          "Access-Control-Allow-Methods",
          "GET,HEAD,OPTIONS",
        );
        return response;
      }
      if (u.hostname !== "app") return new Response(null, { status: 404 });
      const allowed: any = {
        "/index.html": ["index.html", "text/html"],
        "/app.css": ["app.css", "text/css"],
        "/renderer.js": ["renderer.js", "application/javascript"],
      };
      const e = allowed[u.pathname];
      if (!e) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(path.join(__dirname, e[0])), {
        headers: {
          "Content-Type": e[1],
          "Content-Security-Policy": csp,
          "X-Content-Type-Options": "nosniff",
        },
      });
    });
    ipcMain.handle("oxa:command", async (event, action, args) => {
      if (
        !win ||
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== "oxa://app/index.html"
      )
        return { error: "Untrusted application frame." };
      try {
        return { value: await execute(action, args) };
      } catch (e: any) {
        const safe =
          /password|code|email|sign|invalid|at least|encrypted|source|server|download|stream|HTTPS|HTTP|library|provider|format|connect|network|account|recovery/i.test(
            e.message || "",
          ) && !/https?:\/\/|[?&](token|password|key)=/i.test(e.message || "")
            ? e.message
            : "This operation could not complete. Retry or reconnect the source.";
        return { error: safe };
      }
    });
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: "appMenu" },
        {
          label: "File",
          submenu: [
            {
              label: "Add Source",
              accelerator: "CmdOrCtrl+N",
              click: () => win?.webContents.send("oxa:action", "add-source"),
            },
            {
              label: "Refresh Library",
              accelerator: "CmdOrCtrl+R",
              click: () => {
                for (const s of disk.state.sources) void refresh(s.id);
              },
            },
          ],
        },
        { role: "editMenu" },
        {
          label: "View",
          submenu: [
            { role: "togglefullscreen" },
            { role: "zoomIn" },
            { role: "zoomOut" },
            { role: "resetZoom" },
          ],
        },
        { role: "windowMenu" },
        {
          label: "Help",
          submenu: [
            {
              label: "Check for Updates…",
              click: () => win?.webContents.send("oxa:action", "check-updates"),
            },
            {
              label: "Source Code",
              click: () =>
                void shell.openExternal(
                  "https://github.com/Oxapayy/oxas-library",
                ),
            },
          ],
        },
      ]),
    );
    const restoring = cloud.boot();
    createWindow();
    await restoring;
    for (const s of disk.state.sources) void refresh(s.id);
    setInterval(() => void cloud.sync(), 60000);
    if (!testMode) {
      updates = new Updates(
        app.getVersion(),
        () => app.getPath("downloads"),
        () => changed(),
      );
      setTimeout(() => void updates?.check(), 10000);
      setInterval(() => void updates?.check(), 6 * 60 * 60 * 1000);
    }
    setInterval(
      () => {
        for (const s of disk.state.sources) void refresh(s.id);
      },
      15 * 60 * 1000,
    );
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) createWindow();
    });
  } catch {
    dialog.showErrorBox(
      "Oxa’s Library",
      "The encrypted library could not be opened. Check operating-system credential storage and available disk space. Your saved files were not deleted.",
    );
    app.quit();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("before-quit", (event) => {
  downloads?.suspend();
  try {
    disk?.save();
  } catch {
    event.preventDefault();
    dialog.showErrorBox(
      "Could not save your library",
      "Check free disk space and folder permissions, then quit again. The app remains open so your latest changes can be saved.",
    );
  }
});
