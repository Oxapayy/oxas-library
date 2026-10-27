import { cloudKey, hash, ordinal, Media, Snapshot } from "./model";

// Build joins once per publication. Catalogs can contain tens of thousands of
// episodes and guide entries; scanning/hashing the catalog inside each row made
// a single download progress notification monopolize Electron's main thread.
export function libraryView(
  state: Snapshot,
  artwork: (url: string, sourceID: string) => string | undefined,
) {
  const identities = new Map<string, string>();
  const peers = new Map<string, Media[]>();
  const localIdentities = new Set<string>();
  const favorites = new Set(state.favorites);
  const newEpisodes = new Set(state.newEpisodeIDs || []);
  const ready = new Set(
    state.transfers.filter((t) => t.state === "ready").map((t) => t.media.id),
  );
  const channels = new Map<string, string>();
  const wireIDs = new Map<string, string>();
  const wireID = (id: string) => {
    let value = wireIDs.get(id);
    if (!value) wireIDs.set(id, (value = hash(id)));
    return value;
  };
  for (const m of state.media) {
    const identity = cloudKey(m);
    identities.set(m.id, identity);
    const matches = peers.get(identity);
    if (matches) matches.push(m);
    else peers.set(identity, [m]);
    if (!m.id.startsWith("cloud:")) localIdentities.add(identity);
    if (m.channelID != null) {
      const key = JSON.stringify([m.sourceID, m.channelID]);
      if (!channels.has(key)) channels.set(key, wireID(m.id));
    }
  }
  const status = (m: Media) => {
    const identity = identities.get(m.id) || cloudKey(m);
    const candidates = peers.get(identity);
    const peer =
      candidates?.[0]?.id !== m.id ? candidates?.[0] : candidates?.[1];
    return {
      id: wireID(m.id),
      progress: state.progress[m.id] || state.progress[peer?.id],
      favorite: favorites.has(m.id),
      newEpisode: newEpisodes.has(m.id) && !state.progress[m.id]?.seconds,
      download: ready.has(m.id),
    };
  };
  const wire = (m: Media) => ({
    ...status(m),
    sourceID: m.sourceID,
    title: m.title,
    kind: m.kind,
    overview: m.overview,
    year: m.year,
    duration: m.duration,
    poster: artwork(m.poster, m.sourceID),
    backdrop: artwork(m.backdrop, m.sourceID),
    seriesTitle: m.seriesTitle,
    seriesID: m.seriesID ? wireID(m.sourceID + ":" + m.seriesID) : undefined,
    season: ordinal(m.season),
    episode: ordinal(m.episode),
    group: m.group,
    creditsStart: m.creditsStart,
  });
  return {
    wire,
    media: () =>
      state.media
        .filter(
          (m) =>
            !m.id.startsWith("cloud:") ||
            !localIdentities.has(identities.get(m.id)!),
        )
        .map(wire),
    programs: () =>
      state.programs.map((p) => ({
        ...p,
        id: hash(p.id),
        channelID: undefined,
        mediaID: channels.get(JSON.stringify([p.sourceID, p.channelID])),
      })),
    transfers: () =>
      state.transfers.map((t) => ({
        id: t.id,
        media: wire(t.media),
        state: t.state,
        bytes: t.bytes,
        fraction: t.fraction,
        error: t.error,
      })),
    // Frequent progress updates carry only mutable row state, never the entire
    // catalog, artwork URLs and programme guide over IPC again.
    status: (ids?: Set<string>) =>
      state.media.filter((m) => !ids || ids.has(m.id)).map(status),
  };
}

export function mergeMedia(state: Snapshot, items: Media[]) {
  const positions = new Map(state.media.map((m, index) => [m.id, index]));
  for (const row of items) {
    const m = { ...row, ...(state.metadata?.[row.id] || {}) };
    const index = positions.get(m.id);
    if (index == null) {
      positions.set(m.id, state.media.length);
      state.media.push(m);
    } else state.media[index] = { ...state.media[index], ...m };
  }
}
