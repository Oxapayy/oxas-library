import Hls from "hls.js";
import mpegts from "mpegts.js";
import {
  SimilarityIndex,
  becauseYouWatched,
  moreLikeThis,
  onNow,
  picks,
  readyOffline,
  seedSignature,
  watchAgain,
} from "./shelves";
mpegts.LoggingControl.enableAll = false;
declare global {
  interface Window {
    oxa: {
      capabilities?: { web?: boolean; downloads?: boolean };
      command: (action: string, args?: any) => Promise<any>;
      onUpdate: (fn: (s: any) => void) => () => void;
      onAction: (fn: (s: string) => void) => () => void;
    };
  }
}
const webMode = window.oxa.capabilities?.web === true;
const downloadsEnabled =
  !webMode && window.oxa.capabilities?.downloads !== false;
const $ = (s: string) => document.querySelector(s) as any;
const esc = (v: any) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const cmd = (action: string, args: any = {}) =>
  window.oxa.command(action, args);
const time = (s: number) => {
  s = Math.max(0, Math.floor(s || 0));
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const bytes = (n: number) =>
  n > 1073741824
    ? `${(n / 1073741824).toFixed(1)} GB`
    : `${Math.round((n || 0) / 1048576)} MB`;
const icons: any = {
  Library:
    '<rect x="4" y="6" width="16" height="15" rx="3"/><path d="M7 3h10M8 10h8"/>',
  Search: '<circle cx="10.5" cy="10.5" r="7"/><path d="m16 16 5 5"/>',
  "Live TV":
    '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',
  Downloads:
    '<circle cx="12" cy="12" r="10"/><path d="M12 6v12m-5-5 5 5 5-5"/>',
  Settings:
    '<path d="M3 6h18M3 12h18M3 18h18"/><circle cx="8" cy="6" r="2" fill="black"/><circle cx="16" cy="12" r="2" fill="black"/><circle cx="8" cy="18" r="2" fill="black"/>',
};
let state: any = {
    sources: [],
    media: [],
    programs: [],
    transfers: [],
    preferences: {},
    account: {},
  },
  page = "Library",
  filter = "All",
  source = "",
  query = "",
  group = "",
  starred = false,
  searchRows: any[] = [],
  searchEpoch = 0,
  detailData: any = null,
  seasonNumber = 1,
  sortOrder = "default",
  heroIndex = 0,
  heroKey = "";
let toastTimer: any,
  busy = false,
  playback: any = null,
  hls: Hls | null = null,
  transportPlayer: any = null,
  seekPending = 0,
  countdown: any = null,
  countdownCanceled = false,
  idleTimer: any,
  progressTimer: any,
  lastAccount = "";
const video = $("#video") as HTMLVideoElement;
const visibleCounts = new Map<string, number>();
const visibleCount = (key: string) => visibleCounts.get(key) || 100;
const showMore = (key: string, total: number) =>
  total > visibleCount(key)
    ? button(
        `Show more (${Math.min(visibleCount(key), total)} of ${total})`,
        "rows.more",
        { key },
      )
    : "";
let lastSidebarHTML = "",
  lastContentHTML = "";
function toast(message: string) {
  $("#toast").textContent = message;
  $("#toast").hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ($("#toast").hidden = true), 5500);
}
async function run(fn: () => Promise<any>) {
  try {
    return await fn();
  } catch (e: any) {
    toast(e.message || "This operation could not complete.");
    return null;
  }
}
const button = (
  label: string,
  action: string,
  args: any = {},
  primary = false,
) =>
  `<button type="button" ${primary ? 'class="primary"' : ""} data-action="${esc(action)}" data-args="${esc(JSON.stringify(args))}">${esc(label)}</button>`;
function allowedMediaURL(raw: string, caption = false, direct = false) {
  if (typeof raw !== "string" || !raw) return false;
  if (!webMode) return raw.startsWith("oxa://");
  try {
    const url = new URL(raw, location.href);
    if (caption && url.protocol === "blob:")
      return url.origin === location.origin;
    // Web playback and TMDB artwork load straight from their HTTPS servers.
    if (
      !caption &&
      url.protocol === "https:" &&
      (direct || url.hostname === "image.tmdb.org")
    )
      return true;
    return (
      url.origin === location.origin &&
      (url.pathname === "/web/api/media" ||
        url.pathname.startsWith("/web/media/") ||
        (caption && url.pathname === "/web/api/caption"))
    );
  } catch {
    return false;
  }
}
const image = (url: string, alt = "", cls = "") =>
  allowedMediaURL(url)
    ? `<img src="${esc(url)}" alt="${esc(alt)}" class="${esc(cls)}" loading="lazy" decoding="async">`
    : "";
const episodeLabel = (m: any) =>
  m.kind === "episode"
    ? `S${m.season || 1} · E${m.episode || 1} · ${m.title}`
    : [
        m.year,
        m.kind === "series"
          ? "Series"
          : m.kind === "channel"
            ? "Live TV"
            : "Movie",
      ]
        .filter(Boolean)
        .join(" · ");
function heading(title: string, actions = "") {
  return `<header class="page-heading"><h1>${esc(title)}</h1><div class="actions">${actions}</div></header>`;
}
function blank(title: string, description: string, action = "") {
  return `<div class="empty"><div class="empty-mark" aria-hidden="true">▷</div><h2>${esc(title)}</h2><p>${esc(description)}</p>${action}</div>`;
}
function sidebar() {
  const account = state.account;
  const html = `<div class="brand"><span class="brand-mark">▶</span><span class="name">Oxa’s Library</span></div><nav>${Object.keys(
    icons,
  )
    .filter((name) => downloadsEnabled || name !== "Downloads")
    .map(
      (name) =>
        `<button data-page="${name}" ${page === name ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg><span class="label">${name}</span></button>`,
    )
    .join(
      "",
    )}</nav><button class="sidebar-account" data-action="account.open">${account.signedIn ? "Your account" : "Sign in"}<small>${esc(account.email || "Optional. Syncs your library")}</small></button>`;
  if (html !== lastSidebarHTML) {
    $("#sidebar").innerHTML = html;
    lastSidebarHTML = html;
  }
}
function render() {
  if (!downloadsEnabled && page === "Downloads") page = "Library";
  sidebar();
  const content = $("#content");
  const pageHTML =
    page === "Library"
      ? library()
      : page === "Search"
        ? search()
        : page === "Live TV"
          ? iptv()
          : page === "Downloads" && downloadsEnabled
            ? downloads()
            : settings();
  const html =
    (state.storageError
      ? `<div class="panel error" role="alert">${esc(state.storageError)} ${button("Retry Saving", "storage.retry")}</div>`
      : "") +
    updateBanner() +
    pageHTML;
  // Byte updates must not tear down unrelated posters, focus or image requests.
  if (html !== lastContentHTML) {
    content.innerHTML = html;
    lastContentHTML = html;
    applyHero();
    markLoaded(content);
  }
}
// Artwork fades in once it has decoded; a skeleton holds its place until then.
function markLoaded(root: Element) {
  root.querySelectorAll("img:not(.loaded):not(.failed)").forEach((img: any) => {
    if (img.complete) img.classList.add(img.naturalWidth ? "loaded" : "failed");
  });
}
document.addEventListener(
  "load",
  (e) => {
    const t = e.target as HTMLElement;
    if (t?.tagName === "IMG") t.classList.add("loaded");
  },
  true,
);
document.addEventListener(
  "error",
  (e) => {
    const t = e.target as HTMLElement;
    if (t?.tagName === "IMG") t.classList.add("failed");
  },
  true,
);
function updateBanner() {
  const u = state.update;
  if (!u || u.state === "none") return "";
  const v = esc(u.version);
  const body =
    u.state === "available"
      ? `<p><strong>Oxa’s Library ${v} is available.</strong> You have version ${esc(state.version)}.</p><div class="source-actions">${button("Download Update", "update.download", {}, true)}${button("What’s New", "external", { target: "updateNotes" })}${button("Later", "update.skip")}</div>`
      : u.state === "downloading"
        ? `<p><strong>Downloading Oxa’s Library ${v}…</strong></p><progress max="1" value="${esc(u.fraction || 0)}"></progress>`
        : u.state === "ready"
          ? state.platform === "win32"
            ? `<p><strong>Oxa’s Library ${v} is ready to install.</strong> The app closes while the installer runs. Your library stays in place.</p><div class="source-actions">${button("Install and Restart", "update.install", {}, true)}</div>`
            : `<p><strong>Oxa’s Library ${v} is ready.</strong> Quit Oxa’s Library, then drag the new version into Applications and choose Replace. Your library stays in place.</p><div class="source-actions">${button("Open Installer", "update.install", {}, true)}</div>`
          : `<p class="error">${esc(u.error || "The update could not be downloaded.")}</p><div class="source-actions">${button("Try Again", "update.download", {}, true)}${button("What’s New", "external", { target: "updateNotes" })}</div>`;
  return `<section class="notice update-banner" role="status">${body}</section>`;
}
const svg: any = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  check: '<path d="m5 12.5 4.5 4.5L19 7"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.6v.4"/>',
  prev: '<path d="m15 5-7 7 7 7"/>',
  next: '<path d="m9 5 7 7-7 7"/>',
};
const iconButton = (icon: string, action: string, args: any, label: string) =>
  `<button type="button" class="icon-button" data-action="${esc(action)}" data-args="${esc(JSON.stringify(args))}" aria-label="${esc(label)}"><svg viewBox="0 0 24 24" aria-hidden="true">${svg[icon]}</svg></button>`;
const seriesOf = (m: any) =>
  m.kind === "episode"
    ? state.media.find((x: any) => x.kind === "series" && x.id === m.seriesID)
    : undefined;
const resuming = (m: any) => m?.progress?.seconds > 0 && !m.progress.completed;
const progressBar = (m: any) =>
  `<progress max="${esc(m.progress.duration || 1)}" value="${esc(m.progress.seconds)}" aria-label="Watch progress"></progress>`;
const reduceMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches;
// Missing artwork becomes a quiet tone picked from the title, with the title on it.
function tone(text: string) {
  let h = 0;
  for (const c of String(text)) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h) % 8;
}
function art(m: any, wide = false, cls = "") {
  const name = m.seriesTitle || m.title;
  return (
    image(wide ? m.backdrop || m.poster : m.poster || m.backdrop, "", cls) ||
    `<span class="fallback tone-${tone(name)}">${esc(name)}</span>`
  );
}
const minutes = (m: any) =>
  m.duration >= 60 ? `${Math.round(m.duration / 60)} min` : "";
