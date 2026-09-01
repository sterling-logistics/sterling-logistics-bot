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
<style>
html,body{height:100%;margin:0;background:#08111d;color:#dce6f2;font-family:Segoe UI,Arial,sans-serif;overflow:hidden}
#bar{height:52px;display:flex;align-items:center;gap:12px;padding:0 18px;background:#0c1726;border-bottom:1px solid #20314a;box-sizing:border-box}#bar b{letter-spacing:.08em;font-size:12px;color:#95a8bf}select{background:#111f33;color:white;border:1px solid #2b405f;border-radius:6px;padding:6px 10px}#wrap{position:absolute;top:52px;bottom:0;left:0;right:0}canvas{width:100%;height:100%;display:block}.hint{margin-left:auto;color:#71849b;font-size:12px}#tip{display:none;position:absolute;pointer-events:none;min-width:220px;max-width:320px;background:#0d1a2b;border:1px solid #334b6a;border-radius:9px;padding:12px;box-shadow:0 10px 28px #0008;font-size:13px;line-height:1.45}#tip strong{font-size:15px;color:white}.muted{color:#8ea0b6}
</style></head><body>
<div id='bar'><b>STERLING LIVE FLEET</b><select id='game'><option value='ets2'>ETS2</option><option value='ats'>ATS</option></select><span id='count'></span><span class='hint'>Sterling VTC telemetry only · live + last known positions</span></div><div id='wrap'><canvas id='map'></canvas><div id='tip'></div></div>
<script>
const canvas=document.getElementById('map'),ctx=canvas.getContext('2d'),sel=document.getElementById('game'),tip=document.getElementById('tip'),count=document.getElementById('count');let all=[],points=[];
function resize(){const d=devicePixelRatio||1;canvas.width=Math.max(1,canvas.clientWidth*d);canvas.height=Math.max(1,canvas.clientHeight*d);ctx.setTransform(d,0,0,d,0,0);draw()}addEventListener('resize',resize);sel.onchange=draw;
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]))}
function draw(){const w=canvas.clientWidth,h=canvas.clientHeight;ctx.clearRect(0,0,w,h);ctx.fillStyle='#08111d';ctx.fillRect(0,0,w,h);const list=all.filter(d=>d.game===sel.value);const live=list.filter(d=>d.online).length;count.textContent=live+' live · '+list.length+' positioned';ctx.strokeStyle='#15253a';ctx.lineWidth=1;for(let x=0;x<w;x+=60){ctx.beginPath();ctx.moveTo(x,0);ctx.lineTo(x,h);ctx.stroke()}for(let y=0;y<h;y+=60){ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}if(!list.length){ctx.fillStyle='#60758d';ctx.font='16px Segoe UI';ctx.fillText('No Sterling '+sel.value.toUpperCase()+' positions received yet.',30,44);points=[];return}let minX=Math.min(...list.map(d=>Number(d.x))),maxX=Math.max(...list.map(d=>Number(d.x))),minZ=Math.min(...list.map(d=>Number(d.z))),maxZ=Math.max(...list.map(d=>Number(d.z)));if(maxX-minX<2000){minX-=1000;maxX+=1000}if(maxZ-minZ<2000){minZ-=1000;maxZ+=1000}const pad=55,sx=(w-pad*2)/(maxX-minX),sz=(h-pad*2)/(maxZ-minZ),s=Math.min(sx,sz),ox=(w-(maxX-minX)*s)/2,oy=(h-(maxZ-minZ)*s)/2;points=[];for(const d of list){const px=ox+(Number(d.x)-minX)*s,py=h-(oy+(Number(d.z)-minZ)*s);points.push({d,px,py});ctx.save();ctx.translate(px,py);ctx.rotate(Number(d.heading||0)*Math.PI/180);ctx.globalAlpha=d.online?1:.42;ctx.fillStyle=d.status==='on_job'?'#e6edf7':'#94a9c0';ctx.beginPath();ctx.moveTo(0,-11);ctx.lineTo(8,9);ctx.lineTo(0,6);ctx.lineTo(-8,9);ctx.closePath();ctx.fill();ctx.restore();ctx.globalAlpha=d.online?1:.55;ctx.fillStyle='#dce6f2';ctx.font='12px Segoe UI';ctx.fillText(d.name+(d.online?'':' · last known'),px+13,py+4);ctx.globalAlpha=1}}
canvas.onmousemove=e=>{const r=canvas.getBoundingClientRect(),x=e.clientX-r.left,y=e.clientY-r.top;let hit=null,best=24;for(const p of points){const dist=Math.hypot(x-p.px,y-p.py);if(dist<best){best=dist;hit=p}}if(!hit){tip.style.display='none';return}const d=hit.d;tip.innerHTML=`<strong>${esc(d.name)}</strong><br><span class='muted'>${d.online?'LIVE':'LAST KNOWN'} · ${esc((d.game||'').toUpperCase())} · ${esc(d.status||'online')}</span><br>${esc(d.truck||'Truck')} · ${Number(d.speed||0).toFixed(0)} km/h${d.cargo?'<br>'+esc(d.cargo):''}${d.origin||d.destination?'<br>'+esc(d.origin||'?')+' → '+esc(d.destination||'?'):''}<br>Fuel ${d.fuel==null?'—':Number(d.fuel).toFixed(0)+'%'} · Damage ${d.damage==null?'—':Number(d.damage).toFixed(1)+'%'} · Fines ${d.fines==null?'—':Number(d.fines).toFixed(0)}`;tip.style.display='block';tip.style.left=Math.min(x+18,r.width-340)+'px';tip.style.top=Math.min(y+18,r.height-180)+'px'};canvas.onmouseleave=()=>tip.style.display='none';window.sterlingUpdateDrivers=function(drivers){all=drivers||[];if(!all.some(d=>d.game===sel.value)&&all.length)sel.value=all[0].game||'ets2';draw()};resize();
</script></body></html>
""";
}
