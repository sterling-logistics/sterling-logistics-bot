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
        _timer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(5) };
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
        catch (Exception ex)
        {
            MapStatusText.Text = $"Live map could not start: {ex.Message}";
        }
    }

    private async void RefreshButton_Click(object sender, RoutedEventArgs e) => await RefreshMapAsync();

    private async Task RefreshMapAsync()
    {
        if (!_ready) return;
        try
        {
            var drivers = await _api.GetLiveDriversAsync();
            var mapped = drivers
                .Where(x => x.IsOnline && x.Latitude.HasValue && x.Longitude.HasValue)
                .Select(x => new
                {
                    id = x.Id,
                    name = x.DisplayName,
                    lat = x.Latitude,
                    lng = x.Longitude,
                    heading = x.HeadingDeg,
                    speed = x.SpeedKph,
                    city = x.City,
                    cargo = x.Cargo,
                    destination = x.DestinationCity,
                    game = x.Game,
                    status = x.Status
                })
                .ToArray();
            var json = JsonSerializer.Serialize(mapped, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            await MapView.ExecuteScriptAsync($"window.sterlingUpdateDrivers({json});");
            MapStatusText.Text = $"{mapped.Length} live driver(s) on map · updated {DateTime.Now:HH:mm:ss}";
        }
        catch (Exception ex)
        {
            MapStatusText.Text = $"Map update retrying: {ex.Message}";
        }
    }

    private const string MapHtml = """
<!doctype html><html><head><meta charset='utf-8'/><meta name='viewport' content='width=device-width,initial-scale=1'/>
<link rel='stylesheet' href='https://unpkg.com/leaflet@1.9.4/dist/leaflet.css'/>
<style>html,body,#map{height:100%;margin:0;background:#09111d} .leaflet-container{background:#09111d;font-family:Segoe UI,Arial,sans-serif}.sterling-popup{min-width:180px}.sterling-popup b{font-size:14px}</style>
</head><body><div id='map'></div><script src='https://unpkg.com/leaflet@1.9.4/dist/leaflet.js'></script><script>
const map=L.map('map',{zoomControl:true}).setView([51.1,10.3],5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19,attribution:'© OpenStreetMap contributors'}).addTo(map);
const markers=new Map();
function esc(v){return String(v??'').replace(/[&<>'\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','\"':'&quot;'}[c]));}
window.sterlingUpdateDrivers=function(drivers){
 const seen=new Set();
 for(const d of drivers){seen.add(String(d.id));const ll=[Number(d.lat),Number(d.lng)];
  const html=`<div class='sterling-popup'><b>${esc(d.name)}</b><br>${esc((d.game||'').toUpperCase())} · ${esc(d.status||'online')}<br>${esc(d.city||'Location live')}<br>${Number(d.speed||0).toFixed(0)} km/h${d.cargo?'<br>'+esc(d.cargo):''}${d.destination?'<br>→ '+esc(d.destination):''}</div>`;
  let m=markers.get(String(d.id)); if(!m){m=L.marker(ll).addTo(map);markers.set(String(d.id),m);} else m.setLatLng(ll); m.bindPopup(html);
 }
 for(const [id,m] of markers){if(!seen.has(id)){map.removeLayer(m);markers.delete(id);}}
};
</script></body></html>
""";
}
