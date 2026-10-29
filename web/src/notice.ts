// A hint for viewers whose servers open on hosting sites with ads. It appears
// on every visit once the welcome dialog closes, never blocks the app, and
// returns ten minutes after Not Now.
const REPEAT_MS = 10 * 60 * 1000;

async function isBrave() {
  try { return await (navigator as any).brave?.isBrave?.() === true; } catch { return false; }
}

async function start() {
  const notice = document.querySelector<HTMLElement>('#ad-notice');
  if (!notice || await isBrave()) return;
  const welcome = document.querySelector<HTMLDialogElement>('#account');
  const show = () => {
    // Wait while a dialog such as the welcome screen is open.
    if (welcome?.open) welcome.addEventListener('close', show, { once: true });
    else notice.hidden = false;
  };
  // Give the app a moment to open its welcome dialog first.
  setTimeout(show, 1200);
  notice.querySelector('[data-ad-notice-close]')?.addEventListener('click', () => {
    notice.hidden = true;
    setTimeout(show, REPEAT_MS);
  });
}
void start();
