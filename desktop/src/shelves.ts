// Derived shelves for the library. Everything here is computed on this device from
// signals the library already has (titles, descriptions, watch progress, the
// watchlist, saved downloads and the guide). Nothing is stored, synced or sent.

export const THRESHOLD = 0.1;
const FRANCHISE_BONUS = 0.35;
export const CANDIDATE_LIMIT = 5000;

const STOP = new Set(
  (
    "the and for with from that this these those into onto over under after before about " +
    "his her hers their theirs they them she him its our ours you your yours who whom whose " +
    "what when where while which why how are was were been being has have had but not nor " +
    "all any each every one two three some such than then there here out off very more most " +
    "own other only just also again once upon will would could should can may might must " +
    "film films movie movies series season episode episodes part new"
  ).split(" "),
);

const plain = (text: string) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Folds simple English plurals so "mountains" meets "mountain".
const stem = (t: string) =>
  t.length > 4 && t.endsWith("ies")
    ? t.slice(0, -3) + "y"
    : t.length > 4 && t.endsWith("s") && !t.endsWith("ss")
      ? t.slice(0, -1)
      : t;

export function tokens(text: string): string[] {
  return plain(text)
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t))
    .map(stem);
}

// "Spider-Man: Brand New Day" and "Spider-Man" share the key "spider-man".
export function franchise(title: string): string {
  const head = plain(title)
    .split(/\s*[:–—]\s*|\s+-\s+/)[0]
    .replace(/^the\s+/, "")
    .replace(/\s+(part\s+)?([0-9]+|ii|iii|iv|v|vi)$/, "")
    .trim();
  return head.replace(/[^a-z0-9]/g, "").length >= 3 ? head : "";
}

type Doc = { item: any; key: string; terms: Map<string, number>; norm: number };

export class SimilarityIndex {
  docs: Doc[] = [];
  private byID = new Map<string, number>();
  private postings = new Map<string, [number, number][]>();
  private constructor() {}

  // Builds in steps so a large catalog can be indexed during idle time.
  static builder(items: any[], limit = CANDIDATE_LIMIT) {
    const pool = items
      .filter((m) => m && (m.kind === "movie" || m.kind === "series"))
      .slice(0, limit);
    const index = new SimilarityIndex();
    const raw: Map<string, number>[] = [];
    const df = new Map<string, number>();
    let phase = 0,
      i = 0;
    const now = () =>
      typeof performance !== "undefined" ? performance.now() : Date.now();
    return {
      step(budgetMs = 8): SimilarityIndex | undefined {
        const end = now() + budgetMs;
        while (now() < end || budgetMs <= 0) {
          if (phase === 0) {
            if (i >= pool.length) {
              phase = 1;
              i = 0;
              continue;
            }
            const m = pool[i++],
              counts = new Map<string, number>();
            for (const t of tokens(m.seriesTitle || m.title))
              counts.set(t, (counts.get(t) || 0) + 1);
            for (const t of tokens(m.overview))
              counts.set(t, (counts.get(t) || 0) + 1);
            for (const t of counts.keys()) df.set(t, (df.get(t) || 0) + 1);
            raw.push(counts);
          } else {
            if (i >= pool.length) return index;
            const counts = raw[i],
              terms = new Map<string, number>();
            let sum = 0;
            for (const [t, c] of counts) {
              // A word found in one title only can never be shared; it still
              // counts toward length, at half weight, so tiny overlaps stay small.
              const n = df.get(t)!,
                w =
                  (1 + Math.log(c)) *
                  Math.log(1 + pool.length / n) *
                  (n === 1 ? 0.5 : 1);
              terms.set(t, w);
              sum += w * w;
            }
            const doc = {
              item: pool[i],
              key: franchise(pool[i].title),
              terms,
              norm: Math.sqrt(sum) || 1,
            };
            index.byID.set(pool[i].id, index.docs.length);
            for (const [t, w] of terms) {
              const list = index.postings.get(t);
              if (list) list.push([index.docs.length, w]);
              else index.postings.set(t, [[index.docs.length, w]]);
            }
            index.docs.push(doc);
            i++;
          }
          if (budgetMs <= 0) continue;
        }
        return undefined;
      },
    };
  }

  static build(items: any[], limit = CANDIDATE_LIMIT) {
    return SimilarityIndex.builder(items, limit).step(0)!;
  }

  has(id: string) {
    return this.byID.has(id);
  }

  // Scores every other catalog title against one seed title.
  scores(id: string): Map<number, number> {
    const out = new Map<number, number>();
    const s = this.byID.get(id);
    if (s == null) return out;
    const seed = this.docs[s];
    for (const [t, w] of seed.terms)
      for (const [d, v] of this.postings.get(t) || [])
        if (d !== s) out.set(d, (out.get(d) || 0) + w * v);
    for (const [d, dot] of out)
      out.set(d, dot / (seed.norm * this.docs[d].norm));
    if (seed.key)
      this.docs.forEach((doc, d) => {
        if (d !== s && doc.key === seed.key)
          out.set(d, (out.get(d) || 0) + FRANCHISE_BONUS);
      });
    return out;
  }

  similar(id: string, exclude: Set<string> = new Set(), limit = 40) {
    return ranked(this, this.scores(id), exclude, limit);
  }
}

