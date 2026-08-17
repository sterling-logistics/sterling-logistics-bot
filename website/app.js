const fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const menu=document.querySelector('[data-menu]'),nav=document.querySelector('[data-nav]');
if(menu&&nav){menu.addEventListener('click',()=>nav.classList.toggle('open'));nav.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>nav.classList.remove('open')))}
function formatDate(v){if(!v)return'TBA';const d=new Date(v);return Number.isNaN(d.getTime())?esc(v):d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}).toUpperCase()}
async function loadOverview(){
  try{
    const r=await fetch('/api/public/overview',{headers:{Accept:'application/json'}});if(!r.ok)throw new Error('overview unavailable');const d=await r.json();
    document.querySelectorAll('[data-stat="drivers"]').forEach(x=>x.textContent=fmt(d.stats?.drivers));
    document.querySelectorAll('[data-stat="jobs"]').forEach(x=>x.textContent=fmt(d.stats?.jobs));
    document.querySelectorAll('[data-stat="miles"]').forEach(x=>x.textContent=fmt(d.stats?.miles));
    document.querySelectorAll('[data-stat="live"]').forEach(x=>x.textContent=fmt(d.stats?.live));
    const activity=document.querySelector('#activity-list');
    if(activity&&Array.isArray(d.activity)&&d.activity.length){activity.innerHTML=d.activity.slice(0,5).map(j=>`<div class="activity-item"><div class="activity-icon">↗</div><div><b>${esc(j.cargo||'Completed delivery')}</b><span>${esc(j.origin_city||'?')} → ${esc(j.destination_city||'?')} • ${esc(j.sterling_driver_id||j.discord_username||'Sterling Driver')}</span></div><strong>${fmt(j.distance_miles)} mi</strong></div>`).join('')}
    const grid=document.querySelector('#convoy-grid');
    if(grid&&Array.isArray(d.convoys)&&d.convoys.length){grid.innerHTML=d.convoys.slice(0,6).map(c=>`<article class="convoy-card"><span class="date">${formatDate(c.event_date)}${c.departure_time?` • ${esc(c.departure_time)}`:''}</span><h3>${esc(c.name)}</h3><p>${esc(c.departure_city||'TBA')} → ${esc(c.destination||'TBA')}<br>${esc(c.server_name||'Server TBA')}</p></article>`).join('')}
  }catch{
    document.querySelectorAll('[data-stat]').forEach(x=>{if(!x.textContent.trim()||x.textContent.trim()==='—')x.textContent='0'});
  }
}
loadOverview();
