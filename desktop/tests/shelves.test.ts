import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SimilarityIndex,
  THRESHOLD,
  becauseYouWatched,
  franchise,
  moreLikeThis,
  onNow,
  picks,
  readyOffline,
  seedSignature,
  tokens,
  watchAgain,
} from "../src/shelves";

const NOW = 800_000_000;
const film = (id: string, title: string, overview = "", extra: any = {}) => ({
  id,
  title,
  overview,
  kind: "movie",
  ...extra,
});
const done = (ago: number) => ({
  seconds: 5000,
  duration: 5000,
  completed: true,
  playedAt: NOW - ago,
});
const coast = [
  film(
    "c1",
    "Salt Wind",
    "A fishing family on the coast waits for the sea to calm.",
  ),
  film(
    "c2",
    "Tide Line",
    "A biologist maps the coast while the sea tide rewrites the shore.",
  ),
  film(
    "c3",
    "Harbour Town",
    "A sailor returns to the harbour town on the coast by the sea.",
  ),
  film("c4", "Winter Sea", "Fishermen brave the winter sea off a cold coast."),
  film(
    "c5",
    "The Lighthouse Keeper",
    "Alone at sea off the coast, a keeper writes to the harbour.",
  ),
  film(
    "c6",
    "Glass House",
    "An architect builds a house on a cliff above the sea coast.",
  ),
  film(
    "c7",
    "Low Water",
    "The sea retreats from a fishing coast for one strange week.",
  ),
];
const mountains = [
  film(
    "m1",
    "High Pass",
    "Climbers cross a mountain pass before the winter snow.",
  ),
  film(
    "m2",
    "Snowline",
    "A ranger follows wolves along the snow line of a mountain valley.",
  ),
  film(
    "m3",
    "The Last Train",
    "A final night shift on the mountain railway in the snow.",
  ),
  film(
    "m4",
    "A Place Apart",
    "Two sisters return to the mountains and the snow.",
  ),
];
const other = [
  film("o1", "The Orchard", "Three generations harvest apples in an orchard."),
  film(
    "o2",
    "Kitchen Table",
    "A cook argues and forgives around one kitchen table.",
  ),
  film(
    "o3",
    "Old Friends",
    "Four friends meet again at a wedding thirty years later.",
  ),
];
const catalog = () => structuredClone([...coast, ...mountains, ...other]);

test("tokens drop stop words, short words, digits and diacritics", () => {
  assert.deepEqual(tokens("The Café on the Coast, 2024 — a film"), [
    "cafe",
    "coast",
  ]);
});

test("franchise keys join sequels and subtitles, not unrelated titles", () => {
  assert.equal(franchise("Spider-Man: Brand New Day"), franchise("Spider-Man"));
  assert.equal(franchise("Northern Light 2"), "northern light");
  assert.equal(franchise("The Orchard"), "orchard");
  assert.notEqual(franchise("The Quiet Coast"), franchise("Quiet Hours"));
  assert.equal(franchise("Up"), "");
});

test("an empty history produces no derived shelves", () => {
  const items = catalog(),
    index = SimilarityIndex.build(items);
  assert.deepEqual(watchAgain(items), []);
  assert.deepEqual(becauseYouWatched(index, items), []);
  assert.deepEqual(picks(index, items, 40, NOW), []);
  assert.deepEqual(readyOffline([]), []);
});

test("franchise titles match even without any description", () => {
  const items = [
    film("a", "Spider-Man"),
    film("b", "Spider-Man: Brand New Day"),
    film("c", "Kitchen Table"),
  ];
  const index = SimilarityIndex.build(items);
  assert.deepEqual(
    index.similar("a").map((m) => m.id),
    ["b"],
  );
});

test("unrelated titles stay under the threshold", () => {
  const index = SimilarityIndex.build(catalog());
  const scores = index.scores("o1");
  for (const [d, v] of scores)
    if (index.docs[d].item.id.startsWith("c")) assert.ok(v < THRESHOLD);
  assert.ok(
    index
      .similar("c1")
      .every((m: any) => m.id.startsWith("c") || m.id.startsWith("m")),
  );
});

test("titles without a description are scored by their title", () => {
  const items = [
    film("a", "Harbour Lights"),
    film("b", "Harbour Lights at Night", "Boats in a harbour."),
    film("c", "Orchard Days"),
  ];
  const index = SimilarityIndex.build(items);
  assert.deepEqual(
    index.similar("a").map((m) => m.id),
    ["b"],
  );
});

test("watch again needs three finished films, newest first", () => {
  const items = catalog();
  items[0].progress = done(300);
  items[1].progress = done(100);
  assert.deepEqual(watchAgain(items), []);
  items[7].progress = done(200);
  assert.deepEqual(
    watchAgain(items).map((m) => m.id),
    ["c2", "m1", "c1"],
  );
});

