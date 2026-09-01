using System.Text.Json;
using System.Windows;
using System.Windows.Threading;
using Sterling.Logistics.ControlCentre.Services;

namespace Sterling.Logistics.ControlCentre;

public partial class LiveMapWindow : Window
{
    private readonly ControlCentreApiClient _api;
    private readonly DispatcherTimer _timer;
    private bool _ready;

    public LiveMapWindow(ControlCentreApiClient api)
    {
        InitializeComponent();
        _api = api;
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(3) };
        _timer.Tick += async (_, _) => await RefreshMapAsync();
        Loaded += LiveMapWindow_Loaded;
        Closed += (_, _) => _timer.Stop();
    }

    private async void LiveMapWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await MapView.EnsureCoreWebView2Async();
            MapView.NavigateToString(MapHtml);
            MapView.NavigationCompleted += async (_, _) =>
            {
                _ready = true;
                await RefreshMapAsync();
                _timer.Start();
            };
        }
        catch (Exception ex) { MapStatusText.Text = $"Live map could not start: {ex.Message}"; }
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await RefreshMapAsync();

    private async Task RefreshMapAsync()
    {
        if (!_ready) return;
        try
        {
            var drivers = await _api.GetLiveDriversAsync();
            var positioned = drivers.Where(x => x.WorldX.HasValue && x.WorldZ.HasValue).ToArray();
            var mapped = positioned.Select(x => new
            {
                id = x.Id, name = x.DisplayName, x = x.WorldX, z = x.WorldZ, y = x.WorldY,
                heading = x.HeadingDeg, speed = x.SpeedKph, city = x.City, cargo = x.Cargo,
                origin = x.OriginCity, destination = x.DestinationCity,
                truck = string.Join(" ", new[] { x.TruckMake, x.TruckModel }.Where(v => !string.IsNullOrWhiteSpace(v))),
                fuel = x.FuelPercent, damage = x.DamagePercent, fines = x.FinesTotal,
                game = x.Game, status = x.Status, online = x.IsOnline, lastSeen = x.LastSeenAt
            }).ToArray();
            var json = JsonSerializer.Serialize(mapped, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            await MapView.ExecuteScriptAsync($"window.sterlingUpdateDrivers({json});");
            var liveCount = positioned.Count(x => x.IsOnline);
            MapStatusText.Text = $"{liveCount} live · {mapped.Length} Sterling position(s) · {drivers.Count} VTC driver(s) · updated {DateTime.Now:HH:mm:ss}";
        }
        catch (Exception ex) { MapStatusText.Text = $"Map update retrying: {ex.Message}"; }
    }

    private const string MapHtml = """
<!doctype html><html><head><meta charset='utf-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/>
<link rel='stylesheet' href='https://cdn.jsdelivr.net/npm/ol@10.6.1/ol.css'>
<script src='https://cdn.jsdelivr.net/npm/ol@10.6.1/dist/ol.js'></script>
<style>
html,body{height:100%;margin:0;background:#08111d;color:#dce6f2;font-family:Segoe UI,Arial,sans-serif;overflow:hidden}#bar{height:52px;display:flex;align-items:center;gap:12px;padding:0 18px;background:#0c1726;border-bottom:1px solid #20314a;box-sizing:border-box;position:relative;z-index:5}#bar b{letter-spacing:.08em;font-size:12px;color:#95a8bf}select,button{background:#111f33;color:white;border:1px solid #2b405f;border-radius:6px;padding:6px 10px}.hint{margin-left:auto;color:#71849b;font-size:12px}#map{position:absolute;top:52px;bottom:0;left:0;right:0;background:#08111d}.ol-viewport{background:#08111d}.ol-control button{background:#14253b}.ol-attribution{display:none}.truck{width:20px;height:20px;position:relative;filter:drop-shadow(0 2px 4px #000)}.truck:before{content:'';position:absolute;left:5px;top:2px;border-left:5px solid transparent;border-right:5px solid transparent;border-bottom:16px solid #f5f7fa;transform-origin:50% 55%}.truck.stale{opacity:.45}.label{white-space:nowrap;background:#0d1a2bdd;border:1px solid #334b6a;border-radius:5px;padding:3px 6px;color:#eef4fb;font-size:11px;transform:translate(14px,-18px)}.ol-overlay-container{pointer-events:none}#tip{display:none;position:absolute;z-index:10;pointer-events:none;min-width:230px;max-width:330px;background:#0d1a2b;border:1px solid #334b6a;border-radius:9px;padding:12px;box-shadow:0 10px 28px #0008;font-size:13px;line-height:1.45}#tip strong{font-size:15px;color:white}.muted{color:#8ea0b6}#error{display:none;position:absolute;z-index:8;left:20px;top:72px;background:#261722;border:1px solid #71354d;border-radius:8px;padding:10px 14px;color:#f0b8ca}
</style></head><body>
<div id='bar'><b>STERLING LIVE FLEET</b><select id='game'><option value='ets2'>ETS2</option><option value='ats'>ATS</option></select><span id='count'></span><button id='fit'>Fit fleet</button><span class='hint'>Sterling VTC telemetry only · game road map</span></div><div id='map'></div><div id='tip'></div><div id='error'></div>
<script>
const sel=document.getElementById('game'),count=document.getElementById('count'),tip=document.getElementById('tip'),err=document.getElementById('error');let all=[],map=null,vector=null,features=[];
const cfg={ets2:{extent:[-94621.8047,-93782.77,79370.13,80209.1641],tiles:'https://raw.githubusercontent.com/Unicor-p/SCS_Map_Tiles/master/ets2/latest/Tiles/{z}/{x}/{y}.png'},ats:{extent:[-127721.344,-75589.5,20049.6563,72181.5],tiles:'https://raw.githubusercontent.com/Unicor-p/SCS_Map_Tiles/master/ats/latest/Tiles/{z}/{x}/{y}.png'}};
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function build(){if(typeof ol==='undefined'){err.textContent='Road map library could not load. Check the internet connection.';err.style.display='block';return}if(map)map.setTarget(null);const c=cfg[sel.value],projection=new ol.proj.Projection({code:'STERLING-'+sel.value,units:'pixels',extent:c.extent});const roads=new ol.layer.Tile({source:new ol.source.XYZ({projection,url:c.tiles,maxZoom:8,crossOrigin:'anonymous'})});vector=new ol.layer.Vector({source:new ol.source.Vector()});map=new ol.Map({target:'map',layers:[roads,vector],controls:ol.control.defaults.defaults({attribution:false,rotate:false}),view:new ol.View({projection,center:[(c.extent[0]+c.extent[2])/2,(c.extent[1]+c.extent[3])/2],zoom:1,minZoom:0,maxZoom:8,extent:c.extent})});map.on('pointermove',hover);render(true)}
function styleFor(d){const rot=(Number(d.heading||0))*Math.PI/180;return new ol.style.Style({image:new ol.style.RegularShape({points:3,radius:10,rotation:rot,rotateWithView:false,fill:new ol.style.Fill({color:d.online?(d.status==='on_job'?'#ffffff':'#b8c8d9'):'#718096'}),stroke:new ol.style.Stroke({color:'#0b1420',width:2})}),text:new ol.style.Text({text:d.name+(d.online?'':' · last known'),offsetX:14,textAlign:'left',font:'12px Segoe UI',fill:new ol.style.Fill({color:'#edf3fa'}),stroke:new ol.style.Stroke({color:'#07101c',width:4})})})}
function render(fit){if(!map||!vector)return;const list=all.filter(d=>d.game===sel.value&&d.x!=null&&d.z!=null);count.textContent=list.filter(d=>d.online).length+' live · '+list.length+' positioned';features=list.map(d=>{const f=new ol.Feature({geometry:new ol.geom.Point([Number(d.x),-Number(d.z)]),driver:d});f.setStyle(styleFor(d));return f});vector.getSource().clear();vector.getSource().addFeatures(features);if(fit&&features.length){const e=vector.getSource().getExtent();map.getView().fit(e,{padding:[80,80,80,80],maxZoom:6,duration:250})}}
function hover(e){if(!map)return;const hit=map.forEachFeatureAtPixel(e.pixel,f=>f);if(!hit){tip.style.display='none';return}const d=hit.get('driver');tip.innerHTML=`<strong>${esc(d.name)}</strong><br><span class='muted'>${d.online?'LIVE':'LAST KNOWN'} · ${esc((d.game||'').toUpperCase())} · ${esc(d.status||'online')}</span><br>${esc(d.truck||'Truck')} · ${Number(d.speed||0).toFixed(0)} km/h${d.cargo?'<br>'+esc(d.cargo):''}${d.origin||d.destination?'<br>'+esc(d.origin||'?')+' → '+esc(d.destination||'?'):''}<br>Fuel ${d.fuel==null?'—':Number(d.fuel).toFixed(0)+'%'} · Damage ${d.damage==null?'—':Number(d.damage).toFixed(1)+'%'} · Fines ${d.fines==null?'—':Number(d.fines).toFixed(0)}`;tip.style.display='block';tip.style.left=Math.min(e.pixel[0]+18,innerWidth-350)+'px';tip.style.top=Math.min(e.pixel[1]+70,innerHeight-190)+'px'}
sel.onchange=()=>build();document.getElementById('fit').onclick=()=>render(true);window.sterlingUpdateDrivers=function(drivers){const first=!all.length;all=drivers||[];if(!all.some(d=>d.game===sel.value)&&all.length){sel.value=all[0].game||'ets2';build();return}render(first)};build();
</script></body></html>
""";
}
