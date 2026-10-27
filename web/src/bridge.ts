import { BrowserDisk } from './storage';
import { BrowserCloud } from './cloud';
import { libraryView, mergeMedia } from '../../desktop/src/library-view';
import { kinds, uuid, hash, cloudKey, appleNow, bounded, ordered, nextEpisode, episodeChanges, type Media, type Source, type Credentials } from '../../desktop/src/model';

const BASE = '/web/api/';
const listeners = new Set<(value: any) => void>();
const actions = new Set<(value: string) => void>();
const normalized = (raw: string) => {
  try { const u = new URL(raw); return u.origin.toLowerCase() + u.pathname.replace(/\/+$/, '').replace(/\/mhub-addon\.json$/, ''); } catch { return ''; }
};
const isHuhu = (source: Source, credentials: Credentials) => source.kind === 'Library URL' && normalized(credentials?.endpoint || '') === 'https://huhu.to';
const mediaURL = (raw: string) => {
  try { const u = new URL(raw, location.origin); return u.origin === location.origin && u.pathname === '/web/api/media' && !!u.searchParams.get('token'); } catch { return false; }
};

class BrowserEngine {
  disk = new BrowserDisk('oxa-web-v1', () => this.changed());
  cloud = new BrowserCloud(this.disk, () => this.switched(), () => this.invalidate());
  initializing = true;
  loadingMessage = 'Connecting your library…';
  fatal = '';
  private storageReady = false;
  refreshing = new Set<string>();
  errors = new Map<string, string>();
  art = new Map<string, string>();
  choices = new Map<string, any>();
  metadataChoices = new Map<string, any>();
  active: any;
  private revision = 0;
  private projectionRevision = -1;
  private projection: ReturnType<typeof libraryView>;
  private wireIndex = new Map<string, Media>();
  private timer: ReturnType<typeof setTimeout>;
  private controllers = new Set<AbortController>();
  private observed = new Set<string>();
  readonly ready: Promise<void>;