test("because you watched uses one seed per shelf and needs five matches", () => {
  const items = catalog();
  items[0].progress = done(100);
  const index = SimilarityIndex.build(items);
  const rows = becauseYouWatched(index, items);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seed.id, "c1");
  assert.ok(rows[0].items.length >= 5);
  assert.ok(!rows[0].items.some((m) => m.id === "c1"));
  const mountainSeed = catalog();
  mountainSeed[10].progress = done(50);
  const mountainRows = becauseYouWatched(
    SimilarityIndex.build(mountainSeed),
    mountainSeed,
  );
  assert.deepEqual(mountainRows, []);
});

test("picks need three seeds and eight matches and skip seen or saved titles", () => {
  const items = catalog();
  items[0].progress = done(100);
  items[1].progress = done(200);
  const index = SimilarityIndex.build(items);
  assert.deepEqual(picks(index, items, 40, NOW), []);
  items[7].favorite = true;
  const rows = picks(index, items, 40, NOW);
  assert.ok(rows.length >= 8, `got ${rows.length}`);
  for (const id of ["c1", "c2", "m1"])
    assert.ok(!rows.some((m) => m.id === id));
});

test("more like this needs four matches", () => {
  const index = SimilarityIndex.build(catalog());
  assert.ok(moreLikeThis(index, "c1").length >= 4);
  assert.deepEqual(moreLikeThis(index, "o2"), []);
});

test("results are deterministic and capped", () => {
  const items = catalog();
  items[0].progress = done(100);
  const a = becauseYouWatched(SimilarityIndex.build(items), items);
  const b = becauseYouWatched(
    SimilarityIndex.build(structuredClone(items)),
    items,
  );
  assert.deepEqual(
    a.map((r) => r.items.map((m) => m.id)),
    b.map((r) => r.items.map((m) => m.id)),
  );
  assert.ok(
    SimilarityIndex.build(items).similar("c1", new Set(), 2).length <= 2,
  );
  const many = Array.from({ length: 7000 }, (_, i) =>
    film(`x${i}`, `Title ${i}`),
  );
  assert.equal(SimilarityIndex.build(many).docs.length, 5000);
});

test("the seed signature ignores progress ticks but follows a new seed", () => {
  const items = catalog();
  items[0].progress = { seconds: 10, duration: 5000, playedAt: NOW - 10 };
  const before = seedSignature(items);
  items[0].progress = { seconds: 40, duration: 5000, playedAt: NOW - 10 };
  assert.equal(seedSignature(items), before);
  items[1].progress = done(5);
  assert.notEqual(seedSignature(items), before);
});

test("on now lists airing channels, favourites first, with the next programme", () => {
  const channels = [
    { id: "a", title: "Alpha", kind: "channel" },
    { id: "b", title: "Bravo", kind: "channel", favorite: true },
    { id: "c", title: "Charlie", kind: "channel" },
  ];
  const programs = [
    { mediaID: "a", title: "A now", start: 90, end: 110 },
    { mediaID: "a", title: "A next", start: 110, end: 130 },
    { mediaID: "b", title: "B now", start: 95, end: 105 },
    { mediaID: "c", title: "C later", start: 120, end: 140 },
  ];
  const rows = onNow(channels, programs, 100);
  assert.deepEqual(
    rows.map((r) => r.channel.id),
    ["b", "a"],
  );
  assert.equal(rows[1].next.title, "A next");
});

test("ready offline lists finished downloads only", () => {
  assert.deepEqual(
    readyOffline([
      { state: "ready", media: { id: "a" } },
      { state: "downloading", media: { id: "b" } },
    ]).map((m) => m.id),
    ["a"],
  );
});

test("a 20,000 title catalog indexes in bounded steps", () => {
  const words =
    "coast sea harbour mountain snow winter city rain night summer field river orchard train house".split(
      " ",
    );
  const big = Array.from({ length: 20000 }, (_, i) =>
    film(
      `t${i}`,
      `${words[i % 15]} ${words[(i * 7) % 15]} ${i}`,
      `${words[(i * 3) % 15]} and ${words[(i * 11) % 15]} story ${i}`,
    ),
  );
  big.slice(0, 6).forEach((m, i) => (m.progress = done(i * 100)));
  const started = performance.now();
  const builder = SimilarityIndex.builder(big);
  let index: SimilarityIndex | undefined,
    steps = 0;
  while (!(index = builder.step(8))) steps++;
  const built = performance.now() - started;
  const t = performance.now();
  becauseYouWatched(index, big);
  picks(index, big, 40, NOW);
  const queried = performance.now() - t;
  console.log(
    `shelves: indexed ${index.docs.length} of ${big.length} titles in ${built.toFixed(0)} ms over ${steps + 1} steps; shelves in ${queried.toFixed(0)} ms`,
  );
  assert.equal(index.docs.length, 5000);
  assert.ok(steps > 0);
});
