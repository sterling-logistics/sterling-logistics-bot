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
loadOverview();reveal();
