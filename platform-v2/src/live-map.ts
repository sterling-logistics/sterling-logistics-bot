import type { FastifyInstance } from 'fastify';

const liveMapHtml = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sterling Logistics Live Map</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/ol@10.6.1/ol.css">
<style>
html,body,#map{margin:0;width:100%;height:100%;background:#08111d;font-family:Segoe UI,Arial,sans-serif}#panel{position:absolute;z-index:20;top:16px;left:16px;width:300px;background:#101b2aee;color:#fff;border:1px solid #29405c;border-radius:12px;padding:14px;box-shadow:0 12px 36px #0008}h2{margin:0 0 10px;font-size:18px}.row{display:flex;gap:8px;margin-top:8px}input,button,select{box-sizing:border-box;border-radius:7px;border:1px solid #38516d;background:#0b1522;color:#fff;padding:9px}input{width:100%;margin:4px 0}button{cursor:pointer;background:#1d65a6;font-weight:600}.hidden{display:none}#status{font-size:12px;color:#b9c7d8;margin-top:8px}.ol-zoom{left:auto;right:16px;top:16px}
</style></head><body><div id="map"></div><div id="panel"><h2>Sterling Logistics · Live Fleet</h2><div id="login"><input id="username" autocomplete="username" placeholder="Owner username"><input id="password" type="password" autocomplete="current-password" placeholder="Password"><button id="signIn">Sign in</button></div><div id="controls" class="hidden"><div class="row"><select id="game"><option value="ets2">Euro Truck Simulator 2</option><option value="ats">American Truck Simulator</option></select><button id="fit">Fit fleet</button></div><div id="status">Connected</div></div></div>
<script src="https://cdn.jsdelivr.net/npm/ol@10.6.1/dist/ol.js"></script><script>
const maps={ets2:{extent:[-94621.8047,-93782.77,79370.13,80209.1641]},ats:{extent:[-127721.344,-75589.5,20049.6563,72181.5]}};
let token='',drivers=[],game='ets2';
const projection=new ol.proj.Projection({code:'SCS',units:'m',extent:maps.ets2.extent});
const tiles=new ol.layer.Tile(); const vectors=new ol.source.Vector();
const fleet=new ol.layer.Vector({source:vectors,style:f=>new ol.style.Style({image:new ol.style.Circle({radius:8,fill:new ol.style.Fill({color:f.get('online')?'#45d483':'#8090a0'}),stroke:new ol.style.Stroke({color:'#fff',width:2})}),text:new ol.style.Text({text:f.get('name'),offsetY:-18,fill:new ol.style.Fill({color:'#fff'}),stroke:new ol.style.Stroke({color:'#07101b',width:4})})})});
const map=new ol.Map({target:'map',layers:[tiles,fleet],view:new ol.View({projection,center:[0,0],zoom:2,minZoom:0,maxZoom:8})});
function setGame(g){game=g;const m=maps[g];projection.setExtent(m.extent);tiles.setSource(new ol.source.XYZ({projection,tileGrid:ol.tilegrid.createXYZ({extent:m.extent,minZoom:0,maxZoom:8}),url:'https://raw.githubusercontent.com/Unicor-p/SCS_Map_Tiles/master/'+g+'/latest/Tiles/{z}/{x}/{y}.png',crossOrigin:'anonymous'}));map.getView().fit(m.extent,{padding:[40,40,40,40]});render();}
function render(){vectors.clear();const visible=drivers.filter(d=>String(d.game||'').toLowerCase()===game&&Number.isFinite(Number(d.worldX))&&Number.isFinite(Number(d.worldZ)));for(const d of visible){const f=new ol.Feature({geometry:new ol.geom.Point([Number(d.worldX),-Number(d.worldZ)]),name:d.displayName||d.username||'Driver',online:d.online!==false});f.set('driver',d);vectors.addFeature(f);}document.getElementById('status').textContent=visible.length+' Sterling driver'+(visible.length===1?'':'s')+' on map';}
async function load(){if(!token)return;try{const r=await fetch('/api/v2/owner/live/drivers',{headers:{Authorization:'Bearer '+token}});if(r.status===401||r.status===403){token='';document.getElementById('login').classList.remove('hidden');document.getElementById('controls').classList.add('hidden');return;}if(!r.ok)throw new Error();const body=await r.json();drivers=Array.isArray(body)?body:(body.drivers||body.items||[]);render();}catch{document.getElementById('status').textContent='Live data temporarily unavailable';}}
document.getElementById('signIn').onclick=async()=>{const username=document.getElementById('username').value.trim(),password=document.getElementById('password').value;const r=await fetch('/api/v2/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});if(!r.ok){document.getElementById('password').value='';return;}const b=await r.json();token=b.accessToken||b.access_token||'';if(!token)return;document.getElementById('login').classList.add('hidden');document.getElementById('controls').classList.remove('hidden');await load();};
document.getElementById('game').onchange=e=>setGame(e.target.value);document.getElementById('fit').onclick=()=>{if(vectors.getFeatures().length)map.getView().fit(vectors.getExtent(),{padding:[80,80,80,360],maxZoom:6,duration:300});};
map.on('singleclick',e=>{const f=map.forEachFeatureAtPixel(e.pixel,x=>x);if(f){const d=f.get('driver');document.getElementById('status').textContent=(d.displayName||d.username||'Driver')+' · '+(d.speedKph??0)+' km/h · '+(d.cargo||'No cargo');}});
setGame('ets2');setInterval(load,5000);
</script></body></html>`;

export async function registerLiveMapRoutes(app: FastifyInstance) {
  app.get('/live-map', async (_request, reply) => reply.type('text/html; charset=utf-8').send(liveMapHtml));
}
