document.documentElement.classList.add('js');
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// The visitor's own device gets the first download card and the hero button.
function detectPlatform() {
  const ua = navigator.userAgent, platform = navigator.userAgentData?.platform || navigator.platform || '';
  if (/iPhone|iPad|iPod/.test(ua) || (platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Mac/.test(platform) || /Mac OS X/.test(ua)) return 'macos';
  if (/Win/.test(platform) || /Windows/.test(ua)) return 'windows';
  return 'web';
}
const heroLabels = { macos: 'Download for Mac', ios: 'Download for iPhone', windows: 'Download for Windows', web: 'Open in browser' };
const card = document.querySelector(`.platform[data-platform="${detectPlatform()}"]`);
const hero = document.querySelector('#hero-download');
if (card) {
  card.classList.add('current');
  card.querySelector('.platform-tag').hidden = false;
  card.parentElement.prepend(card);
}
if (card && hero) {
  hero.href = card.querySelector('.button').href;
  hero.textContent = heroLabels[card.dataset.platform];
  // The web card's browser link already sits beside the hero button.
  if (card.dataset.platform === 'web') hero.nextElementSibling.hidden = true;
}

// Cookie notice. Oxa sets no optional cookies, so both choices only record the answer.
const consent = document.querySelector('#consent'), consentKey = 'oxa-cookie-choice';
function savedChoice() { try { return localStorage.getItem(consentKey); } catch { return null; } }
if (consent) {
  consent.hidden = !!savedChoice();
  for (const button of consent.querySelectorAll('[data-consent]')) button.addEventListener('click', () => {
    try { localStorage.setItem(consentKey, button.dataset.consent); } catch {}
    consent.hidden = true;
  });
  for (const button of document.querySelectorAll('[data-consent-open]')) button.addEventListener('click', () => {
    consent.hidden = false;
    consent.querySelector(`[data-consent="${savedChoice() || 'declined'}"]`).focus();
  });
}

// A brief arrival for each block, once.
if ('IntersectionObserver' in window && !reduceMotion.matches) {
  for (const group of document.querySelectorAll('.hero, .page-hero, .tiles, .platforms, .guide-grid, section')) {
    group.querySelectorAll(':scope > .reveal, :scope > .section-head > .reveal').forEach((element, index) => element.style.setProperty('--delay', Math.min(index, 5) * 70 + 'ms'));
  }
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add('in'); observer.unobserve(entry.target); }
  }, { threshold: .1 });
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