  constructor() {
    this.ready = this.initialize();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) void this.disk.flushPending().catch(() => this.changed());
      else void this.cloud.sync().then(() => this.refreshMissing()).catch(() => {});
    });
    window.addEventListener('pagehide', () => { void this.disk.flushPending().catch(() => {}); });
    setInterval(() => {
      if (!document.hidden) {
        void this.cloud.sync().catch(() => {});
        for (const source of this.disk.state.sources) void this.refresh(source.id);
      }
    }, 10 * 60 * 1000);
  }
  private async initialize() {
    try {
      await this.disk.init();
      this.storageReady = true;
      this.invalidate();
      // Render cached content before Auth or provider network calls finish.
      queueMicrotask(() => void this.restore());
    } catch {
      this.initializing = false;
      this.fatal = 'Browser storage is unavailable. Allow website storage and reload to keep your library safely.';
      this.changed();
    }
  }
  private async restore() {
    try { await this.cloud.boot(); } catch { /* Existing local state remains visible. */ }
    try {
      await this.ensureDefault();
      this.initializing = false;
      this.loadingMessage = '';
      this.changed();
      this.refreshMissing(true);
    } catch {
      this.initializing = false;
      this.loadingMessage = '';
      this.fatal = 'Could not save the initial library. Retry Saving before closing this tab.';
      this.changed();
    }
  }
  private switched() {
    for (const controller of this.controllers) controller.abort();
    this.controllers.clear(); this.refreshing.clear(); this.observed.clear();
    this.errors.clear(); this.art.clear(); this.choices.clear(); this.metadataChoices.clear(); this.active = null;
    this.invalidate();
  }
  private async ensureDefault() {
    const key = 'web-default-' + this.disk.scope;
    if (this.disk.state.sources.some(source => isHuhu(source, this.disk.state.credentials[source.id]))) {
      this.disk.write(key, { installed: true }); return;
    }
    if (this.disk.read(key, {}).installed) return;
    const source: Source = { id: uuid(), name: 'huhu.to', kind: 'Library URL', host: 'huhu.to', allowHTTP: false, allowProviderFetch: false, allowInsecureStreams: false };
    this.disk.state.sources.push(source);
    this.disk.state.credentials[source.id] = { endpoint: 'https://huhu.to/', username: '', password: '', token: '', userID: '', guideURL: '' };
    this.disk.write(key, { installed: true });
    this.disk.save(); this.cloud.source(source); await this.disk.flushPending();
    this.invalidate();
  }
  private refreshMissing(force = false) {
    for (const source of this.disk.state.sources) {
      if (force || !this.observed.has(source.id)) { this.observed.add(source.id); void this.refresh(source.id); }
    }
  }
  private guard(sourceID?: string) {
    const scope = this.disk.scope, epoch = this.cloud.epoch;
    return () => {
      if (scope !== this.disk.scope || epoch !== this.cloud.epoch || (sourceID && !this.disk.state.sources.some(s => s.id === sourceID))) throw Error('Your account or source changed. Open the title again.');
    };
  }
  private invalidate() { this.revision++; this.changed(); }
  private getProjection() {
    if (this.projectionRevision !== this.revision) {
      this.wireIndex = new Map(this.disk.state.media.map(m => [hash(m.id), m]));
      this.projection = libraryView(this.disk.state, (raw, sourceID) => raw && (mediaURL(raw) ? raw : this.art.get(sourceID + ':' + raw)));
      this.projectionRevision = this.revision;
    }
    return this.projection;
  }
  private item(id: string): Media {
    this.getProjection();
    const item = this.wireIndex.get(id);
    if (!item) throw Error('This title is no longer in your library. Refresh the source.');
    return item;
  }
  view() {
    const p = this.getProjection();
    let hideWelcome = false;
    try { hideWelcome = this.disk.read('ui', {}).hideWelcome || false; }
    catch { this.fatal ||= 'Your browser settings could not be read. Your saved library has been kept.'; }
    return {
      sources: this.disk.state.sources.map(source => ({ ...source, websiteConnection: undefined, refreshing: this.refreshing.has(source.id), error: this.errors.get(source.id) })),
      media: p.media(), programs: p.programs(), transfers: [], preferences: this.disk.state.preferences,
      storageError: this.fatal || this.disk.saveError, initializing: this.initializing, loadingMessage: this.loadingMessage,
      hideWelcome,
      account: { email: this.cloud.identity?.email, signedIn: !!this.cloud.identity, unlocked: !!this.cloud.ready, syncing: this.cloud.syncing, message: this.cloud.message, lastSync: this.cloud.lastSync },
      platform: 'web', version: '1.0.0-web'
    };
  }
  changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const value = this.view(); for (const fn of listeners) fn(value);
      if (!this.initializing) this.refreshMissing();
    }, 32);
  }
  private merge(items: Media[]) {
    // Synced rows intentionally omit playback URLs. Move their mutable state
    // onto the real source row once its catalog is available.
    const peers = new Map(this.disk.state.media.filter(m => m.id.startsWith('cloud:')).map(m => [cloudKey(m), m]));
    for (const m of items) {
      const peer = peers.get(cloudKey(m));
      if (!peer) continue;
      const incoming = this.disk.state.progress[peer.id], current = this.disk.state.progress[m.id];
      if (incoming && (!current || incoming.playedAt > current.playedAt)) this.disk.state.progress[m.id] = incoming;
      if (this.disk.state.favorites.includes(peer.id) && !this.disk.state.favorites.includes(m.id)) this.disk.state.favorites.push(m.id);
    }
    mergeMedia(this.disk.state, items); this.revision++;
  }
  private async rpc(sourceID: string, operation: string, params: any = {}) {
    const source = this.disk.state.sources.find(s => s.id === sourceID);
    const credentials = this.disk.state.credentials[sourceID];
    if (!source || !credentials) throw Error('Reconnect this media source.');
    const credentialVersion = JSON.stringify(credentials);
    const check = this.guard(sourceID), controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 55000);
    try {
      const body = JSON.stringify({ operation, source, credentials, ...params });
      if (body.length > 131072) throw Error('The source request is too large. Refresh its library.');
      const response = await fetch(BASE + 'provider', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
      if (Number(response.headers.get('Content-Length')) > 6 * 1024 * 1024) throw Error('This library response is too large. Choose a smaller source.');
      const text = await response.text();
      if (text.length > 6 * 1024 * 1024) throw Error('This library response is too large. Choose a smaller source.');
      let data; try { data = JSON.parse(text); } catch { throw Error('The library service is unavailable. Retry shortly.'); }
      check();
      if (this.disk.state.sources.find(s => s.id === sourceID) !== source || JSON.stringify(this.disk.state.credentials[sourceID]) !== credentialVersion) throw Error('This source changed while loading. Retry with its current connection.');
      if (!response.ok || data.error) throw Error(typeof data.error === 'string' && !/https?:\/\/|[?&](token|password|key)=/i.test(data.error) ? data.error : 'The source request could not complete. Retry or choose another server.');
      // The provider may fill its cached manifest; it must not restore user
      // permissions or an old source name after an in-flight edit.
      if (data.source?.id === sourceID && data.source.websiteConnection) source.websiteConnection = data.source.websiteConnection;
      if (data.credentials) this.disk.state.credentials[sourceID] = data.credentials;
      for (const [raw, cap] of Object.entries(data.artwork || {})) if (typeof cap === 'string' && mediaURL(cap)) this.art.set(sourceID + ':' + raw, cap);
      return data.result;
    } catch (error: any) {
      if (error.name === 'AbortError') throw Error('The source took too long to respond. Retry when your connection is available.');
      throw error;
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async refresh(id: string) {
    if (this.refreshing.has(id)) return;
    const source = this.disk.state.sources.find(s => s.id === id); if (!source) return;
    const check = this.guard(id); this.refreshing.add(id); this.errors.delete(id); this.changed();
    try {
      const result = await this.rpc(id, 'catalog'); check();
      const followed = this.disk.state.media.filter(m => m.sourceID === id && m.kind === 'series' && this.disk.state.followedSeries?.[id + ':' + m.providerID]);
      for (const series of followed.slice(0, 100)) {
        try { const rows = series.websiteItem || source.kind === 'Xtream Codes' ? await this.rpc(id, 'episodes', { media: series }) : result.items.filter(m => m.kind === 'episode' && m.seriesID === series.providerID); check(); episodeChanges(this.disk.state, id, series.providerID, rows); result.items.push(...rows); } catch { /* Retain known episode state if a season is temporarily offline. */ }
      }
      const resultIDs = new Set(result.items.map(m => m.id));
      const oldEpisodes = this.disk.state.media.filter(m => m.sourceID === id && m.kind === 'episode' && !resultIDs.has(m.id));
      this.disk.state.media = this.disk.state.media.filter(m => m.sourceID !== id); this.merge([...result.items, ...oldEpisodes]);
      this.disk.state.programs = this.disk.state.programs.filter(p => p.sourceID !== id).concat(result.programs || []);
      this.disk.state.pages = (this.disk.state.pages || []).filter(p => p.sourceID !== id).concat(result.pages || []);
      source.refreshedAt = appleNow(); if (result.warning) this.errors.set(id, result.warning);
      this.disk.save(); this.cloud.source(source);
    } catch (error: any) {
      try { check(); this.errors.set(id, error.message || 'The source is unavailable. Your saved library is kept.'); } catch {}
    } finally { this.refreshing.delete(id); this.invalidate(); }
  }
  private async detail(id: string) {
    const m = this.item(id), check = this.guard(m.sourceID);
    const result = await this.rpc(m.sourceID, 'detail', { media: m }); check();
    this.merge([result.media, ...(result.episodes || [])]); this.disk.save();
    const episodes = this.disk.state.media.filter(e => e.sourceID === m.sourceID && e.seriesID === result.media.providerID && e.kind === 'episode');
    const p = this.getProjection();
    return { media: p.wire(result.media), episodes: ordered(episodes).map(p.wire), seasons: result.media.websiteItem?.seasons || [] };
  }
  private async play(id: string, choiceID?: string) {
    let m = this.item(id); const check = this.guard(m.sourceID);
    if (m.id.startsWith('cloud:')) {
      const real = this.disk.state.media.find(row => !row.id.startsWith('cloud:') && cloudKey(row) === cloudKey(m));
      if (!real) throw Error('Refresh the original source before playing this synced title.');
      m = real;
    }
    let choice;
    if (m.websiteItem) {
      if (!choiceID) {
        const result = await this.rpc(m.sourceID, 'sources', { media: m }); check(); this.merge([result.media]);
        this.choices.clear();
        const choices = (result.sources || []).map(c => { const key = uuid(); this.choices.set(key, { mediaID: m.id, media: result.media, choice: c }); return { id: key, name: c.name, kind: c.kind, providerName: c.providerName, languages: c.languages, quality: c.quality }; });
        if (!choices.length) throw Error('No playback server is currently available for this title.');
        return { choices, media: this.getProjection().wire(result.media) };
      }
      const selected = this.choices.get(choiceID);
      if (!selected || selected.mediaID !== m.id) throw Error('Source selection expired. Choose the server again.');
      m = selected.media; choice = selected.choice;
    }
    const result = await this.rpc(m.sourceID, 'playback', { media: m, choice, subtitleLanguage: this.disk.state.preferences.subtitleLanguage }); check();
    if (!mediaURL(result.url)) throw Error('The playback server returned an unsupported browser address.');
    this.merge([result.media]); this.active = { media: result.media, choice: result.choice || choice };
    this.disk.save();
    return { ...result, headers: undefined, media: this.getProjection().wire(result.media), resume: this.disk.state.progress[m.id]?.completed ? 0 : this.disk.state.progress[m.id]?.seconds || 0 };
  }
  private async next() {
    if (!this.active) return null;
    const previous = this.active, check = this.guard(previous.media.sourceID);
    let m = nextEpisode(this.disk.state.media, previous.media);
    if (!m) {
      const parent = this.disk.state.media.find(row => row.sourceID === previous.media.sourceID && row.providerID === previous.media.seriesID && row.kind === 'series');
      if (parent) {
        const number = parent.websiteItem?.seasons?.filter(s => s.number > (previous.media.season || 0)).sort((a,b) => a.number - b.number)[0]?.number;
        if (number != null) { const rows = await this.rpc(parent.sourceID, 'episodes', { media: parent, season: number }); check(); this.merge(rows); m = nextEpisode(this.disk.state.media, previous.media); }
      }
    }
    if (!m || previous !== this.active) return null;
    if (m.websiteItem && previous.choice) {
      const options = await this.rpc(m.sourceID, 'sources', { media: m }); check();
      const choice = options.sources.find(c => c.name === previous.choice.name && c.quality === previous.choice.quality && JSON.stringify(c.languages) === JSON.stringify(previous.choice.languages));
      if (choice) { const key = uuid(); this.choices.set(key, { mediaID: m.id, media: options.media, choice }); return this.play(hash(m.id), key); }
    }
    return this.play(hash(m.id));
  }
  async command(action: string, args: any = {}) {
    await this.ready;
    if (!args || typeof args !== 'object' || Array.isArray(args) || JSON.stringify(args).length > 131072) throw Error('Invalid application request.');
    switch (action) {
      case 'state': return this.view();
      case 'storage.retry': {
        if (!this.storageReady) { location.reload(); return this.view(); }
        await this.disk.flushPending(); await this.ensureDefault(); this.fatal = ''; this.changed(); return this.view();
      }
      case 'refresh': for (const s of this.disk.state.sources) if (!args.id || s.id === args.id) void this.refresh(s.id); return this.view();
      case 'source.add': case 'source.edit': {
        if (!kinds.includes(args.kind) || !String(args.name || '').trim() || String(args.name).length > 160) throw Error('Enter a source name and supported source type.');
        let endpoint: URL; try { endpoint = new URL(args.endpoint); } catch { throw Error('Enter a complete HTTPS server address.'); }
        if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw Error('The web app needs a reachable HTTPS source. Local HTTP servers require the native app.');
        const existing = this.disk.state.sources.find(s => s.kind === args.kind && normalized(this.disk.state.credentials[s.id]?.endpoint) === normalized(endpoint.href));
        const source: Source = { id: action === 'source.edit' ? args.id : existing?.id || uuid(), name: args.name.trim(), kind: args.kind, host: endpoint.host, allowHTTP: false, allowProviderFetch: args.allowProviderFetch === true, allowInsecureStreams: args.allowInsecureStreams === true };
        if (action === 'source.edit' && !this.disk.state.sources.some(s => s.id === source.id)) throw Error('This source no longer exists.');
        const credentials: Credentials = { endpoint: endpoint.href, username: args.username || '', password: args.password || '', token: args.token || '', userID: '', guideURL: args.guideURL || '' };
        this.disk.state.sources = this.disk.state.sources.filter(s => s.id !== source.id).concat(source); this.disk.state.credentials[source.id] = credentials;
        if (isHuhu(source, credentials)) this.disk.write('web-default-' + this.disk.scope, { installed: true });
        this.disk.save(); this.cloud.source(source); await this.disk.flushPending(); this.invalidate(); void this.refresh(source.id); return this.view();
      }
      case 'source.permission': {
        const source = this.disk.state.sources.find(s => s.id === args.id); if (!source) throw Error('This source no longer exists.');
        source.allowProviderFetch = args.enabled === true; this.disk.save(); this.cloud.source(source); await this.disk.flushPending(); this.changed(); return this.view();
      }
      case 'source.remove': {
        const source = this.disk.state.sources.find(s => s.id === args.id); if (!source) return this.view();
        this.cloud.source(source, true); this.disk.state.sources = this.disk.state.sources.filter(s => s.id !== source.id);
        this.disk.state.media = this.disk.state.media.filter(m => m.sourceID !== source.id); this.disk.state.programs = this.disk.state.programs.filter(p => p.sourceID !== source.id); delete this.disk.state.credentials[source.id];
        if (this.active?.media.sourceID === source.id) this.active = null;
        this.disk.save(); await this.disk.flushPending(); this.invalidate(); return this.view();
      }
      case 'detail': return this.detail(args.id);
      case 'season': {
        const m = this.item(args.id), check = this.guard(m.sourceID);
        let rows;
        if (m.websiteItem || this.disk.state.sources.find(s => s.id === m.sourceID)?.kind === 'Xtream Codes') rows = await this.rpc(m.sourceID, 'episodes', { media: m, season: Number(args.number) });
        else rows = this.disk.state.media.filter(e => e.sourceID === m.sourceID && e.seriesID === m.providerID && e.kind === 'episode' && e.season === Number(args.number));
        check(); this.merge(rows); this.disk.save(); this.changed(); return ordered(rows).map(this.getProjection().wire);
      }
      case 'more': {
        for (const page of (this.disk.state.pages || []).filter(p => p.cursor)) {
          const check = this.guard(page.sourceID); const result = await this.rpc(page.sourceID, 'page', { page }); check(); this.merge(result.items); Object.assign(page, result.page);
        }
        this.disk.save(); this.changed(); return this.view();
      }
      case 'search': {
        const query = String(args.query || '').trim().slice(0, 200); if (query.length < 2) return [];
        const check = this.guard(), results = await Promise.allSettled(this.disk.state.sources.map(s => this.rpc(s.id, 'search', { query })));
        check(); const rows = results.flatMap(r => r.status === 'fulfilled' ? r.value : []).filter(m => m.kind === 'movie' || m.kind === 'series');
        this.merge(rows); this.disk.save(); this.changed(); return rows.map(this.getProjection().wire);
      }
      case 'play': return this.play(args.id, args.choiceID);
      case 'next': return this.next();
      case 'progress': {
        const m = this.item(args.id), seconds = bounded(args.seconds), duration = bounded(args.duration);
        if (m.kind === 'episode' && m.seriesID) {
          this.disk.state.followedSeries ??= {}; const key = m.sourceID + ':' + m.seriesID;
          this.disk.state.followedSeries[key] ??= this.disk.state.media.filter(e => e.sourceID === m.sourceID && e.seriesID === m.seriesID && e.kind === 'episode').map(e => e.id);
          this.disk.state.newEpisodeIDs = (this.disk.state.newEpisodeIDs || []).filter(id => id !== m.id);
        }
        this.disk.state.progress[m.id] = { seconds, duration, completed: args.ended === true || (duration > 0 && seconds >= duration - Math.min(30, duration * 0.03)), playedAt: appleNow() };
        this.disk.saveSoon(); this.cloud.progress(m);
        const patch = { partial: true, mediaUpdates: this.getProjection().status(new Set([m.id])) }; for (const fn of listeners) fn(patch);
        return true;
      }
      case 'favorite': {
        const m = this.item(args.id), present = !this.disk.state.favorites.includes(m.id);
        this.disk.state.favorites = this.disk.state.favorites.filter(id => id !== m.id); if (present) this.disk.state.favorites.push(m.id);
        this.disk.save(); this.cloud.watchlist(m, present); await this.disk.flushPending(); this.invalidate(); return this.view();
      }
      case 'preferences': {
        const p = this.disk.state.preferences;
        if (['en','de'].includes(args.audioLanguage)) p.audioLanguage = args.audioLanguage;
        if (['en','de','off'].includes(args.subtitleLanguage)) p.subtitleLanguage = args.subtitleLanguage;
        if (typeof args.autoplay === 'boolean') p.autoplay = args.autoplay;
        this.disk.save(); this.cloud.preferences(); await this.disk.flushPending(); this.changed(); return this.view();
      }
      case 'welcome': this.disk.write('ui', { ...this.disk.read('ui', {}), hideWelcome: !!args.hide }); await this.disk.flushPending(); return true;
      case 'account': { const result = await this.cloud.auth(String(args.action), args); await this.ensureDefault(); this.invalidate(); this.refreshMissing(); return result; }
      case 'signout': await this.cloud.signout(); await this.ensureDefault(); this.invalidate(); this.refreshMissing(); return this.view();
      case 'sync': await this.cloud.sync(); this.invalidate(); this.refreshMissing(); return this.view();
      case 'deleteAccount': await this.cloud.deleteAccount(String(args.password || '')); await this.ensureDefault(); this.invalidate(); this.refreshMissing(); return this.view();
      case 'closePlayer': this.active = null; await this.disk.flushPending(); return true;
      case 'caption.import': return chooseCaption();
      case 'metadata.token': {
        const token = String(args.token || '').trim(); if (token.length > 8192 || /[\r\n]/.test(token)) throw Error('Invalid metadata read token.');
        this.disk.write('metadata-' + this.disk.scope, { token }); this.disk.state.preferences.externalMetadata = !!token; this.disk.save(); await this.disk.flushPending(); this.changed(); return this.view();
      }
      case 'metadata.search': {
        const m = this.item(args.id), token = this.disk.read('metadata-' + this.disk.scope, {}).token;
        if (!this.disk.state.preferences.externalMetadata || !token) throw Error('Add your TMDB read token in Settings first.');
        const rows = await this.rpc(m.sourceID, 'metadataSearch', { query: m.title, kind: m.kind, token }); this.metadataChoices.clear();
        return rows.map(fields => { const id = uuid(); this.metadataChoices.set(id, { mediaID: m.id, fields }); return { id, ...fields, poster: fields.poster && this.art.get(m.sourceID + ':' + fields.poster) }; });
      }
      case 'metadata.apply': {
        const m = this.item(args.id), choice = this.metadataChoices.get(args.choiceID); if (!choice || choice.mediaID !== m.id) throw Error('Metadata selection expired. Search again.');
        this.disk.state.metadata ??= {}; this.disk.state.metadata[m.id] = choice.fields; Object.assign(m, choice.fields); this.disk.save(); this.invalidate(); return this.detail(args.id);
      }
      case 'donation.copy': {
        const addresses = { bitcoin: '3KZ8qzJpBZSj9BazUMqUcG761UpVivQKGV', litecoin: 'MTToUVnMpepWixDhUPBBG1SgdmxjifArwF' };
        if (!addresses[args.network]) throw Error('Unknown donation network.'); await navigator.clipboard.writeText(addresses[args.network]); return true;
      }
      case 'licenses': return (await fetch('/web/THIRD-PARTY-NOTICES.txt')).text();
      case 'external': {
        const raw = String(args.url || ''); if (!raw.startsWith('https://')) throw Error('Only HTTPS links can be opened.');
        window.open(raw, '_blank', 'noopener,noreferrer'); return true;
      }
      case 'fullscreen': { const player = document.querySelector('#player') as HTMLElement; if (document.fullscreenElement) await document.exitFullscreen(); else await player.requestFullscreen(); return true; }
      default: throw Error('This action is unavailable in the web app.');
    }
  }
}

let captionURL: string;
function chooseCaption(): Promise<{url:string} | null> {
  return new Promise(resolve => {
    const picker = document.createElement('input'); picker.type = 'file'; picker.accept = '.vtt,.srt';
    picker.oncancel = () => resolve(null);
    picker.onchange = async () => {
      const file = picker.files?.[0]; if (!file) { resolve(null); return; }
      if (!/\.(vtt|srt)$/i.test(file.name) || file.size > 2 * 1024 * 1024) { resolve(null); return; }
      let text = await file.text();
      if (!text.trimStart().startsWith('WEBVTT')) text = 'WEBVTT\n\n' + text.replace(/\r\n/g, '\n').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      if (captionURL) URL.revokeObjectURL(captionURL);
      captionURL = URL.createObjectURL(new Blob([text], { type: 'text/vtt' })); resolve({ url: captionURL });
    };
    picker.click();
  });
}
const engine = new BrowserEngine();
window.oxa = {
  capabilities: { web: true, downloads: false },
  command: (action, args) => engine.command(action, args),
  onUpdate: fn => { listeners.add(fn); return () => listeners.delete(fn); },
  onAction: fn => { actions.add(fn); return () => actions.delete(fn); },
};
