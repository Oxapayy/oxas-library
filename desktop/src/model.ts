import { createHash, randomUUID } from "node:crypto";
export const kinds = [
  "Library URL",
  "Jellyfin",
  "Emby",
  "Plex",
  "NAS / WebDAV",
  "Video URL",
  "M3U playlist",
  "Xtream Codes",
];
export type Media = {
  id: string;
  sourceID: string;
  providerID: string;
  title: string;
  kind: string;
  overview: string;
  duration: number;
  [key: string]: any;
};
export type Source = {
  id: string;
  name: string;
  kind: string;
  host: string;
  allowHTTP: boolean;
  allowProviderFetch?: boolean;
  allowInsecureStreams?: boolean;
  [key: string]: any;
};
export type Credentials = {
  endpoint: string;
  username: string;
  password: string;
  token: string;
  userID: string;
  guideURL: string;
};
export type Snapshot = {
  sources: Source[];
  credentials: Record<string, Credentials>;
  media: Media[];
  progress: Record<string, any>;
  favorites: string[];
  programs: any[];
  transfers: any[];
  preferences: any;
  journal: any;
  [key: string]: any;
};
export const uuid = () => randomUUID().toUpperCase();
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const appleNow = () => Date.now() / 1000 - 978307200;
export const appleDate = (value: string) =>
  Date.parse(value) / 1000 - 978307200;
// Ordinals arrive from untrusted provider JSON and sometimes use numeric
// strings. Reject markup, objects, fractions and unreasonable episode indexes.
export function ordinal(value: unknown): number | undefined {
  if (
    typeof value !== "number" &&
    !(typeof value === "string" && /^\d{1,6}$/.test(value))
  )
    return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 100000
    ? number
    : undefined;
}
export const bounded = (n: any) =>
  Number.isFinite(Number(n)) ? Math.max(0, Math.min(31536000, Number(n))) : 0;
export function empty(): Snapshot {
  return {
    sources: [],
    credentials: {},
    media: [],
    progress: {},
    favorites: [],
    programs: [],
    transfers: [],
    preferences: {
      autoplay: true,
      cellular: true,
      audioLanguage: "en",
      subtitleLanguage: "en",
      externalMetadata: false,
    },
    journal: { cursor: 0, revisions: {}, pending: {} },
  };
}
export function media(
  source: Source,
  id: any,
  title: any,
  kind = "movie",
): Media {
  return {
    id: `${source.id}:${id}`,
    sourceID: source.id,
    providerID: String(id),
    title: String(title || "Untitled"),
    kind,
    overview: "",
    duration: 0,
    subtitleDelay: 0,
  };
}
export function cloudKey(m: Media) {
  if (/^[a-f0-9]{64}$/i.test(m.cloudIdentity || "")) return m.cloudIdentity;
  const ref = m.websiteItem;
  const ns = ["tmdb", "imdb"].find((k) => ref?.ids?.[k]);
  return hash(
    ns
      ? `${m.kind}:${ns}:${ref.ids[ns]}`
      : `${m.sourceID}:${m.providerID}:${m.kind}`,
  );
}
export function cloudMedia(m: Media) {
  const copy: Media = { subtitleDelay: 0, ...m },
    identity = cloudKey(m);
  if (!m.cloudIdentity) {
    copy.id = `cloud:${identity}`;
    copy.providerID = hash(m.providerID);
    if (m.seriesID) copy.seriesID = hash(m.seriesID);
  }
  copy.cloudIdentity = identity;
  for (const k of [
    "stream",
    "poster",
    "backdrop",
    "subtitleURL",
    "subtitlePath",
    "playbackHeaders",
    "websiteResolved",
    "streamFormat",
    "websiteItem",
    "downloadPreference",
    "channelID",
  ])
    delete copy[k];
  return copy;
}
export function cloudInput(raw: any): Media {
  if (
    !raw ||
    !["movie", "series", "episode", "channel"].includes(raw.kind) ||
    !/^[0-9a-f-]{36}$/i.test(raw.sourceID) ||
    !/^[a-f0-9]{64}$/i.test(raw.cloudIdentity || "")
  )
    throw Error("Invalid synced library metadata.");
  const identity = raw.cloudIdentity;
  const result: Media = {
    id: "cloud:" + identity,
    sourceID: raw.sourceID.toUpperCase(),
    providerID: /^[a-f0-9]{64}$/i.test(raw.providerID)
      ? raw.providerID
      : hash(String(raw.providerID || "")),
    title: String(raw.title || "Untitled").slice(0, 512),
    kind: raw.kind,
    overview: String(raw.overview || "").slice(0, 20000),
    duration: bounded(raw.duration),
    subtitleDelay: 0,
    cloudIdentity: identity,
  };
  if (Number.isFinite(raw.year))
    result.year = Math.max(1800, Math.min(3000, Math.floor(raw.year)));
  if (raw.seriesID)
    result.seriesID = /^[a-f0-9]{64}$/i.test(raw.seriesID)
      ? raw.seriesID
      : hash(String(raw.seriesID));
  if (raw.seriesTitle)
    result.seriesTitle = String(raw.seriesTitle).slice(0, 512);
  for (const key of ["season", "episode"])
    if (Number.isFinite(raw[key]))
      result[key] = Math.max(0, Math.min(100000, Math.floor(raw[key])));
  return result;
}
export const ordered = (items: Media[]) =>
  items.sort(
    (a, b) =>
      (a.season || 0) - (b.season || 0) ||
      (a.episode || 0) - (b.episode || 0) ||
      a.title.localeCompare(b.title),
  );
