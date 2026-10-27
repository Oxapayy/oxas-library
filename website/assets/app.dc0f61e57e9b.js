const screenTabs=[...document.querySelectorAll('[data-view]')];
let selectedScreen='library';
function setScreen(tab){selectedScreen=tab.dataset.view;for(const item of screenTabs){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1}for(const image of document.querySelectorAll('[data-screen]')){image.hidden=image.dataset.screen!==selectedScreen}document.querySelector('#screen-panel').setAttribute('aria-labelledby',tab.id)}
function keyboardTabs(tabs,select){for(const tab of tabs){tab.addEventListener('click',()=>select(tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let n=tabs.indexOf(tab);n=event.key==='Home'?0:event.key==='End'?tabs.length-1:(n+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;select(tabs[n]);tabs[n].focus()})}}
keyboardTabs(screenTabs,setScreen);
const platforms=[...document.querySelectorAll('[data-platform]')];
const iosInstall=document.querySelector('#install-guide').innerHTML;
function setPlatform(tab){
  for(const item of platforms){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1}
  const platform=tab.dataset.platform;
  const data={
    ios:{name:'iOS',description:'Version 1.3.1 · iOS 18 or later · Unsigned IPA',asset:'v1.3.1/Oxas-Library-v1.3.1-iOS-unsigned.ipa',label:'Download for iOS',note:'Sign and install with your preferred sideloading tool.'},
    macos:{name:'macOS',description:'Version 1.0.1 · macOS 14 or later',asset:'desktop-v1.0.1/Oxas-Library-Desktop-1.0.1-macOS-arm64.dmg',label:'Download for Apple Silicon',note:'Choose Apple Silicon for M-series Macs, or Intel for an Intel Mac. Ad hoc signed; not notarized.'},
    windows:{name:'Windows',description:'Version 1.0.1 · Windows 10 / 11 · x64 + ARM64',asset:'desktop-v1.0.1/Oxa-Library-Setup-1.0.1.exe',label:'Download for Windows',note:'One installer automatically selects x64 or ARM64. Publisher signature not included.'}
  }[platform];
  document.querySelector('#platform-panel').setAttribute('aria-labelledby',tab.id);
  document.querySelector('#platform-title').textContent=`Oxa’s Library for ${data.name}`;
  document.querySelector('#platform-description').textContent=data.description;
  const download=document.querySelector('#platform-download');
  download.href='https://github.com/Oxapayy/oxas-library/releases/download/'+data.asset;
  download.textContent=data.label+' ↓';
  document.querySelector('#platform-intel').hidden=platform!=='macos';
  document.querySelector('#platform-note').textContent=data.note;
  document.querySelector('#install-guide').innerHTML=platform==='ios'?iosInstall:platform==='macos'?'<h3>Make yourself at home.</h3><ol><li>Choose the package for your Mac.</li><li>Open the DMG and drag Oxa’s Library to Applications.</li><li>Open the app and connect a source, or sign in to sync your library.</li></ol><p class="note">This release is not notarized. macOS may require approval in Privacy &amp; Security. Verify the package checksum on GitHub.</p><a class="text-link" href="https://github.com/Oxapayy/oxas-library/releases/tag/desktop-v1.0.1">Release notes &amp; checksums ↗</a>':'<h3>One installer. Your PC.</h3><ol><li>Download and run the Windows installer.</li><li>The installer chooses the right architecture automatically.</li><li>Connect a source, or sign in to sync your library.</li></ol><p class="note">This release has no publisher certificate. Windows may display a security prompt. Verify the package checksum on GitHub.</p><a class="text-link" href="https://github.com/Oxapayy/oxas-library/releases/tag/desktop-v1.0.1">Release notes &amp; checksums ↗</a>';
}
keyboardTabs(platforms,setPlatform);
const viewer=document.querySelector('#image-viewer'),viewerImage=document.querySelector('#viewer-image');
let zoomTrigger;
const descriptions={library:'Library with Continue Watching and film collection',series:'Series details and resume position',episodes:'Individual episode and season downloads',search:'Film and series search',iptv:'Live TV channels and program guide',settings:'Source, account and playback settings'};
function showImage(name,trigger){zoomTrigger=trigger;viewerImage.src=`assets/screens/${name}.jpg`;viewerImage.alt=descriptions[name]||'Oxa’s Library on macOS';viewer.showModal();document.querySelector('.viewer-close').focus()}
for(const button of document.querySelectorAll('[data-zoom]'))button.addEventListener('click',()=>showImage(button.dataset.zoom,button));
const currentZoom=document.querySelector('[data-zoom-current]');currentZoom.addEventListener('click',()=>showImage({library:'mac-library',series:'mac-detail',iptv:'mac-iptv'}[selectedScreen],currentZoom));
function closeViewer(){viewer.close();zoomTrigger?.focus()}
document.querySelector('.viewer-close').addEventListener('click',closeViewer);
viewer.addEventListener('click',event=>{if(event.target===viewer)closeViewer()});
viewer.addEventListener('cancel',()=>{requestAnimationFrame(()=>zoomTrigger?.focus())});
if('IntersectionObserver'in window&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.remove('reveal');void entry.target.offsetWidth;entry.target.classList.add('reveal','entering');observer.unobserve(entry.target)}},{threshold:.12});document.querySelectorAll('section:not(.hero) .reveal').forEach(element=>observer.observe(element))}

for (const button of document.querySelectorAll('[data-copy-address]')) button.addEventListener('click', async () => { try { await navigator.clipboard.writeText(button.dataset.copyAddress); document.querySelector('#copy-status').textContent = 'Address copied.'; } catch { document.querySelector('#copy-status').textContent = 'Select and copy the address above.'; } });

// Section navigation keeps the public URL clean and preserves keyboard focus.
document.addEventListener('click', event => {
  const trigger = event.target.closest('[data-scroll]');
  if (!trigger) return;
  const target = document.getElementById(trigger.dataset.scroll);
  if (!target) return;
  if (target.tagName === 'DETAILS') target.open = true;
  target.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start'});
  const focus = target.querySelector('h1,h2,summary') || target;
  if (!focus.hasAttribute('tabindex')) focus.setAttribute('tabindex','-1');
  focus.focus({preventScroll:true});
});
function cleanSectionURL() {
  if (!location.hash) return;
  let id = ''; try { id = decodeURIComponent(location.hash.slice(1)); } catch {}
  history.replaceState(null,'',location.pathname + location.search);
  if (id) requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
}
window.addEventListener('hashchange', cleanSectionURL);
cleanSectionURL();
