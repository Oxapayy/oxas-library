const screenTabs=[...document.querySelectorAll('[data-view]')];
let selectedScreen='library';
function setScreen(tab){selectedScreen=tab.dataset.view;for(const item of screenTabs){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1}for(const image of document.querySelectorAll('[data-screen]')){image.hidden=image.dataset.screen!==selectedScreen}document.querySelector('#screen-panel').setAttribute('aria-labelledby',tab.id)}
function keyboardTabs(tabs,select){for(const tab of tabs){tab.addEventListener('click',()=>select(tab));tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();let n=tabs.indexOf(tab);n=event.key==='Home'?0:event.key==='End'?tabs.length-1:(n+(event.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;select(tabs[n]);tabs[n].focus()})}}
keyboardTabs(screenTabs,setScreen);
const platforms=[...document.querySelectorAll('[data-platform]')];
function setPlatform(tab){for(const item of platforms){item.setAttribute('aria-selected',String(item===tab));item.tabIndex=item===tab?0:-1}const ios=tab.dataset.platform==='ios';const name={ios:'iOS',macos:'macOS',windows:'Windows'}[tab.dataset.platform];document.querySelector('#platform-panel').setAttribute('aria-labelledby',tab.id);document.querySelector('#platform-title').textContent=`Oxa’s Library for ${name}`;document.querySelector('#platform-description').textContent=ios?'Version 1.2.0 · iOS 18 or later · Unsigned IPA':'The desktop app is planned. There is no release date yet.';document.querySelector('#platform-download').hidden=!ios;document.querySelector('#platform-status').hidden=ios}
keyboardTabs(platforms,setPlatform);
const viewer=document.querySelector('#image-viewer'),viewerImage=document.querySelector('#viewer-image');
let zoomTrigger;
const descriptions={library:'Library with Continue Watching and film collection',series:'Series details and resume position',episodes:'Individual episode and season downloads',search:'Film, series and episode search',iptv:'Live TV channels and program guide',settings:'Source, account and playback settings'};
function showImage(name,trigger){zoomTrigger=trigger;viewerImage.src=`assets/screens/${name}.jpg`;viewerImage.alt=descriptions[name];viewer.showModal();document.querySelector('.viewer-close').focus()}
for(const button of document.querySelectorAll('[data-zoom]'))button.addEventListener('click',()=>showImage(button.dataset.zoom,button));
const currentZoom=document.querySelector('[data-zoom-current]');currentZoom.addEventListener('click',()=>showImage(selectedScreen,currentZoom));
function closeViewer(){viewer.close();zoomTrigger?.focus()}
document.querySelector('.viewer-close').addEventListener('click',closeViewer);
viewer.addEventListener('click',event=>{if(event.target===viewer)closeViewer()});
viewer.addEventListener('cancel',()=>{requestAnimationFrame(()=>zoomTrigger?.focus())});
if('IntersectionObserver'in window&&!matchMedia('(prefers-reduced-motion: reduce)').matches){const observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){entry.target.classList.remove('reveal');void entry.target.offsetWidth;entry.target.classList.add('reveal','entering');observer.unobserve(entry.target)}},{threshold:.12});document.querySelectorAll('section:not(.hero) .reveal').forEach(element=>observer.observe(element))}