function continueCard(m: any, fresh = false) {
  return `<button class="continue-card" data-action="play" data-id="${esc(m.id)}" data-args="${esc(JSON.stringify({ id: m.id }))}"><span class="cover art">${art(m, true)}${fresh || !m.progress ? "" : progressBar(m)}</span><span class="copy"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc(episodeLabel(m))}</small>${fresh ? '<span class="flag">New episode</span>' : m.progress ? `<small>${time(m.progress.seconds)} · ${time(Math.max(0, m.progress.duration - m.progress.seconds))} left</small>` : ""}</span></button>`;
}
// One slide of the hero stage. The active slide is set after rendering (applyHero),
// so rotating it never rebuilds the page or resets the shelves' scroll positions.
function heroSlide(m: any, kicker: string, index: number) {
  const listed = seriesOf(m) || m,
    name = m.seriesTitle || m.title,
    going = resuming(m),
    meta = [episodeLabel(m), minutes(m)].filter(Boolean).join(" · ");
  return `<section class="hero-slide" data-slide="${index}" data-id="${esc(m.id)}" aria-label="${esc(name)}"><div class="hero-art" aria-hidden="true">${art(m, true)}</div><div class="hero-copy">${kicker ? `<h2 class="hero-kicker">${esc(kicker)}</h2>` : ""}<h3 class="hero-title">${esc(name)}</h3><p class="hero-meta">${esc(meta)}</p>${listed.overview || m.overview ? `<p class="hero-overview">${esc(m.overview || listed.overview)}</p>` : ""}${going ? `${progressBar(m)}<small>${time(m.progress.seconds)} · ${time(Math.max(0, m.progress.duration - m.progress.seconds))} left</small>` : ""}<div class="hero-actions">${button(going ? "Resume" : "Play", "play", { id: m.id }, true)}<span class="glass-pill">${iconButton(listed.favorite ? "check" : "plus", "favorite", { id: listed.id }, listed.favorite ? `Remove ${listed.title} from watchlist` : `Add ${listed.title} to watchlist`)}${iconButton("info", "detail", { id: listed.id }, `Details for ${listed.title}`)}</span></div></div></section>`;
}
function heroStage(slides: { m: any; kicker: string }[], bar: string) {
  const key = slides.map((x) => x.m.id).join(",");
  if (key !== heroKey) {
    heroKey = key;
    heroIndex = 0;
  }
  return `<div class="hero-stage">${slides.map((x, i) => heroSlide(x.m, x.kicker, i)).join("")}${bar}${slides.length > 1 ? `<div class="hero-dots" role="group" aria-label="Featured titles">${slides.map((x, i) => `<button type="button" data-hero-slide="${i}" aria-label="${esc(`Show ${x.m.seriesTitle || x.m.title}`)}"></button>`).join("")}</div>` : ""}</div>`;
}
function applyHero() {
  const slides = document.querySelectorAll(".hero-slide");
  if (!slides.length) return;
  if (heroIndex >= slides.length) heroIndex = 0;
  slides.forEach((el, i) => {
    el.classList.toggle("active", i === heroIndex);
    if (i === heroIndex) el.removeAttribute("aria-hidden");
    else el.setAttribute("aria-hidden", "true");
  });
  document
    .querySelectorAll(".hero-dots button")
    .forEach((el, i) =>
      el.setAttribute("aria-current", String(i === heroIndex)),
    );
}
setInterval(() => {
  const stage = document.querySelector(".hero-stage");
  if (
    !stage ||
    reduceMotion() ||
    document.hidden ||
    stage.matches(":hover, :focus-within")
  )
    return;
  const count = stage.querySelectorAll(".hero-slide").length;
  if (count < 2) return;
  heroIndex = (heroIndex + 1) % count;
  applyHero();
}, 9000);
function shelf(
  title: string,
  items: any[],
  card: (m: any) => string,
  all = "",
  note = "",
) {
  if (!items.length) return "";
  return `<section class="shelf" aria-label="${esc(title)}"><div class="shelf-head"><h2>${esc(title)}</h2>${all && items.length > 12 ? `<button type="button" class="quiet" data-filter="${esc(all)}">See all ${items.length}</button>` : `<span class="muted">${items.length}</span>`}</div>${note ? `<p class="shelf-note">${esc(note)}</p>` : ""}<button type="button" class="shelf-arrow prev" data-shelf-dir="-1" aria-label="${esc(`Scroll ${title} back`)}"><svg viewBox="0 0 24 24" aria-hidden="true">${svg.prev}</svg></button><button type="button" class="shelf-arrow next" data-shelf-dir="1" aria-label="${esc(`Scroll ${title} forward`)}"><svg viewBox="0 0 24 24" aria-hidden="true">${svg.next}</svg></button><div class="shelf-row">${items.slice(0, 40).map(card).join("")}</div></section>`;
}
function poster(m: any) {
  return `<button class="poster" data-action="detail" data-id="${esc(m.id)}" data-args="${esc(JSON.stringify({ id: m.id }))}"><span class="cover">${art(m)}</span><strong>${esc(m.title)}</strong><small>${esc(episodeLabel(m))}</small></button>`;
}
// Derived shelves stay off the render path: the similarity index is built in idle
// steps and results are cached until the catalog, a seed or the watchlist changes.
let derivedIndex: SimilarityIndex | undefined,
  derivedCatalog = "",
  derivedBuilder: ReturnType<typeof SimilarityIndex.builder> | undefined,
  derivedCache: { key: string; value: any } = { key: "", value: null };
const idle = (fn: () => void) =>
  "requestIdleCallback" in window
    ? (window as any).requestIdleCallback(fn, { timeout: 600 })
    : setTimeout(fn, 16);
function similarity() {
  const m = state.media,
    n = m.length,
    key = `${n}:${m[0]?.id}:${m[n >> 1]?.id}:${m[n - 1]?.id}`;
  if (key !== derivedCatalog) {
    derivedCatalog = key;
    derivedIndex = undefined;
    const builder = (derivedBuilder = SimilarityIndex.builder(m));
    const step = () => {
      if (derivedBuilder !== builder) return;
      const done = builder.step(8);
      if (!done) return void idle(step);
      derivedIndex = done;
      derivedBuilder = undefined;
      render();
      if (detailData && $("#sheet").open) drawDetail();
    };
    idle(step);
  }
  return derivedIndex;
}
function derived() {
  const index = similarity(),
    key = `${derivedCatalog}|${index ? 1 : 0}|${seedSignature(state.media)}`;
  if (derivedCache.key !== key)
    derivedCache = {
      key,
      value: {
        watchAgain: watchAgain(state.media),
        because: index ? becauseYouWatched(index, state.media) : [],
        picks: index ? picks(index, state.media) : [],
      },
    };
  return derivedCache.value;
}
function sorted(rows: any[]) {
  if (sortOrder === "az")
    return [...rows].sort((a, b) => String(a.title).localeCompare(b.title));
  if (sortOrder === "new")
    return [...rows].sort((a, b) => (b.year || 0) - (a.year || 0));
  if (sortOrder === "old")
    return [...rows].sort((a, b) => (a.year || 9999) - (b.year || 9999));
  if (sortOrder === "recent") {
    const latest = new Map<string, number>();
    for (const m of state.media) {
      const at = m.progress?.playedAt || 0,
        id = m.kind === "episode" ? m.seriesID : m.id;
      if (at > (latest.get(id) || 0)) latest.set(id, at);
    }
    return [...rows].sort(
      (a, b) => (latest.get(b.id) || 0) - (latest.get(a.id) || 0),
    );
  }
  return rows;
}
const sortMenu = () =>
  `<label class="sort">Sort<select id="sort" aria-label="Sort">${[
    ["default", "Default"],
    ["recent", "Recently Watched"],
    ["az", "A–Z"],
    ["new", "Year (newest)"],
    ["old", "Year (oldest)"],
  ]
    .map(
      ([v, l]) =>
        `<option value="${v}" ${sortOrder === v ? "selected" : ""}>${l}</option>`,
    )
    .join("")}</select></label>`;
