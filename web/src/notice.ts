// A one-time hint for viewers whose servers open on hosting sites with ads.
// It waits for the welcome dialog, never blocks the app and stays dismissed.
const KEY = 'oxa-ad-notice-dismissed';

function dismissed() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}
async function isBrave() {
  try { return await (navigator as any).brave?.isBrave?.() === true; } catch { return false; }
}

async function start() {
  const notice = document.querySelector<HTMLElement>('#ad-notice');
  if (!notice || dismissed() || await isBrave()) return;
  const show = () => { notice.hidden = false; };
  const welcome = document.querySelector<HTMLDialogElement>('#account');
  // Give the app a moment to open its welcome dialog, then show after it closes.
  setTimeout(() => {
    if (welcome?.open) welcome.addEventListener('close', show, { once: true });
    else show();
  }, 1200);
  notice.querySelector('[data-ad-notice-close]')?.addEventListener('click', () => {
    notice.hidden = true;
    try { localStorage.setItem(KEY, '1'); } catch {}
  });
}
void start();
