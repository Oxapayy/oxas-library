import Hls from "hls.js";
import mpegts from "mpegts.js";
mpegts.LoggingControl.enableAll = false;
declare global {
  interface Window {
    oxa: {
      command: (action: string, args?: any) => Promise<any>;
      onUpdate: (fn: (s: any) => void) => () => void;
      onAction: (fn: (s: string) => void) => () => void;
    };
  }
}
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
  IPTV: '<rect x="2" y="4" width="20" height="14" rx="2"/><path d="M8 22h8M12 18v4"/>',
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
  seasonNumber = 1;
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
const image = (url: string, alt = "", cls = "") =>
  url && url.startsWith("oxa://")
    ? `<img src="${esc(url)}" alt="${esc(alt)}" class="${esc(cls)}" loading="lazy">`
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
  $("#sidebar").innerHTML =
    `<div class="brand"><span class="brand-mark">▶</span><span class="name">Oxa’s Library</span></div><nav>${Object.keys(
      icons,
    )
      .map(
        (name) =>
          `<button data-page="${name}" ${page === name ? 'aria-current="page"' : ""}><svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg><span class="label">${name}</span></button>`,
      )
      .join(
        "",
      )}</nav><button class="sidebar-account" data-action="account.open">${account.signedIn ? "Your account" : "Sign in"}<small>${esc(account.email || "Your collection. On your terms.")}</small></button>`;
}
function render() {
  sidebar();
  const content = $("#content");
  if (page === "Library") content.innerHTML = library();
  else if (page === "Search") content.innerHTML = search();
  else if (page === "IPTV") content.innerHTML = iptv();
  else if (page === "Downloads") content.innerHTML = downloads();
  else content.innerHTML = settings();
}
function poster(m: any) {
  return `<button class="poster" data-action="detail" data-args="${esc(JSON.stringify({ id: m.id }))}"><span class="cover">${image(m.poster || m.backdrop) || "▷"}</span><strong>${esc(m.title)}</strong><small>${esc(episodeLabel(m))}</small></button>`;
}
function library() {
  let rows = state.media.filter(
    (m: any) => m.kind === "movie" || m.kind === "series",
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
      (m: any, i: number, all: any[]) =>
        m.kind !== "episode" ||
        all.findIndex(
          (x) => x.sourceID === m.sourceID && x.seriesID === m.seriesID,
        ) === i,
    );
  if (filter === "Movies") rows = rows.filter((m: any) => m.kind === "movie");
  if (filter === "Series") rows = rows.filter((m: any) => m.kind === "series");
  if (filter === "Watchlist") rows = rows.filter((m: any) => m.favorite);
  if (source) rows = rows.filter((m: any) => m.sourceID === source);
  return (
    heading(
      "Library",
      button("Refresh", "refresh") +
        button("+ Add Source", "source.form", {}, true),
    ) +
    (state.sources.length
      ? `<div class="toolbar"><div class="segments">${["All", "Movies", "Series", "Watchlist"].map((x) => `<button data-filter="${x}" aria-pressed="${filter === x}">${x}</button>`).join("")}</div><span class="spacer"></span><select id="source-filter" aria-label="Source"><option value="">All sources</option>${state.sources.map((s: any) => `<option value="${esc(s.id)}" ${s.id === source ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></div>`
      : "") +
    (state.media.some(
      (m: any) => m.newEpisode && (!source || m.sourceID === source),
    )
      ? `<h2>New Episodes</h2><div class="continue">${state.media
          .filter(
            (m: any) => m.newEpisode && (!source || m.sourceID === source),
          )
          .map(
            (m: any) =>
              `<button class="continue-card" data-action="play" data-args="${esc(JSON.stringify({ id: m.id }))}">${image(m.backdrop || m.poster) || '<div class="still"></div>'}<div class="copy"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc(episodeLabel(m))} · ${esc(m.title)}</small><span>▶ Play Episode</span></div></button>`,
          )
          .join("")}</div>`
      : "") +
    (continued.length
      ? `<h2>Continue Watching</h2><div class="continue">${continued.map((m: any) => `<button class="continue-card" data-action="play" data-args="${esc(JSON.stringify({ id: m.id }))}">${image(m.backdrop || m.poster) || '<div class="still"></div>'}<div class="copy"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc(episodeLabel(m))}</small><progress max="${m.progress.duration || 1}" value="${m.progress.seconds}"></progress><small>${time(m.progress.seconds)} · ${time(Math.max(0, m.progress.duration - m.progress.seconds))} remaining</small></div></button>`).join("")}</div>`
      : "") +
    (!state.sources.length
      ? blank(
          "Your library starts here.",
          "Connect your media server, library URL or video source. Your watch progress stays with you.",
          button("Import huhu.to", "source.huhu", {}, true) +
            button("Connect Your Own Server", "source.form"),
        )
      : rows.length
        ? `<div class="section-heading"><h2>${filter === "All" ? "Your Collection" : esc(filter)}</h2><span class="muted">${rows.length}</span></div><div class="grid">${rows.map(poster).join("")}</div><div class="section-heading">${button("Load more", "more")}</div>`
        : blank(
            state.sources.some((s: any) => s.refreshing)
              ? "Loading your library…"
              : "No titles here yet.",
            state.sources.some((s: any) => s.refreshing)
              ? "You can keep using the app while your sources update."
              : "Refresh your source or check its connection in Settings.",
          )) +
    state.sources
      .filter((s: any) => s.error)
      .map((s: any) => `<p class="error">${esc(s.name)}: ${esc(s.error)}</p>`)
      .join("")
  );
}
function search() {
  const q = query.toLocaleLowerCase(),
    local = state.media.filter(
      (m: any) =>
        ["movie", "series"].includes(m.kind) &&
        (!q ||
          `${m.title} ${m.seriesTitle || ""}`.toLocaleLowerCase().includes(q)),
    ),
    rows = [
      ...local,
      ...searchRows.filter(
        (m) =>
          ["movie", "series"].includes(m.kind) &&
          !local.some((x: any) => x.id === m.id),
      ),
    ];
  return (
    heading("Search") +
    `<div class="toolbar"><input class="search-input" id="search-query" type="search" placeholder="Films and series" aria-label="Search your library" value="${esc(query)}">${button("Search", "search.run")}</div><div class="search-results">${rows
      .slice(0, 250)
      .map(
        (m: any) =>
          `<button class="row" data-action="detail" data-args="${esc(JSON.stringify({ id: m.id }))}">${image(m.poster || m.backdrop)}<span class="text"><strong>${esc(m.seriesTitle || m.title)}</strong><small>${esc(episodeLabel(m))}</small></span><span>›</span></button>`,
      )
      .join("")}</div>` +
    (!rows.length
      ? blank(
          "Find your next watch.",
          "Search connected libraries for films and series.",
        )
      : "")
  );
}
function iptv() {
  let rows = state.media.filter((m: any) => m.kind === "channel"),
    groups = [...new Set(rows.map((m: any) => m.group).filter(Boolean))].sort();
  if (group) rows = rows.filter((m: any) => m.group === group);
  if (starred) rows = rows.filter((m: any) => m.favorite);
  if (query)
    rows = rows.filter(
      (m: any) =>
        m.title.toLowerCase().includes(query.toLowerCase()) ||
        state.programs.some(
          (p: any) =>
            p.mediaID === m.id &&
            p.title.toLowerCase().includes(query.toLowerCase()),
        ),
    );
  const now = Date.now() / 1000 - 978307200;
  return (
    heading(
      "IPTV",
      button("+ Add Playlist", "source.form", { kind: "M3U playlist" }, true),
    ) +
    `<div class="toolbar">${button(starred ? "★ Favorites" : "☆ All channels", "channels.favorites")}<input id="channel-query" type="search" aria-label="Search channels" placeholder="Find a channel" value="${esc(query)}"><select id="channel-group" aria-label="Channel group"><option value="">All groups</option>${groups.map((g) => `<option value="${esc(g)}" ${group === g ? "selected" : ""}>${esc(g)}</option>`).join("")}</select></div><p>${rows.length} channels</p><div class="channel-list">${rows
      .map((m: any) => {
        const p = state.programs.find(
          (p: any) => p.mediaID === m.id && p.start <= now && p.end > now,
        );
        return `<article class="channel">${image(m.poster) || '<span class="station" aria-hidden="true">▱</span>'}<div class="text"><strong>${esc(m.title)}</strong><small>${esc(p?.title || m.group || "Live TV")}</small>${p ? `<progress max="${p.end - p.start}" value="${now - p.start}"></progress>` : ""}${button("Program Guide", "guide", { id: m.id })}</div>${button("Play", "play", { id: m.id })}${button(m.favorite ? "★" : "☆", "favorite", { id: m.id })}</article>`;
      })
      .join("")}</div>` +
    (!rows.length
      ? blank(
          "Live TV, in your library.",
          "Add your M3U playlist, Xtream Codes account or a library with live channels.",
        )
      : "")
  );
}
function downloads() {
  return (
    heading("Downloads") +
    `<p>Saved on this device. Downloads stay available without a server connection.</p>` +
    (state.transfers.length
      ? state.transfers
          .map(
            (t: any) =>
              `<article class="panel transfer"><div class="row"><div class="text"><strong>${esc(t.media.seriesTitle || t.media.title)}</strong><small>${esc(episodeLabel(t.media))}</small><small>${esc(t.state)} · ${bytes(t.bytes)}</small>${t.state === "downloading" ? `<progress ${t.fraction != null ? `value="${t.fraction}" max="1"` : ""}></progress>` : ""}${t.error ? `<p class="error">${esc(t.error)}</p>` : ""}</div><div class="actions">${t.state === "ready" ? button("Play Offline", "play", { id: t.media.id, transferID: t.id }, true) : ["queued", "downloading"].includes(t.state) ? button("Cancel", "transfer.cancel", { id: t.id }) : button("Retry", "transfer.retry", { id: t.id })}${button("Delete", "transfer.confirm-delete", { id: t.id })}</div></div></article>`,
          )
          .join("")
      : blank(
          "Take your favorites with you.",
          "Open a film or episode and choose Download. You can save an entire season from its series page.",
        ))
  );
}
function settings() {
  const p = state.preferences,
    a = state.account;
  return (
    heading("Settings") +
    `<div class="settings-layout"><section class="setting-section"><div><h3>Your account</h3><p>Optional account sync, watch history and watchlist across your devices.</p></div><div class="panel"><div class="row"><div class="text"><strong>${esc(a.email || "Continue as a guest")}</strong><small>${esc(a.signedIn ? (a.unlocked ? "Account sync ready" : "Connecting to your account") : "Your library is saved on this device.")}</small></div>${button(a.signedIn ? "Manage" : "Sign in", "account.open")}</div>${a.signedIn ? `<div class="row"><div class="text"><small>${esc(a.message || (a.syncing ? "Syncing…" : "Your local changes are saved."))}</small></div>${button("Sync Now", "sync")}</div>` : ""}</div></section><section class="setting-section"><div><h3>Sources</h3><p>Connect several libraries in one place. Refreshing keeps your watch progress.</p></div><div><div class="panel">${state.sources.map((s: any) => `<div class="row"><div class="text"><strong>${esc(s.name)}</strong><small>${esc(s.kind)} · ${esc(s.host)}</small>${s.refreshing ? '<small class="busy">Refreshing</small>' : ""}${s.error ? `<p class="error">${esc(s.error)}</p>` : ""}<div class="source-actions">${button("Refresh", "refresh", { id: s.id })}${button("Edit", "source.form", { id: s.id })}<button class="danger" data-action="source.confirm-remove" data-args="${esc(JSON.stringify({ id: s.id }))}">Remove</button></div></div></div>`).join("") || "<p>No sources connected.</p>"}${button("+ Add Source", "source.form")}</div></div></section><section class="setting-section"><div><h3>Playback</h3><p>Language preferences apply when those tracks are available. Change tracks in the player at any time.</p></div><div class="panel"><label class="row check"><span class="text">Play next episode automatically</span><input id="autoplay" role="switch" type="checkbox" ${p.autoplay ? "checked" : ""}></label><label class="row"><span class="text">Audio language</span><select id="audio-language"><option value="en" ${p.audioLanguage === "en" ? "selected" : ""}>English</option><option value="de" ${p.audioLanguage === "de" ? "selected" : ""}>German</option></select></label><label class="row"><span class="text">Subtitle language</span><select id="subtitle-language">${[
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
      )}</select></label></div></section><section class="setting-section"><div><h3>Optional metadata</h3><p>Find artwork and descriptions with your own TMDB API read token. Searches send the title to TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div><div class="panel"><form id="metadata-form"><label>TMDB API read token<input name="token" type="password" autocomplete="off" placeholder="Paste a token, or leave blank to disable"></label><button type="submit">Save Metadata Settings</button></form></div></section><section class="setting-section"><div><h3>Download location</h3><p>Offline video stays on this device. Moving the folder also moves saved downloads.</p></div><div class="panel"><p>${esc(p.downloadDirectory || "Application storage")}</p>${button("Choose Folder…", "downloadDirectory")}</div></section><section class="setting-section"><div><h3>Oxa’s Library</h3><p>Version ${esc(state.version)} · ${state.platform === "darwin" ? "macOS" : "Windows"}<br>Open source. Your collection. On your terms.</p></div><div class="panel">${button("Website", "external", { target: "website" })} ${button("Source Code", "external", { target: "github" })} ${button("Releases", "external", { target: "release" })} ${button("Licenses", "licenses")}</div></section><section class="setting-section"><div><h3>Support Oxa</h3><p>Optional donations help support development. All features stay free.</p></div><div class="panel"><p>Bitcoin · BTC</p><code>3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV</code>${button("Copy Bitcoin Address", "donation.copy", { network: "bitcoin" })}<p>Litecoin · LTC</p><code>MTToUVnMpepWixDhUPBBG1SgdmxjifArwF</code>${button("Copy Litecoin Address", "donation.copy", { network: "litecoin" })}</div></section></div>`
  );
}
function sheet(title: string, html: string) {
  const d = $("#sheet");
  d.innerHTML = `<header><h2>${esc(title)}</h2><button data-action="sheet.close" aria-label="Close">×</button></header>${html}`;
  if (!d.open) d.showModal();
}
async function openDetail(id: string) {
  sheet("Loading…", '<p class="busy">Reading this title</p>');
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
          .map((number) => ({ number }));
  sheet(
    m.kind === "series" ? "Series" : "Details",
    `${image(m.backdrop || m.poster, "", "detail-art")}<div class="detail-heading"><div class="text"><h1>${esc(m.seriesTitle || m.title)}</h1><p>${esc(episodeLabel(m))}</p></div>${button(m.favorite ? "★ Saved" : "☆ Watchlist", "favorite", { id: m.id })}</div><div class="detail-actions">${["movie", "series"].includes(m.kind) && state.preferences.externalMetadata ? button("Find Artwork", "metadata.search", { id: m.id }) : ""}${m.kind !== "series" ? button(m.progress?.seconds && !m.progress.completed ? `Resume at ${time(m.progress.seconds)}` : "Play", "play", { id: m.id }, true) + button("Download", "download", { id: m.id }) : ""}</div><p>${esc(m.overview || "")}</p>${m.kind === "series" ? `<div class="section-heading"><h2>Episodes</h2><select id="season" aria-label="Season">${seasons.map((s: any) => `<option value="${s.number}" ${seasonNumber === s.number ? "selected" : ""}>Season ${s.number}</option>`).join("")}</select></div>${button(`Download Season ${seasonNumber}`, "download", { id: m.id, season: seasonNumber })}${episodes.map((e: any) => `<article class="episode"><div class="row"><div class="text"><small>S${e.season || 1} · E${e.episode || 1}${e.progress?.completed ? " · Watched" : ""}</small><h3>${esc(e.title)}</h3></div>${button(e.progress?.seconds && !e.progress.completed ? "Resume" : "Play", "play", { id: e.id }, true)}</div><p>${esc(e.overview || "")}</p><footer>${button(e.download ? "Downloaded" : "Download", "download", { id: e.id })}${e.progress?.seconds ? `<small>Resume at ${time(e.progress.seconds)}</small>` : ""}</footer></article>`).join("") || "<p>Choose a season to load its episodes.</p>"}` : ""}`,
  );
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
    `${!s ? '<div class="panel"><h3>Start with a library</h3><p>Import huhu.to with one click, or connect your own server below.</p><button class="primary" data-action="source.huhu">Import huhu.to</button></div>' : ""}<form id="source-form"><input type="hidden" name="id" value="${esc(s?.id || "")}"><div class="field-grid"><label>Name<input name="name" required maxlength="160" value="${esc(s?.name || "")}"></label><label>Source type<select name="kind">${kinds.map((k) => `<option ${k === (s?.kind || args.kind) ? "selected" : ""}>${esc(k)}</option>`).join("")}</select></label><label class="full">Server or library URL<input name="endpoint" type="url" required placeholder="https://your-server.example" autocomplete="off"></label><div class="full info">${s ? "Re-enter the URL and credentials when changing a source." : "Library URL example: https://huhu.to · Add only sources you are entitled to access."}</div><label>Username<input name="username" autocomplete="off"></label><label>Password<input name="password" type="password" autocomplete="new-password"></label><label class="full">Access token (if required)<input name="token" type="password" autocomplete="off"></label><label class="full">XMLTV guide URL (optional)<input name="guideURL" type="url" autocomplete="off"></label><label class="full check"><input name="allowHTTP" type="checkbox" ${s?.allowHTTP ? "checked" : ""}>Allow local HTTP for this source</label><label class="full check"><input name="allowInsecureStreams" type="checkbox" ${s?.allowInsecureStreams ? "checked" : ""}>Allow unencrypted media streams for this source</label><label class="full check"><input name="allowProviderFetch" type="checkbox" ${s?.allowProviderFetch ? "checked" : ""}>Allow provider-assisted requests to public hosts</label><p class="full info">Provider assistance sends a public host response to this library provider to resolve playback. Your Oxa account and other server credentials are excluded.</p></div><p class="form-error error" role="alert"></p><div class="dialog-actions"><button type="button" data-action="sheet.close">Cancel</button><button class="primary" type="submit">${s ? "Save Source" : "Connect Source"}</button></div></form>`,
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
      ? `<p>${esc(a.email)}</p><p class="info">${esc(a.message || "Your connections, watch history and watchlist sync between your devices. Downloads stay on this device.")}</p><div class="sources-choices">${!a.unlocked ? button("Unlock Connections", "account.mode", { mode: "unlock" }) : ""}${button("Sync Now", "sync")}${button("Change Password", "account.mode", { mode: "password" })}${button("Sign Out", "signout")}${button("Delete Account", "account.mode", { mode: "delete" })}</div>`
      : `<p>${esc(mode === "signin" ? "Sign in to bring your connections, watchlist and progress to this device. Your account is optional." : mode === "verify" ? "Enter the code from your email." : mode === "delete" ? "This permanently deletes your Oxa account and synced library data. Re-enter your password to confirm." : mode === "reset" ? "Your sources, watch history and watchlist are kept after a password reset." : mode === "unlock" ? "Use your account password to decrypt your synced server connections." : "")}</p><form id="account-form">${["signin", "signup", "forgot", "verify"].includes(mode) ? `<label>Email<input name="email" type="email" required autocomplete="email" value="${esc(accountEmail)}"></label>` : ""}${mode === "verify" ? '<label>Verification code<input name="code" required inputmode="numeric" autocomplete="one-time-code"></label>' : mode !== "forgot" ? `<label>${mode === "reset" || mode === "password" ? "New password" : "Password"}<input name="password" type="password" required ${["signup", "reset", "password"].includes(mode) ? 'minlength="10" autocomplete="new-password"' : 'autocomplete="current-password"'}></label>` : ""}${["signin", "signup"].includes(mode) ? '<label class="check"><input name="includeGuest" type="checkbox" checked>Include this device’s guest library in my account</label>' : ""}<p class="form-error error" role="alert"></p><button class="primary" type="submit">${mode === "signin" ? "Sign In" : mode === "signup" ? "Create Account" : mode === "forgot" ? "Send Recovery Code" : mode === "verify" ? "Verify Code" : mode === "delete" ? "Permanently Delete Account" : "Continue"}</button>${mode === "signin" ? `${button("Create Account", "account.mode", { mode: "signup" })}${button("Forgot Password?", "account.mode", { mode: "forgot" })}<label class="check"><input id="hide-welcome" type="checkbox" ${state.hideWelcome ? "checked" : ""}>Don’t show this message again</label>${button("Continue as Guest", "account.guest")}` : mode === "verify" ? button("Resend Registration Code", "account.resend") : button("Back to Sign In", "account.mode", { mode: "signin" })}</form>`);
  if (!d.open) d.showModal();
}
async function start(args: any, operation = "play") {
  const result = await cmd(operation, args);
  if (!result) return;
  if (result.choices) {
    sheet(
      "Sources",
      `<p>Choose a playback server. Your watch progress is kept.</p><div class="sources-choices">${result.choices
        .filter((c: any) => c.kind !== "website")
        .map(
          (c: any) =>
            `<button data-action="${operation}" data-args="${esc(JSON.stringify({ ...args, choiceID: c.id }))}"><strong>${esc(c.name || c.providerName || "Server")}</strong><small>${esc([c.quality, c.languages?.join(", "), c.providerName].filter(Boolean).join(" · "))}</small></button>`,
        )
        .join("")}</div>`,
    );
    return;
  }
  if (result.queued) {
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
      `<div class="sources-choices">${r.choices.map((c: any) => button(c.name || "Server", "play", { id: r.media.id, choiceID: c.id })).join("")}</div>`,
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
$("#fullscreen").onclick = () => void run(() => cmd("fullscreen"));
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
    destroyPlayer();
    playback = null;
    $("#player").hidden = true;
    document.body.classList.remove("player-open");
    await cmd("closePlayer");
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
    if (!result) return;
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
    page = b.dataset.page;
    query = "";
    render();
    $("#content").focus();
    return;
  }
  if (b.dataset.filter) {
    filter = b.dataset.filter;
    render();
    return;
  }
  if (b.dataset.action)
    void run(async () => {
      const a = b.dataset.action,
        args = JSON.parse(b.dataset.args || "{}");
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
          "This removes the source from your synced library. Saved downloads and watch progress are kept.",
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
                    `<article class="episode"><small>${esc(new Date((p.start + 978307200) * 1000).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }))}</small><h3>${esc(p.title)}</h3><p>${esc(p.overview || "")}</p></article>`,
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
      if (a === "favorite" && detailData) {
        const m = state.media.find((m: any) => m.id === detailData.media.id);
        if (m) {
          detailData.media.favorite = m.favorite;
          drawDetail();
        }
      }
      if (result?.sources) {
        state = result;
        render();
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
          data[key] = form.elements[key].checked;
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
    if (e.id === "source-filter") {
      source = e.value;
      render();
    }
    if (e.id === "channel-group") {
      group = e.value;
      render();
    }
    if (e.id === "season") {
      seasonNumber = Number(e.value);
      const rows = await cmd("season", {
        id: detailData.media.id,
        number: seasonNumber,
      });
      detailData.episodes = detailData.episodes
        .filter((x: any) => x.season !== seasonNumber)
        .concat(rows);
      drawDetail();
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
window.oxa.onUpdate((s) => {
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
window.oxa.onAction((a) => {
  if (a === "add-source") sourceForm();
});
void run(async () => {
  state = await cmd("state");
  lastAccount = state.account.email || "";
  render();
  if (!state.account.signedIn && !state.hideWelcome) accountForm();
});
