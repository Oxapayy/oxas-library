# Website redesign — real library, October 2026

Brief: English site using the six supplied real iPhone screenshots, with explicitly requested iOS 26 glass. Preserve public IPA, platform tabs and installation information. No app changes.

Inventory: Oxa play mark, true black app, translucent bottom navigation, sky-blue progress, The Mentalist resume at 0:47, American Dad resume at 12:32, individual episode download, season download, live program guide, source settings, optional account.

Argument: hero proves the actual library; screen selection lets visitors inspect Library/Series/Live TV. A gallery proves search, TV guide and series organization. Episode screen proves individual and season saving. Settings proves source control and optional sync. Download section supplies the real IPA plus honest desktop Coming soon and complete installation instructions. FAQ answers source reachability and limitations.

Direction: The split stage, seed 65316681. Real product view stays on the right in the hero; visitors crossfade between screenshots using glass controls. Later sections break the split for a gallery and a broad download field. No redraws. Generic architecture imagery and invented HTML app fragments on the dealt sheet contradict the supplied real screenshots and are replaced by those screenshots. User-requested glass overrides the skill’s no-glass, thin-edge and floating-surface rules only for functional materials and image framing. No unrelated stock photos, invented reviews or statistics.

Idea: On this page, Oxa’s real saved library becomes the held-open product view beside a concise invitation. Live thing: switch actual app screens, then enlarge any screenshot in an accessible modal. No simulated media playback. Copy deck: Your library. Your way. / Look inside / Take an episode / Make it yours / Downloads / A few answers.

Images: six user-supplied iPhone captures, used in product context with no separate poster extraction. The film/series artwork and titles shown inside remain the property of their owners. No found photographs or clips. Screenshot credits in footer and NOTICE. Original old preview illustrations are removed from this page.

ROUND 1
Seen in one second: The real personal library beside a large invitation to download the iPhone app.
Idea (one sentence): The owner’s saved library becomes a held-open product view.
Live thing: Screenshot selection and full-size inspection; no pretend playback.
Layout words by section: hero=held product / inside=three screen gallery / offline=material image and copy / personal=settings specimen / downloads=glass installer / FAQ=reading list / footer=quiet close
Scores: design 7.6 · usability 7.8 · creativity 7.0 · content 8.2 → overall 7.6
Caps applied: Unresolved inspector layout failures cap round 1 at 6.0. Requested glass materials are an explicit user exception rather than an accidental violation.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. The desktop screen tabs fall below the first fold (desktop-fold): reduce the hero screenshot to 300px wide so the full screenshot and switcher fit.
2. The ambient product color has a faint rectangular edge (desktop-fold): feather the image alpha while preserving the actual screenshot.
3. Cropped episode/settings images extend beyond their layout boxes (tablet-page-01): constrain the images to their actual visible viewport instead of relying on ancestor overflow; retain the full-size modal.

ROUND 2
Seen in one second: Oxa’s real iPhone library, large white type, and a direct iOS download.
Idea (one sentence): The owner’s saved library becomes the held-open product view.
Live thing: Switch Library/Series/Live TV and enlarge any screenshot, with keyboard controls and Escape dismissal.
Layout words by section: hero=held product / inside=staggered screen gallery / offline=tilted image and copy / personal=settings specimen / downloads=glass installer / FAQ=reading list / footer=quiet close
Scores: design 7.8 · usability 8.0 · creativity 7.0 · content 8.5 → overall 7.8
Caps applied: Creativity capped at 7 because the product-tour concept also applies to competing players. Requested glass, thin material edges and surface shadows are explicit user exceptions. No other unresolved FAILs.
Top three problems (most visible first), each with the screenshot it shows in and the fix:
1. Small app labels inside the overview images need enlargement (desktop-page-01, mobile-page-01); full-size screenshot dialogs are provided for every image.
2. The supplied episode capture starts midway through its synopsis (mobile-page-01); retain the honest capture rather than fabricate missing app content. A future dedicated capture could start at the episode heading.
3. There is no real app video (all sheets); no honest clip was supplied, so the tour uses actual screenshots and interactive selection rather than unrelated footage.

Validation: Before 0 FAIL / 2 WARN; after 0 FAIL / 1 WARN at 1440, 768 and 390 using --allow glass,shadow,outlined-box,pill-nav for the requested material style. The remaining no-footage warning is defended above. All eight after screenshots opened. No pinned scroll scenes. JavaScript syntax and local asset paths passed. Selector, arrow-key selection, modal focus/Escape dismissal and platform Coming soon behavior verified in the browser. Reduced motion/transparency and high-contrast alternatives are in CSS. No new backend, tracking or forms.

Production: https://oxas-library.netlify.app, deploy 6adfe66fcd08af38b0f92cac. Final production gate 0 FAIL / 1 defended no-footage WARN, all eight screenshot sheets opened. The only lint exclusion is the real-image alpha feather: radial-gradient is used as a mask, not a painted gradient fill. Glass warnings are intentional per the explicit brief. Live screenshot selection/enlargement/close and Windows Coming soon verified. Native app and existing IPA release unchanged.