function ranked(
  index: SimilarityIndex,
  scores: Map<number, number>,
  exclude: Set<string>,
  limit: number,
) {
  return [...scores]
    .filter(([d, v]) => v >= THRESHOLD && !exclude.has(index.docs[d].item.id))
    .sort(
      ([a, x], [b, y]) =>
        y - x ||
        String(index.docs[a].item.title).localeCompare(
          String(index.docs[b].item.title),
        ),
    )
    .slice(0, limit)
    .map(([d]) => index.docs[d].item);
}

const played = (m: any) => m.progress?.playedAt || 0;
const touched = (m: any) => m.progress?.seconds > 0 || m.progress?.completed;

// Episodes stand for their series; the result holds catalog titles only.
function catalogTitle(m: any, series: Map<string, any>) {
  return m.kind === "episode" ? series.get(m.seriesID) : m;
}

export function history(items: any[]) {
  const series = new Map(
    items.filter((m) => m.kind === "series").map((m) => [m.id, m]),
  );
  const latest = new Map<string, { item: any; at: number; done: boolean }>();
  for (const m of items) {
    if (!touched(m) || m.kind === "channel") continue;
    const t = catalogTitle(m, series);
    if (!t) continue;
    const prev = latest.get(t.id),
      at = played(m),
      done = !!m.progress?.completed && m.kind === "movie";
    if (!prev || at > prev.at)
      latest.set(t.id, { item: t, at, done: done || !!prev?.done });
    else if (done) prev.done = true;
  }
  const recent = [...latest.values()].sort(
    (a, b) => b.at - a.at || String(a.item.id).localeCompare(b.item.id),
  );
  const watchlist = items.filter(
    (m) => m.favorite && (m.kind === "movie" || m.kind === "series"),
  );
  return { recent, watchlist, seen: new Set(latest.keys()) };
}

// Changes only when a title is started, finished or saved; a progress tick does not.
export function seedSignature(items: any[]) {
  const h = history(items);
  return JSON.stringify([
    h.recent.slice(0, 12).map((r) => [r.item.id, r.done]),
    h.watchlist.map((m) => m.id),
  ]);
}

export function watchAgain(items: any[], limit = 40) {
  const done = items
    .filter((m) => m.kind === "movie" && m.progress?.completed)
    .sort((a, b) => played(b) - played(a) || a.id.localeCompare(b.id));
  return done.length >= 3 ? done.slice(0, limit) : [];
}

export function becauseYouWatched(
  index: SimilarityIndex,
  items: any[],
  max = 2,
  limit = 40,
) {
  const h = history(items);
  const seeds = [...h.recent.map((r) => r.item), ...h.watchlist].filter(
    (m, i, all) => all.findIndex((x) => x.id === m.id) === i && index.has(m.id),
  );
  const out: { seed: any; items: any[] }[] = [];
  for (const seed of seeds) {
    if (out.length >= max) break;
    const exclude = new Set([seed.id, ...h.seen]);
    const rows = index.similar(seed.id, exclude, limit);
    if (rows.length >= 5) out.push({ seed, items: rows });
  }
  return out;
}

export function picks(
  index: SimilarityIndex,
  items: any[],
  limit = 40,
  now = Date.now() / 1000 - 978307200,
) {
  const h = history(items);
  const weights = new Map<string, number>();
  for (const m of h.watchlist) weights.set(m.id, 1);
  for (const r of h.recent) {
    const days = Math.max(0, (now - r.at) / 86400),
      w = (r.done ? 0.8 : 0.6) / (1 + days / 30);
    weights.set(r.item.id, Math.max(weights.get(r.item.id) || 0, w));
  }
  const seeds = [...weights].filter(([id]) => index.has(id));
  if (seeds.length < 3) return [];
  const total = new Map<number, number>();
  for (const [id, w] of seeds)
    for (const [d, v] of index.scores(id))
      if (v >= THRESHOLD) total.set(d, (total.get(d) || 0) + v * w);
  const exclude = new Set([...h.seen, ...h.watchlist.map((m) => m.id)]);
  const norm = Math.max(...seeds.map(([, w]) => w));
  for (const [d, v] of total) total.set(d, v / norm);
  const rows = ranked(index, total, exclude, limit);
  return rows.length >= 8 ? rows : [];
}

export function moreLikeThis(index: SimilarityIndex, id: string, limit = 20) {
  const rows = index.similar(id, new Set([id]), limit);
  return rows.length >= 4 ? rows : [];
}

export function readyOffline(transfers: any[]) {
  return transfers.filter((t) => t.state === "ready").map((t) => t.media);
}

// Channels with a programme on air now, favourites first, with what follows.
export function onNow(channels: any[], programs: any[], now: number) {
  const byChannel = new Map<string, any[]>();
  for (const p of programs) {
    const list = byChannel.get(p.mediaID);
    if (list) list.push(p);
    else byChannel.set(p.mediaID, [p]);
  }
  const out: { channel: any; program: any; next?: any }[] = [];
  for (const channel of channels) {
    const list = byChannel.get(channel.id);
    if (!list) continue;
    const program = list.find((p) => p.start <= now && p.end > now);
    if (!program) continue;
    const next = list
      .filter((p) => p.start >= program.end)
      .sort((a, b) => a.start - b.start)[0];
    out.push({ channel, program, next });
  }
  return out.sort(
    (a, b) =>
      Number(!!b.channel.favorite) - Number(!!a.channel.favorite) ||
      String(a.channel.title).localeCompare(String(b.channel.title)),
  );
}
