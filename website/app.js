const fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot',"'":'&#39;'}[c]));
const menu=document.querySelector('[data-menu]'),nav=document.querySelector('[data-nav]');
if(menu&&nav){menu.addEventListener('click',()=>{const open=nav.classList.toggle('open');menu.setAttribute('aria-expanded',String(open))});nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')))}
function formatDate(v){if(!v)return'TBA';const d=new Date(v);return Number.isNaN(d.getTime())?esc(v):d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}).toUpperCase()}
function setStat(name,value){document.querySelectorAll(`[data-stat="${name}"]`).forEach(el=>{const target=Number(value||0);if(!Number.isFinite(target)){el.textContent='0';return}const start=performance.now(),duration=650;const tick=now=>{const p=Math.min(1,(now-start)/duration),ease=1-Math.pow(1-p,3);el.textContent=fmt(Math.round(target*ease));if(p<1)requestAnimationFrame(tick)};requestAnimationFrame(tick)})}
async function loadOverview(){
  try{
    const r=await fetch('/api/public/overview',{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('overview unavailable');const d=await r.json();
    setStat('drivers',d.stats?.drivers);setStat('jobs',d.stats?.jobs);setStat('miles',d.stats?.miles);setStat('live',d.stats?.live);
    const activity=document.querySelector('#activity-list');
    if(activity&&Array.isArray(d.activity)&&d.activity.length){activity.innerHTML=d.activity.slice(0,5).map(j=>`<div class="activity-item"><div class="activity-icon">↗</div><div><b>${esc(j.cargo||'Completed delivery')}</b><span>${esc(j.origin_city||'?')} → ${esc(j.destination_city||'?')} • ${esc(j.sterling_driver_id||j.discord_username||'Sterling Driver')}</span></div><strong>${fmt(j.distance_miles)} mi</strong></div>`).join('')}
    const grid=document.querySelector('#convoy-grid');
    if(grid&&Array.isArray(d.convoys)&&d.convoys.length){grid.innerHTML=d.convoys.slice(0,6).map(c=>`<article class="convoy-card"><span class="date">${formatDate(c.event_date)}${c.departure_time?` • ${esc(c.departure_time)}`:''}</span><h3>${esc(c.name)}</h3><p>${esc(c.departure_city||'TBA')} → ${esc(c.destination||'TBA')}<br>${esc(c.server_name||'Server TBA')}</p></article>`).join('')}
  }catch{document.querySelectorAll('[data-stat]').forEach(x=>{if(!x.textContent.trim()||x.textContent.trim()==='—')x.textContent='0'})}
}
const reveal=()=>{const nodes=[...document.querySelectorAll('.feature,.teaser-card,.dark-panel,.tracker-window,.tracker-copy,.convoy-card,.recruitment-banner,.timeline-item,.listing-card,.rank-card,.contact-card')];if(!('IntersectionObserver'in window)){nodes.forEach(n=>n.classList.add('revealed'));return}nodes.forEach(n=>n.classList.add('reveal'));const io=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('revealed');io.unobserve(e.target)}}),{threshold:.08});nodes.forEach(n=>io.observe(n))};

const DISCORD_INVITE='https://discord.gg/fXkxccZNmp';
function addDiscordInvite(){
  const style=document.createElement('style');
  style.textContent=`.discord-float{position:fixed;right:22px;bottom:22px;z-index:80;display:flex;align-items:center;gap:10px;padding:12px 16px;border:1px solid rgba(132,151,255,.45);border-radius:12px;background:linear-gradient(180deg,#5865f2,#4752c4);color:#fff;font:900 10px/1 Inter,Segoe UI,Arial,sans-serif;letter-spacing:.08em;text-transform:uppercase;box-shadow:0 18px 45px rgba(0,0,0,.38),0 0 0 1px rgba(255,255,255,.04) inset;transition:.2s}.discord-float:hover{transform:translateY(-3px);filter:brightness(1.08)}.discord-float svg{width:18px;height:18px;fill:currentColor}.footer-discord{color:#aeb7ff!important}@media(max-width:640px){.discord-float{right:14px;bottom:14px;padding:11px 13px}.discord-float span{display:none}}`;
  document.head.appendChild(style);
  const link=document.createElement('a');
  link.className='discord-float';link.href=DISCORD_INVITE;link.target='_blank';link.rel='noopener';link.setAttribute('aria-label','Join Sterling Logistics on Discord');
  link.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19.5 5.3A17 17 0 0 0 15.4 4l-.5 1.1a15.4 15.4 0 0 0-5.8 0L8.6 4a17 17 0 0 0-4.1 1.3C1.9 9.1 1.2 12.8 1.6 16.4a16.9 16.9 0 0 0 5 2.5l1.2-1.7a10.7 10.7 0 0 1-1.9-.9l.5-.4c3.7 1.7 7.7 1.7 11.3 0l.6.4c-.6.4-1.3.7-1.9.9l1.2 1.7a16.9 16.9 0 0 0 5-2.5c.5-4.2-.8-7.8-3.1-11.1ZM8.3 14.2c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Zm7.4 0c-1.1 0-2-1-2-2.2s.9-2.2 2-2.2 2 1 2 2.2-.9 2.2-2 2.2Z"/></svg><span>Join our Discord</span>';
  document.body.appendChild(link);
  const footer=document.querySelector('.footer-links>div:last-child');
  if(footer){const a=document.createElement('a');a.href=DISCORD_INVITE;a.target='_blank';a.rel='noopener';a.className='footer-discord';a.textContent='Discord';footer.appendChild(a)}
}

loadOverview();reveal();addDiscordInvite();
