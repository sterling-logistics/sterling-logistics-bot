using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;

namespace SterlingTracker.Desktop;

public partial class MainWindow : Window
{
    readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(8)};
    readonly string settingsPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sterling Logistics","tracker.json");
    const string TelemetryUrl="http://localhost:6969/";
    const string ApiBase="http://45.43.163.175:8101";
    readonly string sessionCode=$"desktop-{Environment.MachineName}-{Guid.NewGuid():N}";
    readonly Dictionary<string,bool> lastFlags=new();
    string sessionToken="";
    bool running=true,lastOnJob;
    double? lastGameTime;

    public MainWindow()
    {
        InitializeComponent();
        foreach(var n in new[]{"JobDelivered","JobCancelled","Refuel","RefuelPayed","Fined","Tollgate","Ferry","Train"})lastFlags[n]=false;
        LoadSettings();
        Loaded+=async(_,_)=>{await RefreshIdentity();_ = Loop();};
        Closed+=(_,_)=>running=false;
    }

    void LoadSettings()
    {
        try
        {
            if(!File.Exists(settingsPath))return;
            var s=JsonSerializer.Deserialize<Settings>(File.ReadAllText(settingsPath));
            if(!string.IsNullOrWhiteSpace(s?.ProtectedToken))sessionToken=Unprotect(s.ProtectedToken);
            else if(!string.IsNullOrWhiteSpace(s?.TrackerKey))sessionToken=s.TrackerKey;
        }catch{}
    }

    void SaveToken(string token)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);
        File.WriteAllText(settingsPath,JsonSerializer.Serialize(new Settings{ProtectedToken=Protect(token)}));
    }

    void ClearToken(){sessionToken="";try{if(File.Exists(settingsPath))File.Delete(settingsPath);}catch{}SetSignedOutUi();}
    static string Protect(string value)=>Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value),null,DataProtectionScope.CurrentUser));
    static string Unprotect(string value)=>Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value),null,DataProtectionScope.CurrentUser));

    async void AccountButton_Click(object sender,RoutedEventArgs e)
    {
        if(!string.IsNullOrWhiteSpace(sessionToken))
        {
            try{using var req=Authorized(HttpMethod.Post,"/auth/desktop/logout");await http.SendAsync(req);}catch{}
            ClearToken();FooterText.Text="Signed out of Sterling";return;
        }
        AccountButton.IsEnabled=false;
        try
        {
            StatusText.Text="● Opening Discord sign in";FooterText.Text="Complete the login in your browser";
            var payload=JsonSerializer.Serialize(new{deviceName=$"{Environment.MachineName} • Windows"});
            using var res=await http.PostAsync(ApiBase+"/auth/desktop/start",new StringContent(payload,Encoding.UTF8,"application/json"));
            var raw=await res.Content.ReadAsStringAsync();if(!res.IsSuccessStatusCode)throw new Exception(ReadError(raw));
            using var start=JsonDocument.Parse(raw);
            var state=start.RootElement.GetProperty("state").GetString()!;
            var url=start.RootElement.GetProperty("authorizeUrl").GetString()!;
            Process.Start(new ProcessStartInfo(url){UseShellExecute=true});
            for(var n=0;n<150;n++)
            {
                await Task.Delay(2000);
                using var poll=await http.GetAsync(ApiBase+"/auth/desktop/status?state="+Uri.EscapeDataString(state));
                var text=await poll.Content.ReadAsStringAsync();
                if(poll.StatusCode==System.Net.HttpStatusCode.NotFound)throw new Exception("Login expired. Try again.");
                using var doc=JsonDocument.Parse(text);
                var status=doc.RootElement.TryGetProperty("status",out var st)?st.GetString():"";
                if(status=="complete")
                {
                    sessionToken=doc.RootElement.GetProperty("token").GetString()!;
                    SaveToken(sessionToken);
                    await RefreshIdentity();
                    FooterText.Text="Discord account linked securely";
                    return;
                }
                if(status=="error")throw new Exception(doc.RootElement.TryGetProperty("error",out var er)?er.GetString():"Discord login failed");
            }
            throw new Exception("Discord login timed out");
        }
        catch(Exception ex){FooterText.Text=ex.Message;SetSignedOutUi();}
        finally{AccountButton.IsEnabled=true;}
    }

    async Task RefreshIdentity()
    {
        if(string.IsNullOrWhiteSpace(sessionToken)){SetSignedOutUi();return;}
        try
        {
            using var req=Authorized(HttpMethod.Get,"/api/desktop/me");
            using var res=await http.SendAsync(req);
            if(!res.IsSuccessStatusCode){ClearToken();return;}
            using var doc=JsonDocument.Parse(await res.Content.ReadAsStringAsync());
            var d=doc.RootElement.GetProperty("driver");
            DriverNameText.Text=d.TryGetProperty("discordUsername",out var u)?u.GetString()??"Sterling Driver":"Sterling Driver";
            DriverIdText.Text=d.TryGetProperty("sterlingDriverId",out var id)?id.GetString()??"—":"—";
            RankText.Text=d.TryGetProperty("rank",out var rank)&&rank.ValueKind!=JsonValueKind.Null?rank.GetString()??"Driver":"Driver";
            StatusText.Text="● Sterling Connected";
            AccountText.Text=$"{DriverIdText.Text} • {DriverNameText.Text}";
            ConnectionText.Text="Connected";
            AccountButton.Content="Sign out";
        }catch{ConnectionText.Text="Reconnecting";}
    }

    void SetSignedOutUi(){StatusText.Text="● Sterling account not connected";AccountText.Text="Sign in with Discord to link your approved driver profile";DriverNameText.Text="Not signed in";DriverIdText.Text="—";RankText.Text="—";ConnectionText.Text="Offline";AccountButton.Content="Sign in with Discord";}

    async Task Loop()
    {
        while(running)
        {
            JsonElement? raw=null;
            try
            {
                var gameRunning=Process.GetProcessesByName("eurotrucks2").Length>0;
                if(!gameRunning){GameText.Text="ETS2 not detected";TelemetryText.Text="Waiting for Euro Truck Simulator 2";await Task.Delay(3000);continue;}
                GameText.Text="Euro Truck Simulator 2 detected";
                var json=await http.GetStringAsync(TelemetryUrl);
                using var doc=JsonDocument.Parse(json);
                raw=doc.RootElement.Clone();
                if(!Bool(raw.Value,"SdkActive")){TelemetryText.Text="ETS2 detected • telemetry SDK waiting";await Task.Delay(3000);continue;}
                UpdateUi(raw.Value);
                TelemetryText.Text="Live telemetry active";
                if(!string.IsNullOrWhiteSpace(sessionToken))await DetectAndSend(raw.Value);
            }
            catch(Exception ex){TelemetryText.Text="Telemetry waiting";FooterText.Text=ex.Message.Length>110?ex.Message[..110]:ex.Message;}
            await Task.Delay(5000);
        }
    }

    async Task DetectAndSend(JsonElement d)
    {
        var onJob=BoolAny(d,"SpecialEventsValues.OnJob");
        var eventType="heartbeat";
        var direct=false;
        var gameTime=NumAny(d,"CommonValues.GameTime.Value");
        var gameTimeJump=lastGameTime.HasValue&&gameTime>0?Math.Max(0,gameTime-lastGameTime.Value):0;
        var eventMap=new Dictionary<string,string>{{"JobDelivered","job-delivered"},{"JobCancelled","job-cancelled"},{"Refuel","refuel"},{"RefuelPayed","refuel-paid"},{"Fined","fine"},{"Tollgate","toll"},{"Ferry","ferry"},{"Train","train"}};
        foreach(var pair in eventMap){var now=BoolAny(d,$"SpecialEventsValues.{pair.Key}");if(now&&!lastFlags[pair.Key]){eventType=pair.Value;direct=true;break;}}
        if(!direct&&gameTimeJump>=120){eventType="rest-stop";direct=true;}
        if(!direct){if(onJob&&!lastOnJob){eventType="job-started";direct=true;}else if(!onJob&&lastOnJob){eventType="job-ended";direct=true;}}
        await SendTelemetry(d,eventType,direct,gameTimeJump);
        lastOnJob=onJob;
        if(gameTime>0)lastGameTime=gameTime;
        foreach(var key in eventMap.Keys)lastFlags[key]=BoolAny(d,$"SpecialEventsValues.{key}");
        JobStateText.Text=eventType=="heartbeat"?(onJob?"Delivery tracking active":"Waiting for an ETS2 job"):$"Last event  {eventType.Replace('-',' ')}";
    }

    async Task SendTelemetry(JsonElement d,string eventType,bool direct,double gameTimeJump)
    {
        var speed=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Value");
        if(speed==0){var kph=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Kph");if(kph!=0)speed=kph/3.6;}
        var data=new Dictionary<string,object?>
        {
            ["game"]=StrAny(d,"Game"),["paused"]=BoolAny(d,"Paused"),["sdkActive"]=BoolAny(d,"SdkActive"),["speedMps"]=speed,["speedLimitMph"]=NumAny(d,"NavigationValues.SpeedLimit.Mph"),
            ["truck"]=(StrAny(d,"TruckValues.ConstantsValues.Brand")+" "+First(StrAny(d,"TruckValues.ConstantsValues.Name"),StrAny(d,"TruckValues.ConstantsValues.Model"))).Trim(),
            ["cargo"]=StrAny(d,"JobValues.CargoValues.Name"),["sourceCity"]=StrAny(d,"JobValues.CitySource"),["destinationCity"]=StrAny(d,"JobValues.CityDestination"),["distanceKm"]=FirstNum(d,"GamePlay.JobDelivered.DistanceKm","JobValues.PlannedDistanceKm"),["revenue"]=FirstNum(d,"GamePlay.JobDelivered.Revenue","JobValues.Income"),
            ["fuelLiters"]=NumAny(d,"TruckValues.CurrentValues.DashboardValues.FuelValue.Amount"),["refuelAmount"]=NumAny(d,"GamePlay.RefuelEvent.Amount"),["odometerKm"]=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Odometer"),["truckDamage"]=MaxDamage(d),["trailerDamage"]=NumAny(d,"TrailerValues.0.DamageValues.Body"),["cargoDamage"]=FirstNum(d,"JobValues.CargoValues.CargoDamage","GamePlay.JobDelivered.CargoDamage"),
            ["engineOn"]=BoolAny(d,"TruckValues.CurrentValues.EngineEnabled"),["engineRpm"]=NumAny(d,"TruckValues.CurrentValues.DashboardValues.RPM"),["gameTime"]=NumAny(d,"CommonValues.GameTime.Value"),["gameTimeJump"]=gameTimeJump,["latitude"]=NullableNum(d,"TruckValues.CurrentValues.PositionValue.X"),["longitude"]=NullableNum(d,"TruckValues.CurrentValues.PositionValue.Z"),["onJob"]=BoolAny(d,"SpecialEventsValues.OnJob"),["fineAmount"]=NumAny(d,"GamePlay.FinedEvent.Amount"),["fineOffence"]=StrAny(d,"GamePlay.FinedEvent.Offence")
        };
        var body=JsonSerializer.Serialize(new{sessionCode,status="online",eventType,directEvent=direct,data});
        using var req=Authorized(HttpMethod.Post,"/api/tracker/telemetry");
        req.Content=new StringContent(body,Encoding.UTF8,"application/json");
        using var res=await http.SendAsync(req);
        if(res.StatusCode==System.Net.HttpStatusCode.Unauthorized){ClearToken();throw new Exception("Sterling session expired • sign in again");}
        if(!res.IsSuccessStatusCode)throw new Exception($"Sterling API returned {(int)res.StatusCode}");
        FooterText.Text=direct?$"Sterling recorded {eventType.Replace('-',' ')}":"Connected to Sterling • tracking automatically";
        ConnectionText.Text="Tracking";
    }

    void UpdateUi(JsonElement d)
    {
        var speed=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Value");
        if(speed==0){var kph=NumAny(d,"TruckValues.CurrentValues.DashboardValues.Speed.Kph");if(kph!=0)speed=kph/3.6;}
        SpeedText.Text=$"{speed*2.2369362921:0} mph";
        var truck=(StrAny(d,"TruckValues.ConstantsValues.Brand")+" "+First(StrAny(d,"TruckValues.ConstantsValues.Name"),StrAny(d,"TruckValues.ConstantsValues.Model"))).Trim();
        TruckText.Text="Truck  "+(truck.Length>0?truck:"—");
        DamageText.Text=$"Damage  {MaxDamage(d)*100:0.0}%";
        FuelText.Text=$"Fuel  {NumAny(d,"TruckValues.CurrentValues.DashboardValues.FuelValue.Amount"):0.0} L";
        var cargo=StrAny(d,"JobValues.CargoValues.Name");
        CargoText.Text=string.IsNullOrWhiteSpace(cargo)?"No active delivery":cargo;
        var src=StrAny(d,"JobValues.CitySource");
        var dst=StrAny(d,"JobValues.CityDestination");
        RouteText.Text=$"{(src.Length>0?src:"—")}  →  {(dst.Length>0?dst:"—")}";
    }

    HttpRequestMessage Authorized(HttpMethod method,string path){var req=new HttpRequestMessage(method,ApiBase+path);if(!string.IsNullOrWhiteSpace(sessionToken))req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",sessionToken);return req;}
    static string ReadError(string json){try{using var d=JsonDocument.Parse(json);return d.RootElement.TryGetProperty("error",out var e)?e.GetString()??"Sterling login failed":"Sterling login failed";}catch{return "Sterling login failed";}}
    static string First(params string[] x)=>x.FirstOrDefault(v=>!string.IsNullOrWhiteSpace(v))??"";
    static JsonElement? At(JsonElement e,string path){foreach(var p in path.Split('.')){if(e.ValueKind==JsonValueKind.Array&&int.TryParse(p,out var i)){if(i<0||i>=e.GetArrayLength())return null;e=e[i];continue;}if(e.ValueKind!=JsonValueKind.Object||!e.TryGetProperty(p,out var n))return null;e=n;}return e;}
    static string StrAny(JsonElement e,string path){var x=At(e,path);return x is {ValueKind:JsonValueKind.String}?x.Value.GetString()??"":x.HasValue&&x.Value.ValueKind!=JsonValueKind.Null?x.Value.ToString():"";}
    static double NumAny(JsonElement e,string path){var x=At(e,path);if(!x.HasValue)return 0;if(x.Value.ValueKind==JsonValueKind.Number&&x.Value.TryGetDouble(out var n))return n;return double.TryParse(x.Value.ToString(),out n)?n:0;}
    static double FirstNum(JsonElement e,params string[] paths){foreach(var p in paths){var x=At(e,p);if(x.HasValue){var n=NumAny(e,p);if(n!=0)return n;}}return 0;}
    static double? NullableNum(JsonElement e,string path){var x=At(e,path);return x.HasValue?NumAny(e,path):null;}
    static bool Bool(JsonElement e,string path){var x=At(e,path);return x is {ValueKind:JsonValueKind.True};}
    static bool BoolAny(JsonElement e,string path){var x=At(e,path);if(!x.HasValue)return false;if(x.Value.ValueKind==JsonValueKind.True)return true;if(x.Value.ValueKind==JsonValueKind.False)return false;return bool.TryParse(x.Value.ToString(),out var b)&&b;}
    static double MaxDamage(JsonElement d)=>new[]{"TruckValues.CurrentValues.DamageValues.Body","TruckValues.CurrentValues.DamageValues.Chassis","TruckValues.CurrentValues.DamageValues.Engine","TruckValues.CurrentValues.DamageValues.Transmission","TruckValues.CurrentValues.DamageValues.Cabin","TruckValues.CurrentValues.DamageValues.WheelsAvg"}.Select(p=>NumAny(d,p)).DefaultIfEmpty(0).Max();
    class Settings{public string ProtectedToken{get;set;}="";public string TrackerKey{get;set;}="";}
}
