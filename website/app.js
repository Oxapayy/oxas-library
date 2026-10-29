document.documentElement.classList.add('js');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const releases = 'https://github.com/Oxapayy/oxas-library/releases/';

// Each device gets its own file, facts and install note.
const platforms = {
  ios: {
    title: 'For your iPhone', facts: 'Version 1.3.1 · iOS 18 or later · Unsigned IPA',
    description: 'Sign and install the IPA with ESign or AltStore Classic. Keep the same signing identity when you update so your library stays in place. Oxa is not in AltStore PAL.',
    extra: '<a class="text-link" href="https://faq.altstore.io/altstore-classic">AltStore Classic setup</a> · <a class="text-link" href="' + releases + 'tag/v1.3.1">Release notes and checksum</a>',
    primary: ['Download for iPhone', releases + 'download/v1.3.1/Oxas-Library-v1.3.1-iOS-unsigned.ipa'],
    secondary: ['Release notes', releases + 'tag/v1.3.1'],
    image: ['assets/screens/series.jpg', 'Oxa’s Library on iPhone: American Dad! with its artwork', 589, 1280, true],
    cta: ['Oxa’s Library 1.3.1 for iPhone.', 'Download'],
  },
  macos: {
    title: 'For your Mac', facts: 'Version 1.0.1 · macOS 14 or later',
    description: 'Open the disk image and drag Oxa’s Library to Applications. The app is ad hoc signed and not notarized, so macOS may ask you to allow it in Privacy & Security.',
    extra: '<a class="text-link" href="' + releases + 'tag/desktop-v1.0.1">Release notes and checksums</a>',
    primary: ['Download for Apple Silicon', releases + 'download/desktop-v1.0.1/Oxas-Library-Desktop-1.0.1-macOS-arm64.dmg'],
    secondary: ['Download for Intel', releases + 'download/desktop-v1.0.1/Oxas-Library-Desktop-1.0.1-macOS-x64.dmg'],
    image: ['assets/screens/mac-library.jpg', 'Oxa’s Library on a Mac', 1300, 880, false],
    cta: ['Oxa’s Library 1.0.1 for your Mac.', 'Download'],
  },
  windows: {
    title: 'For your PC', facts: 'Version 1.0.1 · Windows 10 or 11 · x64 and ARM64',
    description: 'One installer picks the right version for your PC. It has no publisher certificate yet, so Windows may show a security prompt before it runs.',
    extra: '<a class="text-link" href="' + releases + 'tag/desktop-v1.0.1">Release notes and checksums</a>',
    primary: ['Download for Windows', releases + 'download/desktop-v1.0.1/Oxa-Library-Setup-1.0.1.exe'],
    secondary: ['Release notes', releases + 'tag/desktop-v1.0.1'],
    image: ['assets/screens/mac-library.jpg', 'The Oxa’s Library desktop app', 1300, 880, false],
    cta: ['Oxa’s Library 1.0.1 for Windows.', 'Download'],
  },
  web: {
    title: 'In your browser', facts: 'Chrome, Safari, Edge and Firefox · Nothing to install',
    description: 'Open the web app and your library is there, with the same watchlist and progress when you sign in. Many hosted servers open on their own site; downloads stay in the apps.',
    extra: '',
    primary: ['Open in your browser', '/web'],
    secondary: ['All downloads', releases],
    image: ['assets/screens/mac-library.jpg', 'Oxa’s Library in a browser window', 1300, 880, false],
    cta: ['Oxa’s Library in your browser.', 'Open'],
  },
};
function detectPlatform() {
  const ua = navigator.userAgent, platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Mac/.test(platform) || /Mac OS X/.test(ua)) return 'macos';
  if (/Win/.test(platform) || /Windows/.test(ua)) return 'windows';
  return 'web';
}
const tabs = [...document.querySelectorAll('[data-platform]')];
function setPlatform(tab) {
  const data = platforms[tab.dataset.platform];
  for (const item of tabs) { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; }
  document.querySelector('#platform-panel').setAttribute('aria-labelledby', tab.id);
  document.querySelector('#platform-title').textContent = data.title;
  document.querySelector('#platform-facts').textContent = data.facts;
  document.querySelector('#platform-description').textContent = data.description;
  const extra = document.querySelector('#platform-extra');
  extra.innerHTML = data.extra; extra.hidden = !data.extra;
  for (const [id, [label, href]] of [['#action-primary', data.primary], ['#action-secondary', data.secondary]]) {
    const link = document.querySelector(id); link.textContent = label; link.href = href;
  }
  const image = document.querySelector('#plate-image'), [src, alt, width, height, phone] = data.image;
  if (!image.src.endsWith(src)) { image.src = src; image.width = width; image.height = height; }
  image.alt = alt; image.classList.toggle('phone', phone);
}
for (const tab of tabs) {
  tab.addEventListener('click', () => setPlatform(tab));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    let n = tabs.indexOf(tab);
    n = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (n + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    setPlatform(tabs[n]); tabs[n].focus();
  });
}

// The visitor’s own device decides the download section and the closing word.
const detected = detectPlatform(), own = platforms[detected];
setPlatform(tabs.find(tab => tab.dataset.platform === detected));
const cta = document.querySelector('#cta');
cta.href = own.primary[1];
document.querySelector('#cta-sentence').textContent = own.cta[0];
document.querySelector('#cta-word').textContent = own.cta[1];
cta.setAttribute('aria-label', own.primary[0]);

// Feature names explain themselves in the empty columns beside them.
const detail = document.querySelector('.feature-detail');
for (const item of document.querySelectorAll('[data-detail]')) {
  const show = () => {
    document.querySelector('[data-detail][aria-current="true"]')?.removeAttribute('aria-current');
    item.setAttribute('aria-current', 'true'); detail.textContent = item.dataset.detail;
  };
  item.addEventListener('mouseenter', show); item.addEventListener('focus', show); item.addEventListener('click', show);
}

// Entrances: heading, then text, then picture, once per section.
if ('IntersectionObserver' in window && !reduceMotion.matches) {
  for (const section of document.querySelectorAll('section, .cta')) {
    section.querySelectorAll('.reveal').forEach((element, index) => element.style.setProperty('--delay', Math.min(index, 5) * 80 + 'ms'));
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
  }, { threshold: .12, rootMargin: '0px 0px -6% 0px' });
  document.querySelectorAll('.reveal').forEach(element => observer.observe(element));
} else document.querySelectorAll('.reveal').forEach(element => element.classList.add('in'));

for (const button of document.querySelectorAll('[data-copy-address]')) button.addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(button.dataset.copyAddress); document.querySelector('#copy-status').textContent = 'Address copied.'; }
  catch { document.querySelector('#copy-status').textContent = 'Select and copy the address above.'; }
});

// Section navigation keeps the public URL clean and preserves keyboard focus.
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-scroll]');
  if (!trigger) return;
  const target = document.getElementById(trigger.dataset.scroll);
  if (!target) return;
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({ behavior: reduceMotion.matches ? 'instant' : 'smooth', block: 'start' });
  const focus = target.querySelector('h1,h2,summary') || target;
  if (!focus.hasAttribute('tabindex')) focus.setAttribute('tabindex', '-1');
  focus.focus({ preventScroll: true });
});
function cleanSectionURL() {
  if (!location.hash) return;
  let id = ''; try { id = decodeURIComponent(location.hash.slice(1)); } catch {}
  history.replaceState(null, '', location.pathname + location.search);
  if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
}
window.addEventListener('hashchange', cleanSectionURL);
cleanSectionURL();
