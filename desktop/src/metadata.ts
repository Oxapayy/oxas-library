import { json } from "./network";
export async function metadataSearch(
  title: string,
  kind: string,
  token: string,
) {
  if (!["movie", "series"].includes(kind))
    throw Error("Choose a movie or series for metadata search.");
  const u = new URL(
    "https://api.themoviedb.org/3/search/" +
      (kind === "series" ? "tv" : "movie"),
  );
  u.searchParams.set("query", title.slice(0, 200));
  u.searchParams.set("language", "en-US");
  const result = await json(u.href, {
    publicOnly: true,
    headers: { Authorization: "Bearer " + token },
    limit: 2 * 1024 * 1024,
  });
  const image = (p: any) =>
    typeof p === "string" && /^\/[a-zA-Z0-9._/-]+$/.test(p)
      ? "https://image.tmdb.org/t/p/w780" + p
      : undefined;
  return (result.results || []).slice(0, 20).map((m: any) => ({
    title: String(m.title || m.name || "Untitled"),
    overview: String(m.overview || ""),
    year: parseInt(m.release_date || m.first_air_date) || undefined,
    poster: image(m.poster_path),
    backdrop: image(m.backdrop_path),
  }));
}