function library() {
  let rows = state.media.filter(
    (m: any) => m.kind === "movie" || m.kind === "series",
  );
  const newEpisodes = state.media.filter(
    (m: any) => m.newEpisode && (!source || m.sourceID === source),
  );
  const continued = state.media
    .filter(
      (m: any) =>
        m.kind !== "channel" &&
        m.progress?.seconds > 0 &&
        !m.progress.completed,
    )
    .sort((a: any, b: any) => b.progress.playedAt - a.progress.playedAt)
    .filter(
      (() => {
        const seen = new Set<string>();
        return (m: any) => {
          if (m.kind !== "episode") return true;
          const key = JSON.stringify([m.sourceID, m.seriesID]);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        };
      })(),
    );
  if (filter === "Movies") rows = rows.filter((m: any) => m.kind === "movie");
  if (filter === "Series") rows = rows.filter((m: any) => m.kind === "series");
  if (filter === "Watchlist") rows = rows.filter((m: any) => m.favorite);
  if (source) rows = rows.filter((m: any) => m.sourceID === source);
  const watching = continued.filter(
      (m: any) => !source || m.sourceID === source,
    ),
    refreshing = state.sources.some((s: any) => s.refreshing),
    d = filter === "All" ? derived() : null,
    mine = (list: any[]) =>
      list.filter((m: any) => !source || m.sourceID === source);
  const slides: { m: any; kicker: string }[] = [];
  if (filter === "All") {
    if (watching[0])
      slides.push({ m: watching[0], kicker: "Continue Watching" });
    if (newEpisodes[0])
      slides.push({ m: newEpisodes[0], kicker: "New Episode" });
    for (const m of mine(d.picks).slice(0, 2))
      slides.push({ m, kicker: "Picked for You" });
    if (!slides.length && rows[0]) slides.push({ m: rows[0], kicker: "" });
  } else if (rows[0]) slides.push({ m: rows[0], kicker: "" });
  const bar = state.sources.length
    ? `<div class="library-bar"><div class="category-bar" role="group" aria-label="Show">${["All", "Movies", "Series", "Watchlist"].map((x) => `<button type="button" data-filter="${x}" aria-pressed="${filter === x}">${x}</button>`).join("")}<button type="button" data-page="Live TV">Live TV</button></div>${iconButton("plus", "source.form", {}, "Add source")}<span class="spacer"></span>${state.sources.length > 1 ? `<select id="source-filter" aria-label="Source"><option value="">All sources</option>${state.sources.map((s: any) => `<option value="${esc(s.id)}" ${s.id === source ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select>` : ""}${button("Refresh", "refresh")}</div>`
    : "";
  const empty =
    webMode && state.initializing && !rows.length
      ? blank(
          "Connecting your library…",
          state.loadingMessage ||
            "Loading films, series and live TV from huhu.to.",
        )
      : !state.sources.length
        ? blank(
            "Your library starts here.",
            "Connect your media server, library URL or video source. Your watch progress stays with you.",
            button("Import huhu.to", "source.huhu", {}, true) +
              button("Connect Your Own Server", "source.form"),
          )
        : !slides.length
          ? filter === "Watchlist"
            ? blank(
                "Your watchlist is empty.",
                "Choose + on a film or series to keep it here.",
              )
            : blank(
                refreshing ? "Loading your library…" : "No titles here yet.",
                refreshing
                  ? "You can keep using the app while your sources update."
                  : "Refresh your source or check its connection in Settings.",
              )
          : "";
  const body = empty
    ? bar + empty
    : heroStage(slides, bar) +
      (filter === "All"
        ? shelf("Also watching", watching.slice(1), (m) => continueCard(m)) +
          shelf("New Episodes", newEpisodes, (m) => continueCard(m, true)) +
          shelf(
            "Picks for You",
            mine(d.picks),
            poster,
            "",
            "Based on titles you watched or saved",
          ) +
          d.because
            .map((b: any) =>
              shelf(
                `Because You Watched ${b.seed.title}`,
                mine(b.items),
                poster,
                "",
                `Similar to ${b.seed.title}`,
              ),
            )
            .join("") +
          shelf("Watch Again", mine(d.watchAgain), poster) +
          (downloadsEnabled
            ? shelf("Ready Offline", readyOffline(state.transfers), poster)
            : "") +
          shelf(
            "Watchlist",
            rows.filter((m: any) => m.favorite),
            poster,
            "Watchlist",
          ) +
          shelf(
            "Movies",
            rows.filter((m: any) => m.kind === "movie"),
            poster,
            "Movies",
          ) +
          shelf(
            "Series",
            rows.filter((m: any) => m.kind === "series"),
            poster,
            "Series",
          ) +
          `<div class="section-heading">${button("Load more from sources", "more")}</div>`
        : `<div class="section-heading"><h2>${esc(filter)}</h2><span class="spacer"></span>${sortMenu()}<span class="muted">${rows.length}</span></div><div class="grid">${sorted(rows).slice(0, visibleCount("library")).map(poster).join("")}</div><div class="section-heading">${showMore("library", rows.length)}${button("Load more from sources", "more")}</div>`);
  return (
    '<h1 class="sr-only">Library</h1>' +
    body +
    state.sources
      .filter((s: any) => s.error)
      .map((s: any) => `<p class="error">${esc(s.name)}: ${esc(s.error)}</p>`)
      .join("")
  );
}
const shortcut = () =>
  (
    webMode
      ? /Mac|iPhone|iPad/.test(navigator.platform)
      : state.platform === "darwin"
  )
    ? "⌘K"
    : "Ctrl K";
function searchRow(m: any) {
  return `<button class="row" data-action="detail" data-id="${esc(m.id)}" data-args="${esc(JSON.stringify({ id: m.id }))}">${image(m.poster || m.backdrop)}<span class="text"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc(episodeLabel(m))}</small></span><span aria-hidden="true">›</span></button>`;
}
function search() {
  const q = query.toLocaleLowerCase(),
    match = (m: any) =>
      !q || `${m.title} ${m.seriesTitle || ""}`.toLocaleLowerCase().includes(q),
    local = state.media.filter(
      (m: any) => ["movie", "series"].includes(m.kind) && match(m),
    ),
    localIDs = new Set(local.map((m: any) => m.id)),
    rows = sorted([
      ...local,
      ...searchRows.filter(
        (m) => ["movie", "series"].includes(m.kind) && !localIDs.has(m.id),
      ),
    ]),
    toolbar = `<div class="toolbar"><input class="search-input" id="search-query" type="search" placeholder="Films and series" aria-label="Search your library" value="${esc(query)}">${button("Search", "search.run")}${rows.length ? sortMenu() : ""}</div><p class="search-hint">Press <kbd>/</kbd> or <kbd>${shortcut()}</kbd> to search from anywhere.</p>`;
  if (!q) {
    // An empty search suggests what to watch instead of listing the whole catalog.
    const d = derived(),
      watching = state.media
        .filter((m: any) => m.kind !== "channel" && resuming(m))
        .sort((a: any, b: any) => b.progress.playedAt - a.progress.playedAt)
        .slice(0, 12);
    return (
      heading("Search") +
      toolbar +
      shelf("Continue Watching", watching, (m) => continueCard(m)) +
      shelf(
        "Picks for You",
        d.picks,
        poster,
        "",
        "Based on titles you watched or saved",
      ) +
      (rows.length
        ? `<div class="search-group"><h2>In Your Library</h2><span class="muted">${Math.min(24, rows.length)} of ${rows.length}</span></div><div class="search-results">${rows.slice(0, 24).map(searchRow).join("")}</div>`
        : blank(
            "Nothing to search yet.",
            "Connect a source to search your films and series here.",
          ))
    );
  }
  const movies = rows.filter((m: any) => m.kind === "movie"),
    series = rows.filter((m: any) => m.kind === "series"),
    channels = state.media.filter((m: any) => m.kind === "channel" && match(m)),
    group = (title: string, list: any[], key: string) =>
      list.length
        ? `<div class="search-group"><h2>${title}</h2><span class="muted">${list.length}</span></div>${list.slice(0, visibleCount(key)).map(searchRow).join("")}${showMore(key, list.length)}`
        : "";
  return (
    heading("Search") +
    toolbar +
    `<div class="search-results">${group("Movies", movies, "search")}${group("Series", series, "search-series")}</div>` +
    (channels.length
      ? `<div class="search-channels"><div class="search-group"><h2>Channels</h2><span class="muted">${channels.length}</span></div>${channels
          .slice(0, 24)
          .map(
            (m: any) =>
              `<button class="row" data-action="play" data-id="${esc(m.id)}" data-args="${esc(JSON.stringify({ id: m.id }))}">${image(m.poster)}<span class="text"><strong>${esc(m.title)}</strong><small>${esc(m.group || "Live TV")}</small></span><span aria-hidden="true">▶</span></button>`,
          )
          .join("")}</div>`
      : "") +
    (!rows.length && !channels.length
      ? blank(
          "No matching titles.",
          "Try a different title or refresh your sources.",
        )
      : "")
  );
}
function iptv() {
  let rows = state.media.filter((m: any) => m.kind === "channel"),
    groups = [...new Set(rows.map((m: any) => m.group).filter(Boolean))].sort();
  if (group) rows = rows.filter((m: any) => m.group === group);
  if (starred) rows = rows.filter((m: any) => m.favorite);
  const channelPrograms = new Map<string, any[]>();
  for (const p of state.programs) {
    const entries = channelPrograms.get(p.mediaID);
    if (entries) entries.push(p);
    else channelPrograms.set(p.mediaID, [p]);
  }
  if (query)
    rows = rows.filter(
      (m: any) =>
        m.title.toLowerCase().includes(query.toLowerCase()) ||
        channelPrograms
          .get(m.id)
          ?.some((p: any) =>
            p.title.toLowerCase().includes(query.toLowerCase()),
          ),
    );
  const now = Date.now() / 1000 - 978307200,
    airing = onNow(
      state.media.filter((m: any) => m.kind === "channel"),
      state.programs,
      now,
    ),
    clock = (t: number) =>
      new Date((t + 978307200) * 1000).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      }),
    nowCard = (r: any) => {
      const body = `<span class="station-row">${image(r.channel.poster) || '<span class="station" aria-hidden="true">▱</span>'}<strong>${esc(r.channel.title)}</strong></span><span class="now-title">${esc(r.program.title)}</span><progress max="${r.program.end - r.program.start}" value="${now - r.program.start}" aria-label="Programme progress"></progress><small>${r.next ? `Next ${esc(clock(r.next.start))} · ${esc(r.next.title)}` : `Until ${esc(clock(r.program.end))}`}</small>`;
      const live = livePlay(r.channel);
      return live.startsWith("<a")
        ? `<a class="now-card" href="https://huhu.to/#/channels" target="_blank" rel="noopener noreferrer">${body}</a>`
        : `<button class="now-card" data-action="play" data-args="${esc(JSON.stringify({ id: r.channel.id }))}">${body}</button>`;
    };
  return (
    heading(
      "Live TV",
      rows.length || group || starred || query
        ? button(
            "+ Add Playlist",
            "source.form",
            { kind: "M3U playlist" },
            true,
          )
        : "",
    ) +
    (!state.media.some((m: any) => m.kind === "channel")
      ? blank(
          "No live channels yet.",
          "Add an M3U playlist or Xtream Codes login to see your channels and their program guide here.",
          button(
            "Add IPTV Source",
            "source.form",
            { kind: "M3U playlist" },
            true,
          ),
        )
      : shelf("On Now", airing, nowCard) +
        (groups.length > 1
          ? `<div class="chips" role="group" aria-label="Channel groups"><button type="button" data-group="" aria-pressed="${!group}">All</button>${groups
              .slice(0, 24)
              .map(
                (g) =>
                  `<button type="button" data-group="${esc(g)}" aria-pressed="${group === g}">${esc(g)}</button>`,
              )
              .join("")}</div>`
          : "") +
        `<div class="toolbar">${button(starred ? "★ Favorites" : "☆ All channels", "channels.favorites")}<input id="channel-query" type="search" aria-label="Search channels" placeholder="Find a channel" value="${esc(query)}"><select id="channel-group" aria-label="Channel group"><option value="">All groups</option>${groups.map((g) => `<option value="${esc(g)}" ${group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></div><p>${rows.length} channels</p><div class="channel-list">${rows
          .slice(0, visibleCount("channels"))
          .map((m: any) => {
            const p = channelPrograms
              .get(m.id)
              ?.find((p: any) => p.start <= now && p.end > now);
            return `<article class="channel">${image(m.poster) || '<span class="station" aria-hidden="true">▱</span>'}<div class="text"><strong>${esc(m.title)}</strong>${p?.title || m.group ? `<small>${esc(p?.title || m.group)}</small>` : ""}${p ? `<progress max="${p.end - p.start}" value="${now - p.start}"></progress>` : ""}${button("Program Guide", "guide", { id: m.id })}</div>${livePlay(m)}${button(m.favorite ? "★" : "☆", "favorite", { id: m.id })}</article>`;
          })
          .join(
            "",
          )}</div>${showMore("channels", rows.length)}${!rows.length ? "<p>No channels match this search or filter.</p>" : ""}`)
  );
}
function downloads() {
  if (!downloadsEnabled) return "";
  return (
    heading("Downloads") +
    `<p>Saved on this device. Downloads stay available without a server connection.</p>` +
    (state.transfers.length
      ? state.transfers
          .slice(0, visibleCount("downloads"))
          .map(
            (t: any) =>
              `<article class="panel transfer"><div class="row"><div class="text"><strong>${esc(t.media.seriesTitle || t.media.title)}</strong><small>${esc(episodeLabel(t.media))}</small><small>${esc(t.state)} · ${bytes(t.bytes)}</small>${t.state === "downloading" ? `<progress ${t.fraction != null ? `value="${esc(t.fraction)}" max="1"` : ""}></progress>` : ""}${t.error ? `<p class="error">${esc(t.error)}</p>` : ""}</div><div class="actions">${t.state === "ready" ? button("Play Offline", "play", { id: t.media.id, transferID: t.id }, true) : ["queued", "downloading"].includes(t.state) ? button("Cancel", "transfer.cancel", { id: t.id }) : button("Retry", "transfer.retry", { id: t.id })}${button("Delete", "transfer.confirm-delete", { id: t.id })}</div></div></article>`,
          )
          .join("") + showMore("downloads", state.transfers.length)
      : blank(
          "No downloads yet.",
          "Open a film or episode and choose Download. You can save an entire season from its series page.",
        ))
  );
}
// huhu.to live channels send plain HTTP streams that browsers block, so the
// web version opens huhu.to's own Live TV page instead of a dead player.
function livePlay(m: any) {
  const source = webMode && state.sources.find((s: any) => s.id === m.sourceID);
  if (
    source?.kind === "Library URL" &&
    /^(www\.)?huhu\.to$/i.test(source.host || "")
  )
    return `<a class="channel-play" href="https://huhu.to/#/channels" target="_blank" rel="noopener noreferrer" aria-label="${esc(`Play ${m.title} on huhu.to`)}">Play on huhu.to ↗</a>`;
  return button("Play", "play", { id: m.id });
}
function providerAssistance(sourceID: string, context = "playback") {
  if (!webMode || !sourceID) return "";
  const source = state.sources.find((s: any) => s.id === sourceID);
  if (!source || source.kind !== "Library URL") return "";
  const id = `provider-assistance-${context}-${source.id}`;
  return `<div class="provider-assistance"><label class="row check"><span class="text">Provider-assisted requests</span><input id="${esc(id)}" data-provider-assistance data-source-id="${esc(source.id)}" type="checkbox" role="switch" aria-describedby="${esc(id)}-info" ${source.allowProviderFetch ? "checked" : ""}></label><p id="${esc(id)}-info" class="info">Some servers need a public host response sent to this library provider to resolve playback. Your Oxa account and other saved server credentials are never included.</p></div>`;
}
const permissionVersions = new Map<string, number>();
function settings() {
  const p = state.preferences,
    a = state.account;
  return (
    heading("Settings") +
    `<div class="settings-layout"><section class="setting-section"><div><h3>Your account</h3><p>Optional account sync, watch history and watchlist across your devices.</p></div><div class="panel"><div class="row"><div class="text"><strong>${esc(a.email || "Continue as a guest")}</strong><small>${esc(a.signedIn ? (a.unlocked ? "Account sync ready" : "Connecting to your account") : "Your library is saved on this device.")}</small></div>${button(a.signedIn ? "Manage" : "Sign in", "account.open")}</div>${a.signedIn ? `<div class="row"><div class="text"><small>${esc(a.message || (a.syncing ? "Syncing…" : "Your local changes are saved."))}</small></div>${button("Sync Now", "sync")}</div>` : ""}</div></section><section class="setting-section"><div><h3>Sources</h3><p>Connect several libraries in one place. Refreshing keeps your watch progress.</p></div><div><div class="panel">${state.sources.map((s: any) => `<div class="row"><div class="text"><strong>${esc(s.name)}</strong><small>${esc(s.kind)} · ${esc(s.host)}</small>${s.refreshing ? '<small class="busy">Refreshing</small>' : ""}${s.error ? `<p class="error">${esc(s.error)}</p>` : ""}<div class="source-actions">${button("Refresh", "refresh", { id: s.id })}${button("Edit", "source.form", { id: s.id })}<button class="danger" data-action="source.confirm-remove" data-args="${esc(JSON.stringify({ id: s.id }))}">Remove</button></div>${providerAssistance(s.id, "settings")}</div></div>`).join("") || "<p>No sources connected.</p>"}${button("+ Add Source", "source.form")}</div></div></section><section class="setting-section"><div><h3>Playback</h3><p>Language preferences apply when those tracks are available. Change tracks in the player at any time.</p></div><div class="panel"><label class="row check"><span class="text">Play next episode automatically</span><input id="autoplay" role="switch" type="checkbox" ${p.autoplay ? "checked" : ""}></label><label class="row"><span class="text">Audio language</span><select id="audio-language"><option value="en" ${p.audioLanguage === "en" ? "selected" : ""}>English</option><option value="de" ${p.audioLanguage === "de" ? "selected" : ""}>German</option></select></label><label class="row"><span class="text">Subtitle language</span><select id="subtitle-language">${[
      ["off", "Off"],
      ["en", "English"],
      ["de", "German"],
    ]
      .map(
        ([v, l]) =>
          `<option value="${v}" ${p.subtitleLanguage === v ? "selected" : ""}>${l}</option>`,
      )
      .join(
        "",
      )}</select></label></div></section><section class="setting-section"><div><h3>Optional metadata</h3><p>Find artwork and descriptions with your own TMDB API read token. Searches send the title to TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div><div class="panel"><form id="metadata-form"><label>TMDB API read token<input name="token" type="password" autocomplete="off" placeholder="Paste a token, or leave blank to disable"></label><button type="submit">Save Metadata Settings</button></form></div></section>${downloadsEnabled ? `<section class="setting-section"><div><h3>Download location</h3><p>Offline video stays on this device. Moving the folder also moves saved downloads.</p></div><div class="panel"><p>${esc(p.downloadDirectory || "Application storage")}</p>${button("Choose Folder…", "downloadDirectory")}</div></section>` : ""}<section class="setting-section"><div><h3>Oxa’s Library</h3><p>Version ${esc(state.version)} · ${webMode ? "Web" : state.platform === "darwin" ? "macOS" : "Windows"}<br>Open source. Films, series and live TV from your own sources.</p></div><div class="panel">${button("Website", "external", { target: "website" })} ${button("Source Code", "external", { target: "github" })} ${button("Releases", "external", { target: "release" })}${webMode ? "" : ` ${button("Check for Updates", "update.check.manual")}`} ${button("Licenses", "licenses")}</div></section><section class="setting-section"><div><h3>Support Oxa</h3><p>Optional donations help support development. All features stay free.</p></div><div class="panel"><p>Bitcoin · BTC</p><code>3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV</code>${button("Copy Bitcoin Address", "donation.copy", { network: "bitcoin" })}<p>Litecoin · LTC</p><code>MTToUVnMpepWixDhUPBBG1SgdmxjifArwF</code>${button("Copy Litecoin Address", "donation.copy", { network: "litecoin" })}</div></section></div>`
  );
}
function sheet(title: string, html: string, cls = "") {
  const d = $("#sheet");
  d.className = cls;
  d.innerHTML = `<header><h2>${esc(title)}</h2><button data-action="sheet.close" aria-label="Close">×</button></header>${html}`;
  markLoaded(d);
  if (!d.open) d.showModal();
}
async function openDetail(id: string) {
  visibleCounts.delete("episodes");
  sheet("Loading…", '<p class="busy">Reading this title</p>');
  try {
    detailData = await cmd("detail", { id });
    seasonNumber =
      detailData.seasons[0]?.number || detailData.episodes[0]?.season || 1;
    if (
      detailData.media.kind === "series" &&
      detailData.seasons.length &&
      !detailData.episodes.some((e: any) => e.season === seasonNumber)
    )
      detailData.episodes = await cmd("season", { id, number: seasonNumber });
    drawDetail();
  } catch (error: any) {
    detailData = null;
    sheet(
      "Couldn’t open this title",
      `<p>${esc(webMode || !error?.message ? "Check the source connection and try again." : error.message)}</p><div class="dialog-actions">${button("Close", "sheet.close")}${button("Retry", "detail", { id }, true)}</div>`,
    );
  }
}
function drawDetail() {
  const d = detailData,
    m = d.media,
    episodes = d.episodes.filter(
      (e: any) => !seasonNumber || e.season === seasonNumber,
    ),
    seasons = d.seasons.length
      ? d.seasons
      : [...new Set(d.episodes.map((e: any) => e.season || 1))]
          .sort((a: number, b: number) => a - b)
          .map((number) => ({ number })),
    listed = seriesOf(m) || m,
    target =
      m.kind === "series"
        ? d.episodes
            .filter(resuming)
            .sort(
              (a: any, b: any) =>
                (b.progress.playedAt || 0) - (a.progress.playedAt || 0),
            )[0] ||
          d.episodes.find((e: any) => !e.progress?.completed) ||
          d.episodes[0]
        : m,
    going = resuming(target),
    meta = [
      m.year,
      m.kind === "series"
        ? "Series"
        : m.kind === "episode"
          ? `S${m.season || 1} · E${m.episode || 1} · ${m.title}`
          : "Movie",
      minutes(m),
      state.sources.find((s: any) => s.id === m.sourceID)?.name,
    ]
      .filter(Boolean)
      .join(" · ");
  sheet(
    m.kind === "series" ? "Series" : "Details",
    `<div class="detail-hero"><div class="detail-art-wrap" aria-hidden="true">${art(m, true, "detail-art")}</div><div class="detail-title"><h1>${esc(m.seriesTitle || m.title)}</h1><p>${esc(meta)}</p></div></div><div class="detail-body"><div class="detail-actions">${target ? button(going ? `Resume at ${time(target.progress.seconds)}` : "Play", "play", { id: target.id }, true) : ""}<span class="glass-pill">${button(listed.favorite ? "✓ In Watchlist" : "+ Watchlist", "favorite", { id: listed.id })}${m.kind !== "series" && downloadsEnabled ? button("Download", "download", { id: m.id }) : ""}</span>${["movie", "series"].includes(m.kind) && state.preferences.externalMetadata ? button("Find Artwork", "metadata.search", { id: m.id }) : ""}</div>${
      going
        ? `<div class="resume-block">${m.kind === "series" ? `<strong>${esc(episodeLabel(target))}</strong>` : ""}${progressBar(target)}<small>${time(Math.max(0, target.progress.duration - target.progress.seconds))} left</small></div>`
        : m.kind === "series" && target
          ? `<p class="muted">Starts with ${esc(episodeLabel(target))}</p>`
          : ""
    }<p class="overview">${esc(m.overview || listed.overview || "")}</p>${
      derivedIndex
        ? shelf("More Like This", moreLikeThis(derivedIndex, listed.id), poster)
        : ""
    }${
      m.kind === "series"
        ? `<div class="section-heading"><h2>Episodes</h2>${downloadsEnabled ? button(`Download Season ${seasonNumber}`, "download", { id: m.id, season: seasonNumber }) : ""}</div>${seasons.length > 1 ? `<div class="season-bar" role="group" aria-label="Season">${seasons.map((s: any) => `<button type="button" data-season="${esc(s.number)}" aria-pressed="${seasonNumber === s.number}">Season ${esc(s.number)}</button>`).join("")}</div>` : ""}${
            episodes
              .slice(0, visibleCount("episodes"))
              .map(
                (e: any) =>
                  `<article class="episode"><div class="episode-media"><button type="button" class="episode-thumb cover" data-action="play" data-args="${esc(JSON.stringify({ id: e.id }))}" aria-label="${resuming(e) ? "Resume" : "Play"}">${art(e, true)}<span class="badge" aria-hidden="true">▶</span></button>${resuming(e) ? progressBar(e) : ""}</div><div class="text"><small>S${esc(e.season || 1)} · E${esc(e.episode || 1)}${e.progress?.completed ? " · Watched" : ""}</small><h3>${esc(e.title)}</h3>${resuming(e) ? `<small>Resume at ${time(e.progress.seconds)}</small>` : ""}<p>${esc(e.overview || "")}</p>${downloadsEnabled ? button(e.download ? "Downloaded" : "Download", "download", { id: e.id }) : ""}</div></article>`,
              )
              .join("") || "<p>Choose a season to load its episodes.</p>"
          }${showMore("episodes", episodes.length)}`
        : ""
    }</div>`,
    "detail-sheet",
  );
}
async function chooseSeason(number: number) {
  seasonNumber = number;
  visibleCounts.delete("episodes");
  drawDetail();
  const current = detailData,
    have = current.episodes.some((e: any) => e.season === number);
  try {
    const rows = await cmd("season", { id: current.media.id, number });
    if (detailData !== current || (!rows?.length && have)) return;
    current.episodes = current.episodes
      .filter((x: any) => x.season !== number)
      .concat(rows || []);
    drawDetail();
  } catch (error) {
    // Episodes already in the library stay usable when a season cannot be reloaded.
    if (!have) throw error;
  }
}
function sourceForm(args: any = {}) {
  const s = state.sources.find((s: any) => s.id === args.id);
  const kinds = [
    "Library URL",
    "Jellyfin",
    "Emby",
    "Plex",
    "NAS / WebDAV",
    "Video URL",
    "M3U playlist",
    "Xtream Codes",
  ];
  sheet(
    s ? "Edit Source" : "Add Source",
    `${!s ? '<div class="panel"><h3>Start with a library</h3><p>Import huhu.to with one click, or connect your own server below.</p><button class="primary" data-action="source.huhu">Import huhu.to</button></div>' : ""}<form id="source-form"><input type="hidden" name="id" value="${esc(s?.id || "")}"><div class="field-grid"><label>Name<input name="name" required maxlength="160" value="${esc(s?.name || "")}"></label><label>Source type<select name="kind">${kinds.map((k) => `<option ${k === (s?.kind || args.kind) ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label><label class="full">Server or library URL<input name="endpoint" type="url" required placeholder="https://your-server.example" autocomplete="off"></label><div class="full info">${s ? "Re-enter the URL and credentials when changing a source." : "Library URL example: https://huhu.to · Add only sources you are entitled to access."}</div><label>Username<input name="username" autocomplete="off"></label><label>Password<input name="password" type="password" autocomplete="new-password"></label><label class="full">Access token (if required)<input name="token" type="password" autocomplete="off"></label><label class="full">XMLTV guide URL (optional)<input name="guideURL" type="url" autocomplete="off"></label>${webMode ? '<p class="full info">Use a reachable HTTPS server address. Local HTTP servers are available in the native apps.</p>' : `<label class="full check"><input name="allowHTTP" type="checkbox" ${s?.allowHTTP ? "checked" : ""}>Allow local HTTP for this source</label>`}${webMode ? "" : `<label class="full check"><input name="allowInsecureStreams" type="checkbox" ${s?.allowInsecureStreams ? "checked" : ""}>Allow unencrypted media streams for this source</label>`}<label class="full check"><input name="allowProviderFetch" type="checkbox" ${s?.allowProviderFetch ? "checked" : ""}>Allow provider-assisted requests to public hosts</label><p class="full info">Provider assistance sends a public host response to this library provider to resolve playback. Your Oxa account and other server credentials are excluded.</p></div><p class="form-error error" role="alert"></p><div class="dialog-actions"><button type="button" data-action="sheet.close">Cancel</button><button class="primary" type="submit">${s ? "Save Source" : "Connect Source"}</button></div></form>`,
  );
}
function confirm(title: string, message: string, action: string, args: any) {
  sheet(
    title,
    `<p>${esc(message)}</p><div class="dialog-actions">${button("Cancel", "sheet.close")}<button class="danger" data-action="${esc(action)}" data-args="${esc(JSON.stringify(args))}">Confirm</button></div>`,
  );
}
let accountMode = "signin",
  accountEmail = "",
  accountPassword = "",
  accountRecovery = false,
  accountIncludeGuest = false;
function accountForm(mode = "signin") {
  accountMode = mode;
  const a = state.account,
    d = $("#account");
  if (a.signedIn && mode === "signin") mode = accountMode = "manage";
  const titles: any = {
    signin: "Welcome to Oxa’s Library",
    signup: "Create your account",
    verify: "Check your email",
    forgot: "Reset your password",
    reset: "Choose a new password",
    manage: "Your account",
    unlock: "Unlock encrypted connections",
    password: "Change your password",
    delete: "Delete your account",
  };
  d.innerHTML =
    `<header><h2>${titles[mode] || "Your account"}</h2><button data-action="account.close" aria-label="Close account">×</button></header>` +
    (mode === "manage"
      ? `<p>${esc(a.email)}</p><p class="info">${esc(a.message || (downloadsEnabled ? "Your connections, watch history and watchlist sync between your devices. Downloads stay on this device." : "Your connections, watch history and watchlist sync between your devices."))}</p><div class="sources-choices">${!a.unlocked ? button("Unlock Connections", "account.mode", { mode: "unlock" }) : ""}${button("Sync Now", "sync")}${button("Change Password", "account.mode", { mode: "password" })}${button("Sign Out", "signout")}${button("Delete Account", "account.mode", { mode: "delete" })}</div>`
      : `<p>${esc(mode === "signin" ? "Sign in to bring your connections, watchlist and progress to this device. Your account is optional." : mode === "verify" ? "Enter the code from your email." : mode === "delete" ? "This permanently deletes your Oxa account and synced library data. Re-enter your password to confirm." : mode === "reset" ? "Your sources, watch history and watchlist are kept after a password reset." : mode === "unlock" ? "Use your account password to decrypt your synced server connections." : "")}</p><form id="account-form">${["signin", "signup", "forgot", "verify"].includes(mode) ? `<label>Email<input name="email" type="email" required autocomplete="email" value="${esc(accountEmail)}"></label>` : ""}${mode === "verify" ? '<label>Verification code<input name="code" required inputmode="numeric" autocomplete="one-time-code"></label>' : mode !== "forgot" ? `<label>${mode === "reset" || mode === "password" ? "New password" : "Password"}<input name="password" type="password" required ${["signup", "reset", "password"].includes(mode) ? 'minlength="10" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>` : ""}${["signin", "signup"].includes(mode) ? '<label class="check"><input name="includeGuest" type="checkbox" checked>Include this device’s guest library in my account</label>' : ""}<p class="form-error error" role="alert"></p><button class="primary" type="submit">${mode === "signin" ? "Sign In" : mode === "signup" ? "Create Account" : mode === "forgot" ? "Send Recovery Code" : mode === "verify" ? "Verify Code" : mode === "delete" ? "Permanently Delete Account" : "Continue"}</button>${mode === "signin" ? `${button("Create Account", "account.mode", { mode: "signup" })}${button("Forgot Password?", "account.mode", { mode: "forgot" })}<label class="check"><input id="hide-welcome" type="checkbox" ${state.hideWelcome ? "checked" : ""}>Don’t show this message again</label>${button("Continue as Guest", "account.guest")}` : mode === "verify" ? button("Resend Registration Code", "account.resend") : button("Back to Sign In", "account.mode", { mode: "signin" })}</form>`);
  if (!d.open) d.showModal();
}
// Many hosted servers block browser playback; the native apps can still play them.
const appHint = () =>
  `<p class="info app-hint">Some servers only play in the Oxa’s Library app. <a href="/#downloads" target="_blank" rel="noopener">Get it for iPhone, Mac or Windows</a></p>`;
// The web version opens a server on its own hosting page in a new tab.
function hostPage(c: any) {
  if (!webMode || typeof c.pageURL !== "string") return "";
  try {
    const url = new URL(c.pageURL);
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}
function serverChoice(c: any, action: string, args: any) {
  const label = `<strong>${esc(c.name || c.providerName || "Server")}</strong><small>${esc([c.quality, c.languages?.join(", "), c.providerName].filter(Boolean).join(" · "))}</small>`;
  const page = hostPage(c);
  return page
    ? `<a class="server-link" href="${esc(page)}" target="_blank" rel="noopener noreferrer">${label}<small>Opens on ${esc(new URL(page).hostname)} ↗</small></a>`
    : `<button data-action="${action}" data-args="${esc(JSON.stringify({ ...args, choiceID: c.id }))}">${label}</button>`;
}
async function start(args: any, operation = "play") {
  if (!downloadsEnabled && operation === "download") return;
  let result: any;
  try {
    result = await cmd(operation, args);
  } catch (e: any) {
    if (!webMode || !args.choiceID || !$("#sheet").open) throw e;
    let note = $("#sheet .playback-note");
    if (!note) {
      note = document.createElement("div");
      note.className = "playback-note";
      $("#sheet .sources-choices")?.before(note);
    }
    note.innerHTML = `<p class="error" role="alert">${esc(e.message || "This server can’t play in a browser.")}</p>${appHint()}`;
    note.scrollIntoView({ block: "nearest", behavior: "smooth" });
    return;
  }
  if (!result) return;
  if (result.choices) {
    sheet(
      "Sources",
      `<p>${result.choices.some(hostPage) ? "Choose a server. It opens on its hosting site in a new tab." : "Choose a playback server. Your watch progress is kept."}</p><div class="sources-choices">${result.choices
        .filter((c: any) => c.kind !== "website")
        .map((c: any) => serverChoice(c, operation, args))
        .join("")}</div>${providerAssistance(result.media?.sourceID)}`,
    );
    return;
  }
  if (downloadsEnabled && result.queued) {
    $("#sheet").close();
    toast("Added to downloads.");
    return;
  }
  if (!result.url) return;
  $("#sheet").close();
  await showPlayer(result);
}
async function saveProgress(ended = false) {
  if (playback && Number.isFinite(video.currentTime))
    try {
      await cmd("progress", {
        id: playback.media.id,
        seconds: video.currentTime,
        duration: Number.isFinite(video.duration) ? video.duration : 0,
        ended,
      });
    } catch {}
}
function destroyPlayer() {
  clearInterval(progressTimer);
  clearInterval(countdown);
  countdown = null;
  hls?.destroy();
  hls = null;
  transportPlayer?.destroy();
  transportPlayer = null;
  video.pause();
  video.removeAttribute("src");
  video.load();
  video.querySelectorAll("track").forEach((e) => e.remove());
}
async function showPlayer(result: any) {
  if (webMode && !allowedMediaURL(result.url, false, result.direct === true))
    throw Error(
      "This playback source is unavailable. Choose another server or refresh the source.",
    );
  if (webMode && result.caption && !allowedMediaURL(result.caption, true))
    result = { ...result, caption: undefined };
  await saveProgress();
  destroyPlayer();
  playback = result;
  seekPending = result.resume || 0;
  countdownCanceled = false;
  $("#up-next").hidden = true;
  $("#playback-error").hidden = true;
  $("#player").hidden = false;
  document.body.classList.add("player-open");
  $("#player-title").textContent =
    result.media.seriesTitle || result.media.title;
  $("#player-subtitle").textContent = episodeLabel(result.media);
  $("#next").hidden = result.media.kind !== "episode";
  $("#pip").hidden = !document.pictureInPictureEnabled;
  video.playbackRate = Number($("#speed").value);
  if (result.caption) {
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Preferred subtitles";
    track.srclang = state.preferences.subtitleLanguage === "de" ? "de" : "en";
    track.src = result.caption;
    track.default = true;
    video.append(track);
  }
  if (result.format === "hls" && Hls.isSupported()) {
    hls = new Hls({ enableWorker: false, backBufferLength: 60 });
    hls.loadSource(result.url);
    hls.attachMedia(video);
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      tracks();
      void video.play().catch(() => {});
    });
    hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, tracks);
    hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED, tracks);
    hls.on(Hls.Events.ERROR, (_e, data) => {
      if (data.fatal) playError();
    });
  } else if (
    ["mpegts", "ts", "flv"].includes(result.format) &&
    mpegts.isSupported()
  ) {
    transportPlayer = mpegts.createPlayer(
      {
        type: result.format === "flv" ? "flv" : "mpegts",
        isLive: result.media.kind === "channel",
        url: result.url,
      },
      { enableWorker: false, enableStashBuffer: true },
    );
    transportPlayer.attachMediaElement(video);
    transportPlayer.on(mpegts.Events.ERROR, playError);
    transportPlayer.load();
    void transportPlayer.play().catch(() => {});
  } else {
    video.src = result.url;
    void video.play().catch(() => {});
  }
  progressTimer = setInterval(() => void saveProgress(), 5000);
  wake();
}
function playError() {
  $("#playback-error").hidden = false;
  if (webMode)
    $("#playback-error").innerHTML =
      `<p>This server doesn’t allow playback in a browser. Close the player and try another server.</p>${appHint()}`;
  else
    $("#playback-error").textContent =
      "This video could not be played. Check your connection, media format and the source server. Try another playback server if one is available.";
}
function tracks() {
  const audio = hls?.audioTracks || [],
    subs = hls?.subtitleTracks || [];
  $("#tracks").innerHTML = audio.length
    ? audio
        .map(
          (t: any, i: number) =>
            `<option value="${i}" ${hls.audioTrack === i ? "selected" : ""}>${esc(t.name || t.lang || `Audio ${i + 1}`)}</option>`,
        )
        .join("")
    : "<option>Original audio</option>";
  $("#tracks").disabled = !audio.length;
  $("#subtitles").innerHTML =
    '<option value="-1">Subtitles off</option>' +
    subs
      .map(
        (t: any, i: number) =>
          `<option value="${i}" ${hls.subtitleTrack === i ? "selected" : ""}>${esc(t.name || t.lang || `Subtitles ${i + 1}`)}</option>`,
      )
      .join("") +
    (playback?.caption
      ? '<option value="external" selected>Preferred subtitles</option>'
      : "");
  if (hls && audio.length) {
    const i = audio.findIndex((t: any) =>
      String(t.lang).startsWith(state.preferences.audioLanguage),
    );
    if (i >= 0) hls.audioTrack = i;
  }
  if (
    hls &&
    state.preferences.subtitleLanguage !== "off" &&
    !playback.caption
  ) {
    const i = subs.findIndex((t: any) =>
      String(t.lang).startsWith(state.preferences.subtitleLanguage),
    );
    if (i >= 0) {
      hls.subtitleTrack = i;
      $("#subtitles").value = String(i);
    }
  }
}
async function next() {
  await saveProgress();
  clearInterval(countdown);
  countdown = null;
  $("#up-next").hidden = true;
  const r = await cmd("next");
  if (!r) {
    countdownCanceled = true;
    toast("You’ve reached the last available episode.");
    return;
  }
  if (r.choices) {
    sheet(
      "Next Episode",
      `<div class="sources-choices">${r.choices
        .filter((c: any) => c.kind !== "website")
        .map((c: any) =>
          hostPage(c)
            ? serverChoice(c, "play", { id: r.media.id })
            : button(c.name || "Server", "play", {
                id: r.media.id,
                choiceID: c.id,
              }),
        )
        .join("")}</div>${providerAssistance(r.media?.sourceID)}`,
    );
  } else await showPlayer(r);
}
function upNext() {
  if (
    !playback ||
    playback.media.kind !== "episode" ||
    !state.preferences.autoplay ||
    countdownCanceled ||
    countdown ||
    !Number.isFinite(video.duration) ||
    video.duration < 20
  )
    return;
  const threshold =
    playback.media.creditsStart ||
    video.duration - Math.min(30, Math.max(5, video.duration * 0.02));
  if (video.currentTime < threshold) return;
  let n = 3;
  $("#up-next").hidden = false;
  const draw = () =>
    ($("#up-next").innerHTML =
      `<p>Next episode plays in ${n}…</p>${button("Play Now", "player.next")}${button("Cancel", "player.cancel-next")}`);
  draw();
  countdown = setInterval(() => {
    if (video.paused && !video.ended) return;
    n--;
    if (n <= 0) {
      void run(next);
    } else draw();
  }, 1000);
}
function wake() {
  $("#player").classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!video.paused && !$("#sheet").open && !$("#account").open)
      $("#player").classList.add("idle");
  }, 4000);
}
video.addEventListener("loadedmetadata", () => {
  if (seekPending && Number.isFinite(video.duration))
    video.currentTime = Math.min(seekPending, video.duration);
  seekPending = 0;
  tracks();
});
video.addEventListener("error", playError);
video.addEventListener("timeupdate", () => {
  $("#elapsed").textContent = time(video.currentTime);
  $("#duration").textContent = Number.isFinite(video.duration)
    ? time(video.duration)
    : "LIVE";
  if (Number.isFinite(video.duration) && !$("#seek").matches(":active"))
    $("#seek").value = String((video.currentTime / video.duration) * 1000);
  upNext();
});
video.addEventListener("play", () => ($("#toggle-play").textContent = "Pause"));
video.addEventListener("pause", () => {
  $("#toggle-play").textContent = "Play";
  void saveProgress();
  wake();
});
video.addEventListener("ended", () => {
  void saveProgress(true);
  if (
    state.preferences.autoplay &&
    playback?.media.kind === "episode" &&
    !countdownCanceled &&
    !countdown
  )
    void run(next);
});
$("#toggle-play").onclick = () =>
  video.paused ? void video.play().catch(playError) : video.pause();
$("#rewind").onclick = () =>
  (video.currentTime = Math.max(0, video.currentTime - 10));
$("#forward").onclick = () =>
  (video.currentTime = Math.min(
    video.duration || Infinity,
    video.currentTime + 10,
  ));
$("#next").onclick = () => void run(next);
$("#fullscreen").onclick = () =>
  void run(async () => {
    if (!webMode) return cmd("fullscreen");
    if (document.fullscreenElement) await document.exitFullscreen();
    else if ($("#player").requestFullscreen)
      await $("#player").requestFullscreen();
    else if ((video as any).webkitEnterFullscreen)
      (video as any).webkitEnterFullscreen();
    else throw Error("Fullscreen is unavailable in this browser.");
  });
$("#fit").onclick = () => {
  const fill = $("#player").classList.toggle("fill");
  $("#fit").textContent = fill ? "Fit" : "Fill";
};
$("#pip").onclick = () =>
  void run(() =>
    document.pictureInPictureElement
      ? document.exitPictureInPicture()
      : video.requestPictureInPicture(),
  );
$("#close-player").onclick = () =>
  void run(async () => {
    await saveProgress();
    // In the browser, returning to the library is the visible completion of
    // close. Make the IndexedDB durability barrier precede that completion so
    // an immediate reload does not discard the position just recorded above.
    if (webMode) await cmd("closePlayer");
    destroyPlayer();
    playback = null;
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
    if (webMode && document.fullscreenElement)
      await document.exitFullscreen().catch(() => {});
    if (!webMode) await cmd("closePlayer");
    render();
  });
$("#volume").oninput = (e: any) => (video.volume = Number(e.target.value));
$("#speed").onchange = (e: any) =>
  (video.playbackRate = Number(e.target.value));
$("#seek").oninput = (e: any) => {
  seekPending = 0;
  if (Number.isFinite(video.duration))
    video.currentTime = (Number(e.target.value) / 1000) * video.duration;
};
$("#tracks").onchange = (e: any) => {
  if (hls) hls.audioTrack = Number(e.target.value);
};
$("#subtitles").onchange = (e: any) => {
  if (hls)
    hls.subtitleTrack =
      e.target.value === "external" ? -1 : Number(e.target.value);
  for (const t of Array.from(video.textTracks))
    t.mode = e.target.value === "external" ? "showing" : "disabled";
};
$("#import-caption").onclick = () =>
  void run(async () => {
    const result = await cmd("caption.import");
    if (!result || (webMode && !allowedMediaURL(result.url, true))) return;
    for (const t of Array.from(video.textTracks)) t.mode = "disabled";
    video.querySelectorAll("track").forEach((t) => t.remove());
    const track = document.createElement("track");
    track.kind = "subtitles";
    track.label = "Imported subtitles";
    track.src = result.url;
    track.default = true;
    video.append(track);
    playback.caption = result.url;
    tracks();
  });
$("#player").onmousemove = wake;
$("#player").onclick = wake;
document.addEventListener("click", (event: any) => {
  const b = event.target.closest("button");
  if (!b) return;
  if (b.dataset.page) {
    if (!downloadsEnabled && b.dataset.page === "Downloads") return;
    page = b.dataset.page;
    query = "";
    searchEpoch++;
    searchRows = [];
    render();
    $("#content").focus();
    return;
  }
  if (b.dataset.filter) {
    filter = b.dataset.filter;
    render();
    return;
  }
  if (b.dataset.season && detailData) {
    void run(() => chooseSeason(Number(b.dataset.season)));
    return;
  }
  if (b.dataset.shelfDir) {
    const row = b.closest(".shelf")?.querySelector(".shelf-row");
    row?.scrollBy({
      left: Number(b.dataset.shelfDir) * row.clientWidth * 0.85,
      behavior: reduceMotion() ? "auto" : "smooth",
    });
    return;
  }
  if (b.dataset.heroSlide != null) {
    heroIndex = Number(b.dataset.heroSlide);
    applyHero();
    return;
  }
  if (b.dataset.group != null && b.closest(".chips")) {
    group = b.dataset.group;
    render();
    return;
  }
  if (b.dataset.action)
    void run(async () => {
      const a = b.dataset.action,
        args = JSON.parse(b.dataset.args || "{}");
      if (
        !downloadsEnabled &&
        (a === "download" ||
          a.startsWith("transfer.") ||
          a === "downloadDirectory")
      )
        return;
      if (a === "rows.more") {
        visibleCounts.set(args.key, visibleCount(args.key) + 100);
        if (args.key === "episodes") drawDetail();
        else render();
        return;
      }
      if (a === "sheet.close") {
        $("#sheet").close();
        return;
      }
      if (a === "source.huhu") {
        b.disabled = true;
        try {
          await cmd("source.add", {
            name: "huhu.to",
            kind: "Library URL",
            endpoint: "https://huhu.to",
          });
          $("#sheet").close();
          toast("Importing huhu.to…");
        } finally {
          b.disabled = false;
        }
        return;
      }
      if (a === "donation.copy") {
        await cmd(a, args);
        toast("Address copied.");
        return;
      }
      if (a === "source.form") {
        sourceForm(args);
        return;
      }
      if (a === "source.confirm-remove") {
        confirm(
          "Remove Source?",
          downloadsEnabled
            ? "This removes the source from your synced library. Saved downloads and watch progress are kept."
            : "This removes the source from your synced library. Your watch progress is kept.",
          "source.remove",
          args,
        );
        return;
      }
      if (a === "transfer.confirm-delete") {
        confirm(
          "Delete Download?",
          "This removes the downloaded media from this device. You can download it again.",
          "transfer.delete",
          args,
        );
        return;
      }
      if (a === "detail") {
        await openDetail(args.id);
        return;
      }
      if (a === "play" || a === "download") {
        await start(args, a);
        return;
      }
      if (a === "metadata.search") {
        const rows = await cmd(a, args);
        sheet(
          "Choose Metadata",
          `<div class="search-results">${rows.map((row: any) => `<button type="button" class="row" data-action="metadata.apply" data-args="${esc(JSON.stringify({ ...args, choiceID: row.id }))}">${image(row.poster)}<span class="text"><strong>${esc(row.title)}</strong><small>${esc(row.year || "")}</small></span></button>`).join("") || "<p>No matching titles were found.</p>"}</div>`,
        );
        return;
      }
      if (a === "metadata.apply") {
        detailData = await cmd(a, args);
        drawDetail();
        return;
      }
      if (a === "update.check.manual") {
        await checkUpdates();
        return;
      }
      if (a === "licenses") {
        sheet(
          "Open Source Licenses",
          `<pre class="licenses">${esc(await cmd("licenses"))}</pre>`,
        );
        return;
      }
      if (a === "guide") {
        const rows = state.programs
          .filter((p: any) => p.mediaID === args.id)
          .sort((a: any, b: any) => a.start - b.start);
        sheet(
          "Program Guide",
          rows.length
            ? rows
                .map(
                  (p: any) =>
                    `<article class="program"><small>${esc(new Date((p.start + 978307200) * 1000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }))}</small><h3>${esc(p.title)}</h3><p>${esc(p.overview || "")}</p></article>`,
                )
                .join("")
            : "<p>No guide is available. Add an XMLTV guide URL to your playlist source.</p>",
        );
        return;
      }
      if (a === "channels.favorites") {
        starred = !starred;
        render();
        return;
      }
      if (a === "search.run") {
        query = $("#search-query").value;
        const epoch = ++searchEpoch;
        searchRows = await cmd("search", { query });
        if (epoch === searchEpoch) render();
        return;
      }
      if (a === "account.open") {
        accountForm();
        return;
      }
      if (a === "account.mode") {
        accountForm(args.mode);
        return;
      }
      if (a === "account.close") {
        await cmd("welcome", {
          hide: $("#hide-welcome")?.checked || state.hideWelcome,
        });
        accountPassword = "";
        $("#account").close();
        return;
      }
      if (a === "account.guest") {
        await cmd("welcome", { hide: $("#hide-welcome")?.checked || false });
        $("#account").close();
        return;
      }
      if (a === "account.resend") {
        toast(
          (await cmd("account", { action: "resend", email: accountEmail }))
            .message,
        );
        return;
      }
      if (a === "player.next") {
        await next();
        return;
      }
      if (a === "player.cancel-next") {
        clearInterval(countdown);
        countdown = null;
        countdownCanceled = true;
        $("#up-next").hidden = true;
        return;
      }
      const result = await cmd(a, args);
      if (["source.remove", "transfer.delete"].includes(a)) $("#sheet").close();
      if (a === "signout") {
        $("#account").close();
        accountPassword = "";
      }
      if (result?.sources) {
        state = result;
        render();
      }
      if (a === "favorite" && detailData && $("#sheet").open) {
        const m = state.media.find((m: any) => m.id === detailData.media.id);
        if (m) {
          detailData.media.favorite = m.favorite;
          drawDetail();
        }
      }
    });
});
document.addEventListener("submit", (event: any) => {
  event.preventDefault();
  const form = event.target,
    data: any = Object.fromEntries(new FormData(form).entries()),
    submit = form.querySelector("[type=submit]");
  if (submit.disabled) return;
  submit.disabled = true;
  void (async () => {
    try {
      if (form.getAttribute("id") === "metadata-form") {
        await cmd("metadata.token", { token: data.token });
        form.reset();
        toast(
          data.token ? "Metadata search enabled." : "Metadata search disabled.",
        );
      } else if (form.getAttribute("id") === "source-form") {
        if (!data.id) delete data.id;
        for (const key of [
          "allowHTTP",
          "allowInsecureStreams",
          "allowProviderFetch",
        ])
          data[key] = form.elements[key]?.checked === true;
        await cmd(data.id ? "source.edit" : "source.add", data);
        $("#sheet").close();
        state = await cmd("state");
        render();
        toast("Source connected. Loading its library…");
      } else if (form.getAttribute("id") === "account-form") {
        if (data.email) accountEmail = data.email;
        if (accountMode === "signup") accountPassword = data.password;
        if (["signin", "signup"].includes(accountMode))
          accountIncludeGuest = !!form.elements.includeGuest?.checked;
        let args = {
          ...data,
          action: accountMode,
          email: data.email || accountEmail,
          password: accountMode === "verify" ? accountPassword : data.password,
          recovery: accountRecovery,
          includeGuest: accountIncludeGuest,
        };
        if (accountMode === "delete") {
          await cmd("deleteAccount", { password: data.password });
          $("#account").close();
          toast("Your account was deleted.");
          return;
        }
        const result = await cmd("account", args);
        if (result.verification) {
          accountRecovery = false;
          accountForm("verify");
        } else if (result.recovery) {
          accountRecovery = true;
          accountForm("verify");
        } else if (result.reset) accountForm("reset");
        else {
          $("#account").close();
          accountPassword = "";
          state = await cmd("state");
          render();
        }
        if (result.message) toast(result.message);
      }
    } catch (e: any) {
      const target = form.querySelector(".form-error");
      if (target) target.textContent = e.message;
      else toast(e.message);
    } finally {
      if (submit.isConnected) submit.disabled = false;
    }
  })();
});
document.addEventListener("change", (event: any) => {
  const e = event.target;
  void run(async () => {
    if (webMode && e.matches("[data-provider-assistance]")) {
      const id = e.dataset.sourceId,
        enabled = e.checked;
      const account = lastAccount;
      const version = (permissionVersions.get(id) || 0) + 1;
      permissionVersions.set(id, version);
      try {
        const result = await cmd("source.permission", { id, enabled });
        if (
          permissionVersions.get(id) === version &&
          account === lastAccount &&
          result?.sources
        ) {
          state = result;
          sidebar();
        }
      } catch (error) {
        if (permissionVersions.get(id) === version) e.checked = !enabled;
        throw error;
      }
      return;
    }
    if (e.id === "source-filter") {
      source = e.value;
      render();
    }
    if (e.id === "channel-group") {
      group = e.value;
      render();
    }
    if (e.id === "sort") {
      sortOrder = e.value;
      visibleCounts.delete("library");
      render();
    }
    if (["autoplay", "audio-language", "subtitle-language"].includes(e.id)) {
      await cmd("preferences", {
        autoplay: $("#autoplay")?.checked,
        audioLanguage: $("#audio-language")?.value,
        subtitleLanguage: $("#subtitle-language")?.value,
      });
    }
  });
});
document.addEventListener("input", (event: any) => {
  if (event.target.id === "channel-query") {
    query = event.target.value;
    const pos = event.target.selectionStart;
    render();
    $("#channel-query").focus();
    $("#channel-query").setSelectionRange(pos, pos);
  }
  if (event.target.id === "search-query") {
    query = event.target.value;
    searchRows = [];
    const pos = event.target.selectionStart;
    render();
    $("#search-query").focus();
    $("#search-query").setSelectionRange(pos, pos);
  }
});
document.addEventListener("keydown", (e: KeyboardEvent) => {
  const target = e.target as HTMLElement,
    typing = target?.matches?.("input,select,textarea"),
    covered = !$("#player").hidden || $("#sheet").open || $("#account").open;
  if (e.key === "Escape" && (!menu.hidden || !preview.hidden)) {
    e.preventDefault();
    closeMenu(true);
    closePreview();
    return;
  }
  if (!menu.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    const items = Array.from(menu.querySelectorAll("button")) as HTMLElement[],
      at = items.indexOf(document.activeElement as HTMLElement),
      step = e.key === "ArrowDown" ? 1 : -1;
    items[(at + step + items.length) % items.length]?.focus();
    return;
  }
  // "/" or Cmd/Ctrl+K jump to search from anywhere in the library.
  if (
    !covered &&
    (((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") ||
      (e.key === "/" && !typing))
  ) {
    e.preventDefault();
    if (page !== "Search") {
      page = "Search";
      query = "";
      searchEpoch++;
      searchRows = [];
      render();
    }
    $("#search-query")?.focus();
    return;
  }
  // Arrow keys move between the cards of a shelf.
  const card = target?.closest?.(".shelf-row > *");
  if (card && !covered && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
    const next = (
      e.key === "ArrowRight"
        ? card.nextElementSibling
        : card.previousElementSibling
    ) as HTMLElement | null;
    if (next) {
      e.preventDefault();
      next.focus();
      next.scrollIntoView({
        block: "nearest",
        inline: "nearest",
        behavior: reduceMotion() ? "auto" : "smooth",
      });
    }
    return;
  }
  if (e.key === "Enter" && (e.target as HTMLElement)?.id === "search-query") {
    e.preventDefault();
    void run(async () => {
      searchRows = await cmd("search", { query });
      render();
    });
    return;
  }
  if ((e.target as HTMLElement)?.matches("input,select,textarea")) return;
  if (!$("#player").hidden && !$("#sheet").open && !$("#account").open) {
    if (e.code === "Space") {
      e.preventDefault();
      $("#toggle-play").click();
    }
    if (e.code === "ArrowLeft") $("#rewind").click();
    if (e.code === "ArrowRight") $("#forward").click();
    if (e.code === "Escape") $("#close-player").click();
    wake();
  } else if (e.key === "Enter" && page === "Search")
    void run(async () => {
      searchRows = await cmd("search", { query });
      render();
    });
});
// Hover preview and context menu: one shared element each, filled from the
// title's published data and positioned through CSS variables (never inline styles).
const preview = document.createElement("div"),
  menu = document.createElement("div");
preview.id = "preview";
preview.hidden = true;
preview.setAttribute("role", "dialog");
preview.setAttribute("aria-label", "Title preview");
menu.id = "context-menu";
menu.hidden = true;
menu.setAttribute("role", "menu");
document.body.append(preview, menu);
let previewTimer: any,
  previewCard: Element | null = null,
  menuCard: HTMLElement | null = null,
  mediaIndex = new Map<string, any>(),
  mediaIndexOf: any = null;
function lookup(id: string) {
  if (mediaIndexOf !== state.media) {
    mediaIndexOf = state.media;
    mediaIndex = new Map(state.media.map((m: any) => [m.id, m]));
    for (const t of state.transfers || [])
      if (!mediaIndex.has(t.media.id)) mediaIndex.set(t.media.id, t.media);
  }
  return mediaIndex.get(id);
}
const place = (el: HTMLElement, x: number, y: number) => {
  el.style.setProperty("--x", `${Math.round(x)}px`);
  el.style.setProperty("--y", `${Math.round(y)}px`);
};
function closePreview() {
  clearTimeout(previewTimer);
  previewCard = null;
  preview.classList.remove("open");
  preview.hidden = true;
}
function closeMenu(restoreFocus = false) {
  if (menu.hidden) return;
  menu.hidden = true;
  if (restoreFocus) menuCard?.focus();
  menuCard = null;
}
function showPreview(card: HTMLElement) {
  const m = lookup(card.dataset.id || "");
  if (!m) return;
  const listed = seriesOf(m) || m,
    going = resuming(m),
    action =
      m.kind === "series"
        ? button("Details", "detail", { id: m.id }, true)
        : button(going ? "Resume" : "Play", "play", { id: m.id }, true);
  preview.innerHTML = `<span class="cover">${art(m, true)}</span><div class="preview-copy"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc([episodeLabel(m), minutes(m)].filter(Boolean).join(" · "))}</small>${m.overview || listed.overview ? `<p>${esc(m.overview || listed.overview)}</p>` : ""}${going ? progressBar(m) : ""}<div class="preview-actions">${action}${button(listed.favorite ? "Remove from Watchlist" : "Add to Watchlist", "favorite", { id: listed.id })}</div></div>`;
  markLoaded(preview);
  preview.hidden = false;
  const r = card.getBoundingClientRect(),
    w = preview.offsetWidth,
    h = preview.offsetHeight;
  let x = r.right + 12;
  if (x + w > innerWidth - 12) x = r.left - w - 12;
  place(
    preview,
    Math.max(12, x),
    Math.max(12, Math.min(r.top - 8, innerHeight - h - 12)),
  );
  requestAnimationFrame(() => preview.classList.add("open"));
}
const canHover = matchMedia("(hover: hover) and (min-width: 761px)");
document.addEventListener("pointerover", (e: any) => {
  if (!canHover.matches || e.pointerType === "touch") return;
  if (preview.contains(e.target)) return void clearTimeout(previewTimer);
  const card = e.target.closest?.(".poster, .continue-card");
  if (!card || card === previewCard) return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (!card.isConnected || !menu.hidden || $("#sheet").open) return;
    if ($("#account").open || !$("#player").hidden) return;
    previewCard = card;
    showPreview(card);
  }, 400);
});
document.addEventListener("pointerout", (e: any) => {
  const from = e.target.closest?.(".poster, .continue-card, #preview"),
    to = e.relatedTarget;
  if (!from) return;
  if (
    to &&
    (from.contains(to) || preview.contains(to) || previewCard?.contains(to))
  )
    return;
  clearTimeout(previewTimer);
  previewTimer = setTimeout(closePreview, 150);
});
document.addEventListener("scroll", () => closePreview(), {
  capture: true,
  passive: true,
});
addEventListener("blur", () => {
  closePreview();
  closeMenu();
});
addEventListener("resize", () => {
  closePreview();
  closeMenu();
});
// A click anywhere closes the menu and the preview; their own buttons still act.
document.addEventListener(
  "click",
  (e: any) => {
    if (menu.contains(e.target) || preview.contains(e.target))
      setTimeout(() => {
        closeMenu();
        closePreview();
      });
    else {
      closeMenu();
      closePreview();
    }
  },
  true,
);
document.addEventListener("contextmenu", (e: any) => {
  const card = e.target.closest?.(
    ".poster, .continue-card, .hero-slide, .search-results .row",
  );
  const m = card && lookup(card.dataset.id || "");
  if (!m) return;
  e.preventDefault();
  closePreview();
  const listed = seriesOf(m) || m,
    item = (label: string, action: string, args: any) =>
      `<button type="button" role="menuitem" data-action="${esc(action)}" data-args="${esc(JSON.stringify(args))}">${esc(label)}</button>`;
  menu.innerHTML = [
    m.kind !== "series"
      ? item(resuming(m) ? "Resume" : "Play", "play", { id: m.id })
      : "",
    item("Details", "detail", { id: listed.id }),
    item(
      listed.favorite ? "Remove from Watchlist" : "Add to Watchlist",
      "favorite",
      { id: listed.id },
    ),
    downloadsEnabled && ["movie", "episode"].includes(m.kind)
      ? item("Download", "download", { id: m.id })
      : "",
  ].join("");
  menuCard = card;
  menu.hidden = false;
  const r = card.getBoundingClientRect(),
    keyboard = e.clientX === 0 && e.clientY === 0,
    x = keyboard ? r.left + 16 : e.clientX,
    y = keyboard ? r.top + 16 : e.clientY;
  place(
    menu,
    Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)),
    Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)),
  );
  (menu.querySelector("button") as HTMLElement | null)?.focus();
});
window.oxa.onUpdate((update) => {
  const statuses = update.partial
    ? new Map((update.mediaUpdates || []).map((m: any) => [m.id, m]))
    : null;
  const s = update.partial
    ? {
        ...state,
        ...(update.transfers ? { transfers: update.transfers } : {}),
        ...(update.account ? { account: update.account } : {}),
        media: state.media.map((m: any) =>
          statuses.has(m.id) ? { ...m, ...(statuses.get(m.id) as any) } : m,
        ),
      }
    : update;
  const focused = document.activeElement as HTMLInputElement,
    typing = focused?.matches("input,select,textarea");
  if (lastAccount !== (s.account.email || "") && playback) {
    destroyPlayer();
    playback = null;
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
  }
  lastAccount = s.account.email || "";
  state = s;
  if (!typing) render();
  else sidebar();
});
async function checkUpdates() {
  state = await cmd("update.check", { manual: true });
  render();
  if (state.update?.state === "none")
    toast(`Oxa’s Library ${state.version} is the latest version.`);
}
window.oxa.onAction((a) => {
  if (a === "add-source") sourceForm();
  if (a === "check-updates" && !webMode) {
    page = "Settings";
    void run(checkUpdates);
  }
});
void run(async () => {
  state = await cmd("state");
  lastAccount = state.account.email || "";
  render();
  if (!state.account.signedIn && !state.hideWelcome) accountForm();
});
