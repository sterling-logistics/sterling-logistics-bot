(()=>{
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let busy=false;
  async function refresh(){
    const grid=document.querySelector('#live-driver-grid');if(!grid||busy||document.hidden)return;busy=true;
    try{
      const r=await fetch('/api/public/live',{headers:{Accept:'application/json'},cache:'no-store'});if(!r.ok)throw new Error();
      const d=await r.json();
      if(!Array.isArray(d.online)||!d.online.length){grid.innerHTML='<div class="empty-live"><b>No drivers are transmitting right now.</b><br>The board updates automatically when Sterling Tracker comes online.</div>';return}
      grid.innerHTML=d.online.slice(0,12).map(x=>`<article class="live-driver-card"><div class="driver-live-head"><b>${esc(x.name)}</b><span class="live-badge">● LIVE</span></div><div class="live-route-name">${esc(x.origin||'On the road')} → ${esc(x.destination||'Destination pending')}</div><div class="live-driver-meta"><span><strong>${esc(x.truck||'Truck')}</strong></span><span>${esc(x.cargo||'No cargo reported')}</span><span>${Math.round(x.speedMph||0)} mph</span><span>${Math.round(x.engineRpm||0)} rpm</span><span>${Math.round(x.speedLimitMph||0)} mph limit</span><span>${Number(x.fuelLiters||0).toFixed(0)} L fuel</span></div></article>`).join('');
    }catch{grid.innerHTML='<div class="empty-live">Live operations are temporarily unavailable.</div>'}finally{busy=false}
  }
  refresh();setInterval(refresh,2000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
})();
