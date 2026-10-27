import { XMLParser } from "fast-xml-parser";
import {
  Source,
  Credentials,
  Media,
  media,
  ordered,
  bounded,
  ordinal,
  appleDate,
} from "./model";
import {
  bytes,
  json,
  request,
  urlCheck,
  local,
  cleanHeaders,
  ResponseLimitError,
} from "./network";
export const MAX_CATALOG_ITEMS = 100000;
const MAX_GUIDE_ROWS = 200000;
const checkCatalogSize = (count: number, max = MAX_CATALOG_ITEMS) => {
  if (count > max)
    throw new ResponseLimitError(
      "The source catalog exceeds the library size limit. Add a smaller library.",
    );
};
const array = (v: any) => (v == null ? [] : Array.isArray(v) ? v : [v]);
export const xml = (text: string) =>
  new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    removeNSPrefix: true,
    processEntities: false,
    htmlEntities: false,
  }).parse(text);
const text = (v: any) =>
  typeof v === "object" ? (v?.["#text"] ?? "") : String(v ?? "");
const root = (raw: string) => {
  const u = new URL(raw);
  u.hash = "";
  u.pathname = u.pathname.replace(/mhub-addon\.json$/, "");
  if (!u.pathname.endsWith("/")) u.pathname += "/";
  return u.href;
};
// A provider pattern is a literal URL glob, not a regular expression. Turning
// every '*' into '.*' permits exponential backtracking on a nonmatching URL.
// Match fixed segments in order, reserving an anchored suffix before scanning.
export function matches(raw: string, pattern: string) {
  if (
    typeof raw !== "string" ||
    typeof pattern !== "string" ||
    raw.length > 8192 ||
    pattern.length > 1024
  )
    return false;
  const url = raw.toLowerCase(),
    pieces = pattern.toLowerCase().split("*");
  if (pieces.length === 1) return url === pieces[0];
  const prefix = pieces[0],
    suffix = pieces[pieces.length - 1];
  if (!url.startsWith(prefix) || !url.endsWith(suffix)) return false;
  let cursor = prefix.length;
  const end = url.length - suffix.length;
  if (cursor > end) return false;
  for (let i = 1; i < pieces.length - 1; i++) {
    const part = pieces[i];
    if (!part) continue;
    const found = url.indexOf(part, cursor);
    if (found < 0 || found + part.length > end) return false;
    cursor = found + part.length;
  }
  return true;
}
export function m3u(input: string, s: Source, base: string) {
  if (!input.trimStart().startsWith("#EXTM3U"))
    throw Error("This is not an extended M3U playlist.");
  const rows: Media[] = [];
  let info: any = null;
  for (const line of input.split(/\r?\n/)) {
    if (line.startsWith("#EXTINF:")) {
      const a: any = {};
      for (const m of line.matchAll(/([\w-]+)="([^"]*)"/g)) a[m[1]] = m[2];
      info = { a, name: line.slice(line.indexOf(",") + 1).trim() };
    } else if (line.trim() && !line.startsWith("#") && info) {
      const url = new URL(line.trim(), base).href;
      const m = media(s, url, info.name, "channel");
      m.stream = url;
      m.poster = info.a["tvg-logo"]
        ? new URL(info.a["tvg-logo"], base).href
        : undefined;
      m.channelID = info.a["tvg-id"] || url;
      m.group = info.a["group-title"] || "Other";
      rows.push(m);
      info = null;
    }
  }
  return rows;
}
export function guide(input: string, s: Source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(input))
    throw Error("XML entities are not supported.");
  const parsed = xml(input),
    date = (v: string) => {
      const m = String(v).match(
        /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4}|Z)?/,
      );
      if (!m) return NaN;
      return appleDate(
        `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] || "00"}${m[7] === "Z" ? "Z" : (m[7] || "+0000").replace(/(\d\d)$/, ":$1")}`,
      );
    };
  return array(parsed.tv?.programme)
    .slice(0, 100000)
    .map((p: any) => ({
      id: `${s.id}:${p.channel}:${p.start}`,
      sourceID: s.id,
      channelID: String(p.channel),
      title: text(array(p.title)[0]),
      overview: text(array(p.desc)[0]),
      start: date(p.start),
      end: date(p.stop),
    }))
    .filter((p: any) => p.title && Number.isFinite(p.start) && p.end > p.start);
}
export class Provider {
  private metadataBudget = { remaining: 64 * 1024 * 1024 };
  base: string;
  headers: any;
  constructor(
    public source: Source,
    public credentials: Credentials,
  ) {
    this.base = urlCheck(
      credentials.endpoint,
      source,
      source.kind === "Video URL",
    ).href;
    this.headers = {};
    if (["Jellyfin", "Emby"].includes(source.kind) && credentials.token)
      this.headers["X-Emby-Token"] = credentials.token;
    if (source.kind === "Plex")
      this.headers["X-Plex-Token"] = credentials.token;
    if (source.kind === "NAS / WebDAV" && credentials.username)
      this.headers.Authorization =
        "Basic " +
        Buffer.from(credentials.username + ":" + credentials.password).toString(
          "base64",
        );
  }
  opts(extra: any = {}) {
    return {
      source: this.source,
      publicOnly: !local(new URL(this.base).hostname),
      headers: this.headers,
      ...(extra.media
        ? {}
        : { budget: this.metadataBudget, limit: 8 * 1024 * 1024 }),
      ...extra,
    };
  }
  url(p: string, q: any = {}) {
    const u = new URL(root(this.base));
    u.pathname += p.replace(/^\//, "");
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, String(v));
    return u.href;
  }
  async j(p: string, q: any = {}, body?: any) {
    return json(
      this.url(p, q),
      this.opts(
        body
          ? {
              method: "POST",
              body: JSON.stringify(body),
              headers: { ...this.headers, "Content-Type": "application/json" },
            }
          : {},
      ),
    );
  }
  async authenticate() {
    if (
      ["Jellyfin", "Emby"].includes(this.source.kind) &&
      !this.credentials.token
    ) {
      const data = await json(
        this.url("Users/AuthenticateByName"),
        this.opts({
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Emby-Authorization": `MediaBrowser Client="Oxa's Library", Device="Desktop", DeviceId="${this.source.id}", Version="1.0.0"`,
          },
          body: JSON.stringify({
            Username: this.credentials.username,
            Pw: this.credentials.password,
          }),
        }),
      );
      if (!data.AccessToken || !data.User?.Id)
        throw Error("Server sign-in failed.");
      this.credentials.token = data.AccessToken;
      this.credentials.userID = data.User.Id;
      this.headers["X-Emby-Token"] = data.AccessToken;
    }
  }
  jelly(row: any) {
    const m = media(
      this.source,
      row.Id,
      row.Name,
      row.Type === "Series"
        ? "series"
        : row.Type === "Episode"
          ? "episode"
          : "movie",
    );
    Object.assign(m, {
      overview: row.Overview || "",
      year: row.ProductionYear,
      duration: bounded((row.RunTimeTicks || 0) / 1e7),
      seriesID: row.SeriesId,
      seriesTitle: row.SeriesName,
      season: ordinal(row.ParentIndexNumber),
      episode: ordinal(row.IndexNumber),
    });
    m.poster = this.url(`Items/${row.Id}/Images/Primary`, {
      maxWidth: 600,
      quality: 85,
    });
    if (row.BackdropImageTags?.length)
      m.backdrop = this.url(`Items/${row.Id}/Images/Backdrop/0`, {
        maxWidth: 1400,
      });
    return m;
  }
  plex(row: any) {
    const m = media(
      this.source,
      row.ratingKey,
      row.title,
      row.type === "show"
        ? "series"
        : row.type === "episode"
          ? "episode"
          : "movie",
    );
    Object.assign(m, {
      overview: row.summary || "",
      year: row.year,
      duration: bounded((row.duration || 0) / 1000),
      seriesID: row.grandparentRatingKey,
      seriesTitle: row.grandparentTitle,
      season: ordinal(row.parentIndex),
      episode: ordinal(row.index),
    });
    if (row.thumb) m.poster = this.url(row.thumb);
    if (row.art) m.backdrop = this.url(row.art);
    return m;
  }
  xtream(row: any, kind: string) {
    const id = row.stream_id ?? row.series_id ?? row.id,
      m = media(this.source, id, row.name, kind),
      c = this.credentials;
    Object.assign(m, {
      poster: row.stream_icon || row.cover || undefined,
      overview: row.plot || "",
      year: parseInt(row.year) || undefined,
      group: String(row.category_id || "Other"),
      channelID: String(row.epg_channel_id || id),
    });
    if (kind !== "series")
      m.stream = this.url(
        `${kind === "channel" ? "live" : "movie"}/${encodeURIComponent(c.username)}/${encodeURIComponent(c.password)}/${id}.${kind === "channel" ? "m3u8" : row.container_extension || "mp4"}`,
      );
    return m;
  }
  async catalog() {
    await this.authenticate();
    const kind = this.source.kind;
    let items: Media[] = [],
      programs: any[] = [],
      pages: any[] = [];
    let warning = "";
    if (["Jellyfin", "Emby"].includes(kind)) {
      let start = 0;
      for (let page = 0; page < 500; page++) {
        const data = await this.j(`Users/${this.credentials.userID}/Items`, {
          Recursive: true,
          IncludeItemTypes: "Movie,Series,Episode",
          Fields: "Overview,MediaSources,MediaStreams",
          StartIndex: start,
          Limit: 200,
        });
        const rows = data.Items || [];
        checkCatalogSize(items.length + rows.length);
        items.push(...rows.map((r: any) => this.jelly(r)));
        start += rows.length;
        if (!rows.length || start >= (data.TotalRecordCount ?? start)) break;
      }
    } else if (kind === "Plex") {
      for (const type of [1, 2, 4])
        for (let start = 0, page = 0; page < 500; page++) {
          const d = await this.j("library/all", {
            type,
            "X-Plex-Container-Start": start,
            "X-Plex-Container-Size": 200,
          });
          const rows = d.MediaContainer?.Metadata || [];
          checkCatalogSize(items.length + rows.length);
          items.push(...rows.map((r: any) => this.plex(r)));
          start += rows.length;
          if (!rows.length || start >= (d.MediaContainer?.totalSize ?? start))
            break;
        }
    } else if (kind === "Library URL") {
      const c = await this.discover();
      this.source.websiteConnection = c;
      let success = 0;
      for (const addon of c.addons)
        for (const catalog of addon.catalogs) {
          try {
            const page = await this.page(
              { sourceID: this.source.id, addonID: addon.id, catalog },
              c,
            );
            checkCatalogSize(items.length + page.items.length);
            checkCatalogSize(
              programs.length + page.programs.length,
              MAX_GUIDE_ROWS,
            );
            items.push(...page.items);
            programs.push(...page.programs);
            pages.push(page.page);
            success++;
          } catch (error) {
            if (error instanceof ResponseLimitError) throw error;
            warning =
              "Some provider catalogs could not load. Refresh to retry.";
          }
        }
      if (!success) throw Error("The library catalogs could not be loaded.");
    } else if (kind === "Video URL") {
      if (
        !/\.(mp4|m4v|mov|m3u8|webm|mkv|ts)$/i.test(new URL(this.base).pathname)
      ) {
        const probe = await request(
          this.base,
          this.opts({ method: "HEAD", media: true }),
        );
        probe.stream.resume();
        if (
          !/video|mpegurl|octet-stream/i.test(
            probe.headers["content-type"] || "",
          )
        )
          throw Error(
            "This is not a direct video. Use Library URL for a supported website catalog.",
          );
      }
      const m = media(
        this.source,
        "direct",
        decodeURIComponent(
          new URL(this.base).pathname.split("/").pop() || this.source.name,
        ),
      );
      m.stream = this.base;
      items = [m];
    } else if (kind === "M3U playlist") {
      const body = (await bytes(this.base, this.opts())).data.toString();
      items = m3u(body, this.source, this.base);
      let epg =
        this.credentials.guideURL ||
        body.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/)?.[1];
      if (epg)
        try {
          programs = guide(
            (
              await bytes(
                new URL(epg, this.base).href,
                this.opts({ headers: {} }),
              )
            ).data.toString(),
            this.source,
          );
        } catch (error) {
          if (error instanceof ResponseLimitError) throw error;
          warning =
            "Channels loaded; the program guide could not be refreshed.";
        }
    } else if (kind === "Xtream Codes") {
      const q = {
        username: this.credentials.username,
        password: this.credentials.password,
      };
      const auth = await this.j("player_api.php", q);
      if (String(auth.user_info?.auth) !== "1")
        throw Error("Xtream login was rejected.");
      for (const [action, k] of [
        ["get_live_streams", "channel"],
        ["get_vod_streams", "movie"],
        ["get_series", "series"],
      ]) {
        const rows = await this.j("player_api.php", { ...q, action });
        if (!Array.isArray(rows)) throw Error("Invalid IPTV catalog.");
        checkCatalogSize(items.length + rows.length);
        items.push(...rows.map((r) => this.xtream(r, k)));
      }
      try {
        programs = guide(
          (
            await bytes(
              this.credentials.guideURL || this.url("xmltv.php", q),
              this.opts(),
            )
          ).data.toString(),
          this.source,
        );
      } catch (error) {
        if (error instanceof ResponseLimitError) throw error;
        warning = "Channels loaded; program guide unavailable.";
      }
    } else if (kind === "NAS / WebDAV") {
      const pending = [this.base],
        seen = new Set();
      while (pending.length) {
        const directory = pending.pop()!;
        if (seen.has(directory)) continue;
        seen.add(directory);
        if (seen.size > 2000) throw Error("Add a smaller WebDAV media folder.");
        const r = await bytes(
          directory,
          this.opts({
            method: "PROPFIND",
            headers: {
              ...this.headers,
              Depth: "1",
              "Content-Type": "application/xml",
            },
            body: '<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>',
          }),
        );
        const parsed = xml(r.data.toString());
        for (const entry of array(parsed.multistatus?.response)) {
          const href = new URL(text(entry.href), directory),
            p = array(entry.propstat)[0]?.prop || {};
          if (
            href.origin !== new URL(this.base).origin ||
            !href.pathname.startsWith(new URL(root(this.base)).pathname)
          )
            continue;
          if (p.resourcetype?.collection !== undefined) {
            if (href.href !== directory) pending.push(href.href);
          } else if (/\.(mp4|m4v|mov|mkv|webm|ts|m3u8)$/i.test(href.pathname)) {
            const m = media(
              this.source,
              href.pathname,
              text(p.displayname) ||
                decodeURIComponent(href.pathname.split("/").pop()!),
            );
            m.stream = href.href;
            items.push(m);
            checkCatalogSize(items.length);
          }
        }
      }
    }
    checkCatalogSize(items.length);
    checkCatalogSize(programs.length, MAX_GUIDE_ROWS);
    return { items, programs, pages, warning };
  }
  resource(base: string, segments: string[], query: any = {}) {
    const u = new URL(root(base));
    u.pathname += segments.map(encodeURIComponent).join("/");
    for (const [k, v] of Object.entries({ ...query, language: "en" }))
      u.searchParams.set(k, String(v));
    return u.href;
  }
  async mh(raw: string, allowFetch = false) {
    let body = await json(
      raw,
      this.opts({ headers: { Accept: "application/json" } }),
    );
    for (let turn = 0; body.clientFetch && turn < 5; turn++) {
      if (!allowFetch || !this.source.allowProviderFetch)
        throw Error(
          "Enable provider-assisted requests for this source or choose another server.",
        );
      const f = body.clientFetch;
      if (
        !f.id ||
        f.id.length > 256 ||
        !["GET", "HEAD", "POST"].includes(f.method || "GET") ||
        Buffer.byteLength(f.body || "") > 65536
      )
        throw Error("Invalid provider-assisted request.");
      const response = await bytes(f.url, {
        source: {},
        publicOnly: true,
        method: f.method || "GET",
        headers: cleanHeaders(f.headers),
        body: f.method === "POST" ? f.body : undefined,
        limit: 2 * 1024 * 1024,
        raw: true,
      });
      const callback = new URL(raw);
      callback.pathname = callback.pathname.replace(
        /\/resolve\/?$/,
        "/client-fetch",
      );
      callback.search = "";
      body = await json(
        callback.href,
        this.opts({
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id: f.id,
            status: response.status,
            headers: { "content-type": response.headers["content-type"] || "" },
            body: response.data.toString(),
            encoding: "utf-8",
          }),
          limit: 2 * 1024 * 1024,
        }),
      );
    }
    if (body.clientFetch)
      throw Error("Provider-assisted request limit exceeded.");
    if (body.error)
      throw Error(
        "The provider could not complete this request. Check your access or choose another server.",
      );
    return body;
  }
  async discover() {
    if (this.source.websiteConnection) return this.source.websiteConnection;
    const pending = [root(this.base)],
      seen = new Set(),
      addons: any[] = [];
    while (pending.length) {
      const base = pending.pop()!;
      if (seen.has(base)) continue;
      seen.add(base);
      if (seen.size > 24) throw Error("Too many linked providers.");
      const d = await this.mh(this.resource(base, ["mhub-addon.json"]));
      if (d.specVersion < 2 || !d.id || !d.name)
        throw Error(
          "This website does not expose a supported mHub v2 library.",
        );
      if (Array.isArray(d.addons)) {
        for (const a of d.addons)
          if (a.enabled === true && a.url)
            pending.push(root(new URL(a.url, base).href));
      } else {
        addons.push({
          id: d.id,
          name: d.name,
          baseURL: base,
          resources: d.resources || [],
          catalogs: (d.catalogs || [])
            .filter((c: any) => ["video", "series", "live"].includes(c.type))
            .map((c: any) => ({ ...c, searchable: !!c.features?.search })),
          idPrefixes: d.idPrefixes || [],
          urlPatterns: d.urlPatterns || [],
        });
        for (const r of d.requires || []) {
          const a = typeof r === "string" ? { url: r } : r;
          if (a.enabled !== false && a.url)
            pending.push(root(new URL(a.url, base).href));
        }
      }
    }
    if (!addons.some((a) => a.catalogs.length))
      throw Error("No movie, series or live-TV catalogs were found.");
    return { root: root(this.base), addons };
  }
  streams(rows: any, base: string) {
    return array(rows)
      .filter((r) => r?.url)
      .map((r) => ({
        ...r,
        url: new URL(r.url, base).href,
        name: r.name || "Stream",
        kind: r.kind || "stream",
        headers: cleanHeaders(r.headers),
      }));
  }
  mhItem(r: any, a: any, parent?: Media, season?: number) {
    if (!r || r.directory != null || r.id == null || !r.name) return null;
    const type = r.type || (parent ? "series" : "video"),
      kind =
        parent || r.episode != null
          ? "episode"
          : type === "series"
            ? "series"
            : type === "live"
              ? "channel"
              : "movie";
    if (!["series", "video", "live"].includes(type)) return null;
    const m = media(this.source, `${a.id}:${type}:${r.id}`, r.name, kind);
    const img = r.images || {};
    Object.assign(m, {
      overview: r.description || "",
      year: r.year || parseInt(r.releaseDate),
      duration: bounded(r.runtime),
      poster: img.poster || img.thumbnail || img.logo,
      backdrop: img.backdrops?.[0],
      group: r.tags?.[0],
      season: ordinal(r.season) ?? ordinal(season),
      episode: ordinal(r.episode),
    });
    if (m.poster) m.poster = new URL(m.poster, a.baseURL).href;
    if (m.backdrop) m.backdrop = new URL(m.backdrop, a.baseURL).href;
    if (parent) {
      m.seriesID = parent.providerID;
      m.seriesTitle = parent.title;
      m.poster ||= parent.poster;
    }
    let ids = r.ids || {};
    if (
      parent &&
      !Object.keys(ids).length &&
      m.season != null &&
      m.episode != null
    )
      ids = Object.fromEntries(
        Object.entries(parent.websiteItem?.ids || {}).map(([k, v]) => [
          k,
          `${v}:${m.season}:${m.episode}`,
        ]),
      );
    let sources = this.streams(r.sources, a.baseURL);
    if (r.url)
      sources.unshift({
        url: new URL(r.url, a.baseURL).href,
        name: r.name,
        kind: "stream",
        headers: cleanHeaders(r.headers),
      });
    m.websiteItem = {
      addonID: a.id,
      type,
      id: String(r.id),
      ids,
      sources,
      seasons: [],
    };
    if (kind === "channel") m.channelID = m.providerID;
    return m;
  }
  async page(page: any, c: any, search?: string) {
    const a = c.addons.find((x: any) => x.id === page.addonID);
    if (!a) throw Error("Provider unavailable. Refresh the source.");
    const d = await this.mh(
      this.resource(
        a.baseURL,
        ["catalog", page.catalog.type, page.catalog.id + ".json"],
        search ? { search } : page.cursor ? { cursor: page.cursor } : {},
      ),
    );
    if (!Array.isArray(d.items)) throw Error("Invalid website catalog.");
    checkCatalogSize(d.items.length);
    return {
      items: d.items.map((r: any) => this.mhItem(r, a)).filter(Boolean),
      programs: d.items.flatMap((r: any) => {
        const m = this.mhItem(r, a);
        return m?.kind === "channel"
          ? (r.epg || []).map((p: any) => ({
              id: `${m.id}:${p.start}`,
              sourceID: this.source.id,
              channelID: m.channelID,
              title: p.title,
              overview: p.description || "",
              start: appleDate(p.start),
              end: appleDate(p.end),
            }))
          : [];
      }),
      page: {
        ...page,
        cursor:
          d.nextCursor && d.nextCursor !== page.cursor
            ? String(d.nextCursor)
            : undefined,
      },
    };
  }
  async search(q: string) {
    if (this.source.kind !== "Library URL") return [];
    const c = await this.discover();
    const out: Media[] = [];
    for (const a of c.addons)
      for (const catalog of a.catalogs)
        if (catalog.searchable && catalog.type !== "live")
          try {
            out.push(
              ...(await this.page({ addonID: a.id, catalog }, c, q)).items,
            );
            checkCatalogSize(out.length);
          } catch (error) {
            if (error instanceof ResponseLimitError) throw error;
          }
    return out;
  }
  async detail(m: Media) {
    if (m.websiteItem) {
      const c = await this.discover(),
        r = m.websiteItem,
        a = c.addons.find((x: any) => x.id === r.addonID);
      if (!a?.resources.includes("item")) return { media: m, episodes: [] };
      const body = await this.mh(
        this.resource(a.baseURL, ["item", r.type, r.id + ".json"]),
      );
      const d = this.mhItem(body, a) || m;
      Object.assign(d, {
        id: m.id,
        providerID: m.providerID,
        kind: m.kind,
        seriesID: m.seriesID,
        seriesTitle: m.seriesTitle,
        season: ordinal(m.season),
        episode: ordinal(m.episode),
      });
      d.websiteItem.sources = [...r.sources, ...d.websiteItem.sources].filter(
        (x: any, i: number, all: any[]) =>
          all.findIndex((y) => y.url === x.url) === i,
      );
      d.websiteItem.seasons = (body.catalogs || [])
        .filter((x: any) => ordinal(x.season) != null)
        .map((x: any) => ({
          id: x.id,
          name: x.name || `Season ${x.season}`,
          type: x.type || "video",
          number: ordinal(x.season),
        }));
      return {
        media: d,
        episodes: [
          ...(body.children || []).map((x: any) => this.mhItem(x, a, d)),
          ...(body.catalogs || []).flatMap((cat: any) =>
            (cat.items || []).map((x: any) => this.mhItem(x, a, d, cat.season)),
          ),
        ].filter(Boolean),
      };
    }
    return { media: m, episodes: [] };
  }
  async episodes(m: Media, season?: number) {
    if (m.websiteItem) {
      const c = await this.discover(),
        d = (await this.detail(m)).media,
        r = d.websiteItem,
        a = c.addons.find((x: any) => x.id === r.addonID),
        seasons = r.seasons.filter(
          (x: any) => season == null || x.number === season,
        );
      let out: Media[] = [];
      for (const s of seasons) {
        let cursor: string | undefined;
        const seen = new Set();
        for (let n = 0; n < 100; n++) {
          const body = await this.mh(
            this.resource(
              a.baseURL,
              ["catalog", s.type, s.id + ".json"],
              cursor ? { cursor } : {},
            ),
          );
          out.push(
            ...(body.items || [])
              .map((x: any) => this.mhItem(x, a, d, s.number))
              .filter(Boolean),
          );
          checkCatalogSize(out.length);
          cursor = body.nextCursor;
          if (!cursor) break;
          if (seen.has(cursor)) throw Error("Repeated episode page.");
          seen.add(cursor);
        }
      }
      return ordered(out);
    }
    if (this.source.kind === "Xtream Codes") {
      const d = await this.j("player_api.php", {
        username: this.credentials.username,
        password: this.credentials.password,
        action: "get_series_info",
        series_id: m.providerID,
      });
      return ordered(
        Object.entries(d.episodes || {}).flatMap(([s, rows]: any) =>
          (rows || []).map((r: any) => {
            const e = media(this.source, `episode:${r.id}`, r.title, "episode");
            e.providerID = String(r.id);
            Object.assign(e, {
              seriesID: m.providerID,
              seriesTitle: m.title,
              poster: m.poster,
              season: ordinal(s),
              episode: ordinal(r.episode_num),
              overview: r.info?.plot || "",
              duration: bounded(r.info?.duration_secs),
              stream: this.url(
                `series/${encodeURIComponent(this.credentials.username)}/${encodeURIComponent(this.credentials.password)}/${r.id}.${r.container_extension || "mp4"}`,
              ),
            });
            return e;
          }),
        ),
      );
    }
    return [];
  }
  async sources(m: Media) {
    if (!m.websiteItem) return { media: m, sources: [] };
    const c = await this.discover(),
      d = (await this.detail(m)).media,
      r = d.websiteItem;
    let candidates = [...r.sources];
    for (const a of c.addons.filter((x: any) =>
      x.resources.includes("source"),
    )) {
      const prefix = a.idPrefixes.find((p: string) => r.ids[p]);
      if (!prefix) continue;
      try {
        const body = await this.mh(
          this.resource(
            a.baseURL,
            [
              "source",
              m.kind === "episode" ? "series" : r.type,
              `${prefix}:${r.ids[prefix]}.json`,
            ],
            {
              ids: Object.entries(r.ids)
                .filter(([k]) => k !== prefix)
                .map(([k, v]) => `${k}:${v}`)
                .join(","),
            },
          ),
        );
        candidates.push(
          ...this.streams(body.sources, a.baseURL).map((x) => ({
            ...x,
            providerName: a.name,
          })),
        );
      } catch {}
    }
    return {
      media: d,
      sources: candidates.filter(
        (x, i, all) => all.findIndex((y) => y.url === x.url) === i,
      ),
    };
  }
  async playback(m: Media, choice?: any, download = false, language = "en") {
    let result = { ...m },
      stream = m.stream,
      headers = { ...this.headers },
      format = m.streamFormat;
    if (m.websiteItem) {
      const c = await this.discover();
      if (!choice) {
        const all = await this.sources(m);
        result = all.media;
        choice = all.sources.find((x) => x.kind !== "website");
      }
      if (!choice || choice.kind === "website")
        throw Error("Choose a playable server.");
      let output: any;
      for (const a of c.addons.filter(
        (x: any) =>
          x.resources.includes("resolve") &&
          x.urlPatterns.some((p: string) => matches(choice.url, p)),
      )) {
        try {
          output = await this.mh(
            this.resource(a.baseURL, ["resolve"], { url: choice.url }),
            true,
          );
          break;
        } catch {}
      }
      if (
        c.addons.some(
          (a: any) =>
            a.resources.includes("resolve") &&
            a.urlPatterns.some((p: string) => matches(choice.url, p)),
        ) &&
        !output
      )
        throw Error(
          "This server could not resolve the video. Try another server.",
        );
      output ??= choice;
      stream = new URL(output.url, this.base).href;
      headers = cleanHeaders({ ...choice.headers, ...output.headers });
      format = output.format;
      result.creditsStart = output.creditsStart;
      const aliases = language === "de" ? ["de", "deu", "ger"] : ["en", "eng"];
      const caption = (output.subtitles || []).find((x: any) =>
        aliases.includes(x.language),
      );
      if (caption && language !== "off")
        result.subtitleURL = new URL(caption.url, stream).href;
    } else if (["Jellyfin", "Emby"].includes(this.source.kind)) {
      const d = await this.j(
        `Items/${m.providerID}/PlaybackInfo`,
        { UserId: this.credentials.userID },
        {
          UserId: this.credentials.userID,
          IsPlayback: true,
          EnableDirectPlay: true,
          EnableDirectStream: true,
          EnableTranscoding: true,
          DeviceProfile: {
            Name: "Oxa Desktop",
            MaxStreamingBitrate: 40000000,
            DirectPlayProfiles: [
              {
                Container: "mp4,m4v,mov,webm",
                Type: "Video",
                VideoCodec: "h264,vp8,vp9,av1",
                AudioCodec: "aac,mp3,opus,vorbis",
              },
            ],
            TranscodingProfiles: [
              {
                Container: "ts",
                Type: "Video",
                VideoCodec: "h264",
                AudioCodec: "aac",
                Protocol: "hls",
                Context: "Streaming",
                MaxAudioChannels: "2",
                MinSegments: 2,
              },
            ],
            SubtitleProfiles: [{ Format: "vtt", Method: "External" }],
          },
        },
      );
      const v = d.MediaSources?.[0];
      if (!v) throw Error("No compatible server stream.");
      if (
        v.SupportsDirectPlay &&
        ["mp4", "m4v", "mov", "webm"].includes(v.Container)
      )
        stream = this.url(
          download
            ? `Items/${m.providerID}/Download`
            : `Videos/${m.providerID}/stream.${v.Container}`,
          {
            Static: true,
            MediaSourceId: v.Id,
            api_key: this.credentials.token,
          },
        );
      else if (v.TranscodingUrl) {
        stream = new URL(v.TranscodingUrl, root(this.base)).href;
        if (new URL(stream).origin !== new URL(this.base).origin)
          throw Error("Invalid transcoding destination.");
        format = "hls";
      } else
        throw Error("Enable compatible HLS transcoding on your media server.");
      const sub = (v.MediaStreams || []).find(
        (x: any) =>
          x.Type === "Subtitle" &&
          (language === "de" ? ["de", "deu", "ger"] : ["en", "eng"]).includes(
            x.Language,
          ),
      );
      if (sub && language !== "off")
        result.subtitleURL = this.url(
          `Videos/${m.providerID}/${v.Id}/Subtitles/${sub.Index}/0/Stream.vtt`,
          { api_key: this.credentials.token },
        );
    } else if (this.source.kind === "Plex") {
      const d = await this.j(`library/metadata/${m.providerID}`),
        v = d.MediaContainer?.Metadata?.[0]?.Media?.[0],
        part = v?.Part?.[0];
      if (["mp4", "mov", "m4v", "webm"].includes(v?.container) && part?.key)
        stream = this.url(part.key, { "X-Plex-Token": this.credentials.token });
      else {
        stream = this.url("video/:/transcode/universal/start.m3u8", {
          path: `/library/metadata/${m.providerID}`,
          mediaIndex: 0,
          partIndex: 0,
          protocol: "hls",
          directPlay: 0,
          directStream: 1,
          videoCodec: "h264",
          audioCodec: "aac",
          subtitleCodec: "webvtt",
          maxVideoBitrate: 20000,
          videoResolution: "1920x1080",
          "X-Plex-Token": this.credentials.token,
          "X-Plex-Client-Identifier": this.source.id,
          "X-Plex-Platform": "Desktop",
          "X-Plex-Product": "Oxa's Library",
        });
        format = "hls";
      }
      const sub = (part?.Stream || []).find(
        (x: any) =>
          Number(x.streamType) === 3 &&
          (language === "de" ? ["de", "deu", "ger"] : ["en", "eng"]).includes(
            x.languageCode,
          ),
      );
      if (sub?.key && language !== "off")
        result.subtitleURL = this.url(sub.key, {
          "X-Plex-Token": this.credentials.token,
        });
    }
    if (!stream) throw Error("This title has no playable URL.");
    urlCheck(stream, this.source, true);
    if (!format) {
      const pathname = new URL(stream).pathname.toLowerCase();
      if (pathname.endsWith(".m3u8")) format = "hls";
      else if (pathname.endsWith(".ts") || pathname.endsWith(".mpegts"))
        format = "mpegts";
      else if (pathname.endsWith(".flv")) format = "flv";
      else if (!/\.(mp4|mov|m4v|webm)$/i.test(pathname))
        try {
          const probe = await request(
            stream,
            this.opts({ method: "HEAD", headers, media: true }),
          );
          probe.stream.resume();
          const mime = String(probe.headers["content-type"] || "");
          if (/mpegurl/i.test(mime)) format = "hls";
          else if (/mp2t/i.test(mime)) format = "mpegts";
        } catch {}
    }
    return {
      media: result,
      url: stream,
      headers,
      format: format === "m3u8" ? "hls" : format,
      choice,
    };
  }
}
