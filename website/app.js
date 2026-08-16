const fmt=n=>Number(n||0).toLocaleString(undefined,{maximumFractionDigits:0});
async function loadOverview(){
  try{
    const r=await fetch('/api/public/overview',{headers:{Accept:'application/json'}});if(!r.ok)throw new Error();const d=await r.json();
    document.querySelectorAll('[data-stat="drivers"]').forEach(x=>x.textContent=fmt(d.stats.drivers));
    document.querySelectorAll('[data-stat="jobs"]').forEach(x=>x.textContent=fmt(d.stats.jobs));
    document.querySelectorAll('[data-stat="miles"]').forEach(x=>x.textContent=fmt(d.stats.miles));
    document.querySelectorAll('[data-stat="live"]').forEach(x=>x.textContent=fmt(d.stats.live));
    const activity=document.querySelector('#activity-list');if(activity){activity.innerHTML=d.activity.length?d.activity.map(j=>`<div class="activity-item"><div class="activity-icon">↗</div><div><b>${escapeHtml(j.cargo||'Completed delivery')}</b><span>${escapeHtml(j.origin_city||'?')} → ${escapeHtml(j.destination_city||'?')} • ${escapeHtml(j.sterling_driver_id||j.discord_username||'Sterling Driver')}</span></div><strong>${fmt(j.distance_miles)} mi</strong></div>`).join(''):'<div class="activity-item"><div class="activity-icon">—</div><div><b>No completed loads yet</b><span>Company activity will appear here automatically.</span></div></div>'}
    const grid=document.querySelector('#convoy-grid');if(grid){grid.innerHTML=d.convoys.length?d.convoys.map(c=>`<article class="convoy-card"><span class="date">${formatDate(c.event_date)}${c.departure_time?` • ${escapeHtml(c.departure_time)}`:''}</span><h3>${escapeHtml(c.name)}</h3><p>${escapeHtml(c.departure_city||'TBA')} → ${escapeHtml(c.destination||'TBA')}<br>${escapeHtml(c.server_name||'Server TBA')}</p></article>`).join(''):'<article class="convoy-card empty"><span>No upcoming convoy has been published yet.</span></article>'}
  }catch{document.querySelectorAll('[data-stat]').forEach(x=>{if(x.textContent==='—')x.textContent='0'})}
}
function escapeHtml(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function formatDate(v){if(!v)return'TBA';const d=new Date(v);return Number.isNaN(d.getTime())?escapeHtml(v):d.toLocaleDateString(undefined,{day:'2-digit',month:'short',year:'numeric'}).toUpperCase()}
loadOverview();
