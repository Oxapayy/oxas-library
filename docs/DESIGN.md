# Design review — Oxa’s Library

## Direction

`design-taste-frontend`: True-black flat, seed **440225659**, no redraw. Applied to a native iPhone interface rather than a web page. `apple-design`: immediate press feedback, interruptible critically damped press response, familiar system sheets/navigation/player, system fonts, Dynamic Type, system accessibility and Reduce Motion.

The product's own resume position becomes the leading shelf: episode identity, a play action, real watch progress and elapsed/remaining time. This is the signature interaction; no invented activity charts or decorative metrics. Black canvas, #111 surfaces, white primary action, neutral navigation, cool blue used only for real progress. Onboarding's job is to connect the first source; the library's job is to resume or choose a title.

Native iOS tab-bar and sheet materials retain their system behavior. This is an explicit platform adaptation of the web-only no-glass rule, consistent with the user's Apple-interface request. No CSS/browser inspector claims are made for this SwiftUI app. Native simulator screenshots and accessibility-driven UI tests are the review evidence.

## Screen questions

| Screen | First question and action |
| --- | --- |
| First launch | Where is my media? Add a source. |
| Library | What was I watching? Resume that title. |
| Details | Which film/episode do I want? Play/resume/download. |
| Search | Where is that title? Open a matching catalog result. |
| IPTV | What can I watch live? Pick channel or program guide. |
| Downloads | What is ready offline? Play, retry or delete. |
| Settings | Which sources and playback preferences do I use? Edit/refresh/add. |

## Look-and-fix record

First review found preview cover captions colliding with multiline titles, a single resume card leaving unused width, and fixed heading sizes not adapting to Dynamic Type. Corrected drawing text bounds, made a single resume card fill the available shelf width, and scaled headings with the system text-size preference.

App review uses the skill's seven questions: first action prominence; shared edges; restrained color; consistent numbers; honest zero/missing data; marks matching their facts; phone navigation. Final screenshots and remaining limitations are recorded in VERIFICATION.md. No numerical juror score is fabricated.

## Preview content and credits

Preview titles: The Quiet Coast (series), Where the land ends (S1 E3), After the Rain, A Place Apart, Northern Light. Fictional illustrative content, clearly labeled; playback disabled. Four original code-drawn covers, no photographs. The sample progress is 18:14 of 47:00, leaving 28:46; both the text and bar use the same WatchProgress value. Preview collection count is computed from the four movie/series entries, excluding the episode from the poster grid.

The app uses original icon artwork and system SF Symbols. No found photography or footage. TMDB's approved attribution logo is credited in Settings and README; it is a functional third-party brand attribution, not decoration.

## Version 1.1 native review

Reviewed final simulator screenshots in `docs/screenshots/account-1.1.png`, `sources-1.1.png` and `playback-1.1.png`. Continued the existing true-black direction and native system typography/materials. Optional email account uses the same inset Form geometry as Settings; source rows expose provider/language/quality in a consistent two-line hierarchy. Source selection stays a dismissible native sheet; native player remains full-screen. No web CSS measurements or fabricated design scores are claimed for SwiftUI.

The first new-screen pass exposed white toggle thumbs on white tracks; switches now use the restrained sky-blue accent. The source error repeated the same instruction twice; its secondary line now reassures that watch progress is retained. The final account screenshot contains only email/password actions, and the full account form fits the target phone without clipping. Final playback screenshot shows the generated test video plus visible text captions; captions have an accessibility identifier. Reduced Motion and larger Dynamic Type behavior of the new account/source screens need additional real-device accessibility testing.

## Premium pass

Decisions
- One ground (#0a0a0a) with raised surfaces for cards; glass only on chrome (category bar, hero action pill, season and group chips, tab bar). iOS 26 uses the system glass behind `#if compiler(>=6.2)` and `#available(iOS 26, *)`, earlier systems a thin material, and Reduce Transparency gets an opaque fill.
- Edge-to-edge hero under the status bar (desktop `clamp(420px, 62vh, 760px)`, iOS at least 480 pt) with a top scrim for the floating bar and a bottom scrim that ends in the page ground. Candidates in order: Continue Watching, New Episode, two Picked for You, otherwise the first catalog title. It rotates every 9 s, and the rotation stops with Reduce Motion, VoiceOver, Switch Control, a hovered or focused hero (desktop), or once a slide is chosen by hand (iOS).
- Shelves snap to the leading edge with the next card peeking; desktop adds 48 px arrows and arrow-key focus. Posters lift with transform and a shadow layer whose opacity animates, using `cubic-bezier(.2,.8,.2,1)` over 160–240 ms.
- Missing artwork gets one of eight dark tones, chosen from a stable hash of the title's identity, with the title set in serif. Loading shows that tone (desktop also a shimmer), and real art fades in over 220 ms.
- Derived shelves (Picks for You, Because You Watched, Watch Again, More Like This, Ready Offline, On Now) are computed on the device from titles, descriptions, progress, the watchlist, downloads and the guide. They use TF-IDF with an inverted index over at most 5,000 candidates (threshold 0.1, franchise bonus 0.35) and are never stored, synced or logged. Each shelf only appears above its minimum (3, 5, 3 seeds and 8 matches, 4, 1, 1). Because You Watched seeds only from titles actually played.

Deviations
- iOS detail keeps portrait artwork as the backdrop, because most sources deliver posters only.
- The iOS hero swipe is a simultaneous drag gesture, not a paged TabView, so `hero-play` stays unique for UI tests.
- Only catalog rows carry `media-card-*`. Derived shelves use `<shelf>-card-*`, and More Like This uses `more-like-*`.
- Two desktop UI test selectors were scoped to `.channel` and `#sheet`, because On Now repeats channel names.

Limits
- Similarity is lexical and English-leaning (plural folding only), so titles with no description and no shared words get no recommendations.
- iOS simulator unit and UI tests could not run on this machine (the test runner hangs before connecting). The shelf logic was verified with the same test file in a macOS package, and the app was checked by launching it with the large fixture.
- Desktop `content-visibility: auto` leaves off-screen shelves blank in full-page screenshots.
