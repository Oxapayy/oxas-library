"""Provider contract fixtures for local tests, not a substitute for live-server validation."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote
import json
from pathlib import Path

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def send(self, value, status=200, mime="application/json"):
        body = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(status); self.send_header("Content-Type", mime); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_HEAD(self):
        path = urlparse(self.path).path
        self.send_response(200)
        self.send_header("Content-Type", "video/mp4" if path.endswith(".mp4") or path == "/extensionless-video" else "text/html")
        self.end_headers()
    def website(self, path, query):
        origin = "http://127.0.0.1:8789"
        if path == "/website/mhub-addon.json":
            return {"id":"fixture-repository","name":"Fixture Library","specVersion":2,"addons":[{"url":"./vod","enabled":True},{"url":"./live","enabled":True},{"url":"./disabled","enabled":False}]}
        if path == "/website/vod/mhub-addon.json":
            return {"id":"fixture-vod","name":"Fixture Video","specVersion":2,"resources":["source","resolve"],"idPrefixes":["tmdb","imdb"],"urlPatterns":["*/website/watch/*"],"requires":[{"url":"../metadata","enabled":True}]}
        if path == "/website/metadata/mhub-addon.json":
            return {"id":"fixture-metadata","name":"Fixture Metadata","specVersion":2,"resources":["catalog","item"],"catalogs":[{"id":"movies","name":"Movies","type":"video","features":{"search":True}},{"id":"shows","name":"Series","type":"series","features":{"search":True}}]}
        if path == "/website/live/mhub-addon.json":
            return {"id":"fixture-live","name":"Fixture Live","specVersion":2,"resources":["catalog","item","resolve"],"urlPatterns":["*/website/watch/*"],"catalogs":[{"id":"channels","name":"Channels","type":"live"}]}
        movie = {"id":"movie-1","type":"video","name":"Library Film","description":"A source-owned description","runtime":120,"ids":{"tmdb":"42"},"images":{"poster":"/poster.jpg"}}
        series = {"id":"show-1","type":"series","name":"Library Series","ids":{"tmdb":"43"},"catalogs":[{"id":"season-one","name":"Season 1","type":"video","season":1}]}
        episode = {"id":"episode-1","type":"video","name":"First Episode","season":1,"episode":1,"ids":{"tmdb":"43:1:1"},"sources":[{"url":origin+"/file.mp4","name":"File"}]}
        if path == "/website/metadata/catalog/video/movies.json":
            if query.get("search"): return {"items":[dict(movie,id="search-only",name="Remote Only Film")],"nextCursor":None}
            if query.get("cursor") == ["page-2"]: return {"items":[dict(movie,id="movie-2",name="Second Library Film")],"nextCursor":None}
            return {"items":[movie],"nextCursor":"page-2"}
        if path == "/website/metadata/catalog/series/shows.json": return {"items":[series],"nextCursor":None}
        if path == "/website/metadata/catalog/video/season-one.json": return {"items":[episode],"nextCursor":None}
        if path == "/website/metadata/item/series/show-1.json": return series
        if path == "/website/metadata/item/video/episode-1.json": return episode
        if path.startswith("/website/metadata/item/video/"): return movie
        if path == "/website/live/catalog/live/channels.json":
            return {"items":[{"id":"tv-1","type":"live","name":"Library TV","url":origin+"/website/watch/tv-1","ids":{"tvg":"fixture"},"epg":[{"title":"Fixture Show","start":"2026-10-26T19:00:00Z","end":"2026-10-26T20:00:00Z"}]}]}
        if "/source/" in path: return {"sources":[{"url":"https://example.org/film","kind":"website","name":"External website"},{"url":origin+"/website/watch/movie-1","name":"Playable candidate","languages":["en"],"quality":"1080p"},{"url":origin+"/website/watch/client-flow","name":"Assisted server","languages":["de"],"quality":"720p"},{"url":origin+"/invalid","name":"HTML page"}]}
        if path.endswith("/resolve"):
            if "client-flow" in query.get("url",[""])[0] or "loop" in query.get("url",[""])[0]:
                return {"clientFetch":{"id":"loop" if "loop" in query.get("url",[""])[0] else "fixture-exchange","url":origin+"/public-host-page","headers":{"Authorization":"must-not-be-forwarded","Cookie":"must-not-be-forwarded","Accept":"text/html"}}}
            return {"url":origin+"/test-stream.mp4","format":"mp4","headers":{"Referer":origin,"Authorization":"must-not-be-forwarded"},"subtitles":[{"url":origin+"/en.vtt","language":"en"},{"url":origin+"/de.vtt","language":"de"}]}
        return None
    def do_POST(self):
        path = urlparse(self.path).path
        data = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b'{}')
        if path == "/website/vod/client-fetch":
            if data.get("id")=="loop": self.send({"clientFetch":{"id":"loop","url":"http://127.0.0.1:8789/public-host-page"}})
            elif data.get("id")=="fixture-exchange" and data.get("status")==200 and "fixture public host" in data.get("body",""):
                self.send({"url":"http://127.0.0.1:8789/test-stream.mp4","format":"mp4","headers":{"Referer":"http://127.0.0.1:8789"},"subtitles":[{"url":"http://127.0.0.1:8789/en.vtt","language":"en"}]})
            else: self.send({"error":"invalid_fetch"})
        elif path.endswith("/Users/AuthenticateByName"):
            if data.get("Username") == "fixture" and data.get("Pw") == "fixture-password":
                self.send({"User":{"Id":"user-1"},"AccessToken":"fixture-token"})
            else: self.send({}, 401)
        elif path.endswith("/PlaybackInfo"):
            self.send({"MediaSources":[{"Id":"movie-1","Container":"mp4","SupportsDirectPlay":True}]})
        else: self.send({}, 405)
    def do_GET(self):
        parsed = urlparse(self.path); path = parsed.path; query = parse_qs(parsed.query)
        if path == "/public-host-page":
            self.send(b"fixture public host" if not self.headers.get("Authorization") and not self.headers.get("Cookie") else b"credentials leaked",200 if not self.headers.get("Authorization") and not self.headers.get("Cookie") else 403,"text/html"); return
        if path == "/oversized-declared":
            self.send_response(200); self.send_header("Content-Length","999999999"); self.end_headers(); self.wfile.write(b"x"*4096); self.wfile.flush(); self.rfile.read(1); return
        if path == "/oversized-stream":
            self.send_response(200); self.send_header("Content-Type","application/json"); self.end_headers()
            try: self.wfile.write(b"x"*16384)
            except (BrokenPipeError,ConnectionResetError): pass
            return
        if path == "/poster.jpg": self.send(Path("Resources/Assets.xcassets/preview-film1.imageset/art.png").read_bytes(),mime="image/png"); return
        if path.endswith(".mp4") and path in ["/test-stream.mp4","/file.mp4"]:
            data=Path("scripts/fixtures/test-video.mp4").read_bytes()
            byte_range=self.headers.get("Range","")
            if byte_range.startswith("bytes="):
                start,end=byte_range[6:].split("-",1); start=int(start or 0); end=min(int(end) if end else len(data)-1,len(data)-1)
                body=data[start:end+1]; self.send_response(206); self.send_header("Content-Type","video/mp4"); self.send_header("Content-Length",str(len(body))); self.send_header("Content-Range",f"bytes {start}-{end}/{len(data)}"); self.send_header("Accept-Ranges","bytes"); self.end_headers(); self.wfile.write(body)
            else: self.send(data,mime="video/mp4")
            return
        if path in ["/en.vtt","/de.vtt"]: self.send(b"WEBVTT\n\n00:00:00.000 --> 00:00:24.000\nFixture caption\n",mime="text/vtt"); return
        if path.startswith("/website/"):
            result = self.website(unquote(path), query)
            self.send(result,200 if result is not None else 404); return
        if path == "/redirect":
            self.send_response(302); self.send_header("Location", "http://localhost:8789/target"); self.end_headers(); return
        if path == "/invalid": self.send(b"<html>Login</html>", mime="text/html"); return
        if path.endswith("/Users/user-1/Items"):
            index = int(query.get("StartIndex", ["0"])[0])
            item = {"Id":"movie-1","Name":"Fixture Movie","Type":"Movie","RunTimeTicks":240000000,"ProductionYear":2026,"Overview":"A deterministic test title","ImageTags":{"Primary":"image"}}
            # Two deliberately small pages exercise pagination independent of requested page size.
            episode = {"Id":"episode-1","Name":"A New Day","Type":"Episode","SeriesId":"series-1","SeriesName":"Fixture Series","ParentIndexNumber":1,"IndexNumber":1}
            self.send({"Items":[item] if index == 0 else [episode] if index == 1 else [],"TotalRecordCount":2})
        elif path.endswith("/library/all"):
            kind = query.get("type", ["1"])[0]
            row = {"ratingKey":"plex-"+kind,"title":"Plex Fixture "+kind,"type":{"1":"movie","2":"show","4":"episode"}[kind],"duration":24000,"year":2026}
            self.send({"MediaContainer":{"Metadata":[row],"totalSize":1}})
        elif "/library/metadata/" in path:
            self.send({"MediaContainer":{"Metadata":[{"Media":[{"container":"mp4","Part":[{"key":"/library/parts/file.mp4"}]}]}]}})
        elif path.endswith("/player_api.php"):
            action = query.get("action", [""])[0]
            if not action: self.send({"user_info":{"auth":1}})
            elif action == "get_live_streams": self.send([{"stream_id":1,"name":"Fixture TV","epg_channel_id":"fixture-tv","category_id":"news"}])
            elif action == "get_vod_streams": self.send([{"stream_id":2,"name":"Fixture Film","container_extension":"mp4"}])
            elif action == "get_series": self.send([{"series_id":3,"name":"Fixture Series"}])
            elif action == "get_series_info": self.send({"episodes":{"1":[{"id":"4","title":"Pilot","episode_num":1,"container_extension":"mp4"}]}})
            else: self.send({},400)
        elif path.endswith("/list.m3u"):
            self.send(b'#EXTM3U x-tvg-url="guide.xml"\n#EXTINF:-1 tvg-id="fixture-tv" group-title="News",Fixture TV\nhttp://127.0.0.1:8789/live.m3u8\n', mime="audio/x-mpegurl")
        elif path.endswith("/guide.xml") or path.endswith("/xmltv.php"):
            self.send(b'<tv><programme start="20261026200000 +0100" stop="20261026210000 +0100" channel="fixture-tv"><title>Fixture Program</title></programme></tv>', mime="application/xml")
        else: self.send({},404)
    def do_PROPFIND(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        path = urlparse(self.path).path
        body = b'<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response><d:response><d:href>/dav/film.mp4</d:href><d:propstat><d:prop><d:displayname>NAS Film</d:displayname></d:prop></d:propstat></d:response></d:multistatus>'
        self.send(body,207,"application/xml")
ThreadingHTTPServer(("127.0.0.1",8789),Handler).serve_forever()