export function nextEpisode(items: Media[], m: Media) {
  return ordered(
    items.filter(
      (x) =>
        x.sourceID === m.sourceID &&
        x.seriesID &&
        x.seriesID === m.seriesID &&
        x.kind === "episode",
    ),
  ).find(
    (x) =>
      (x.season || 0) > (m.season || 0) ||
      (x.season === m.season && (x.episode || 0) > (m.episode || 0)),
  );
}
export const nextThreshold = (duration: number, credits?: number) =>
  Number.isFinite(credits) && credits > duration / 2 && credits < duration
    ? credits
    : Math.max(0, duration - Math.max(5, Math.min(30, duration * 0.02)));

// Completed progress remains in the library so a series stays followed.
export function episodeChanges(
  state: Snapshot,
  sourceID: string,
  seriesID: string,
  episodes: Media[],
) {
  state.followedSeries ??= {};
  state.newEpisodeIDs ??= [];
  const identity = sourceID + ":" + seriesID;
  const watched = state.media.filter(
    (m) =>
      m.sourceID === sourceID &&
      m.seriesID === seriesID &&
      m.kind === "episode" &&
      state.progress[m.id]?.seconds > 0,
  );
  if (!watched.length && !state.followedSeries[identity]) return;
  const prior: string[] =
    state.followedSeries[identity] ||
    state.media
      .filter(
        (m) =>
          m.sourceID === sourceID &&
          m.seriesID === seriesID &&
          m.kind === "episode",
      )
      .map((m) => m.id);
  const highest = Math.max(
    0,
    ...watched.map((m) => (m.season || 0) * 100000 + (m.episode || 0)),
  );
  const added = episodes.filter(
    (m) =>
      !prior.includes(m.id) &&
      !state.progress[m.id]?.seconds &&
      (m.season == null ||
        m.episode == null ||
        m.season * 100000 + m.episode > highest),
  );
  state.newEpisodeIDs = [
    ...new Set([...state.newEpisodeIDs, ...added.map((m) => m.id)]),
  ];
  state.followedSeries[identity] = [
    ...new Set([...prior, ...episodes.map((m) => m.id)]),
  ];
}
