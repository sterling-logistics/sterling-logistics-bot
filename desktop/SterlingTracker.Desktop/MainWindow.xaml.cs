using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;

namespace SterlingTracker.Desktop;
public partial class MainWindow : Window
{
    readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(5)};
    readonly string settingsPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"Sterling Logistics","tracker.json");
    const string TelemetryUrl="http://localhost:6969/";
    const string ApiUrl="http://45.43.163.175:8101/api/tracker/telemetry";
    string trackerKey=""; string sessionCode=$"desktop-{Environment.MachineName}-{Guid.NewGuid():N}"; bool running=true;

    public MainWindow(){InitializeComponent();LoadSettings();Loaded+=async(_,_)=>await Loop();Closed+=(_,_)=>running=false;}
    void LoadSettings(){try{if(File.Exists(settingsPath)){var s=JsonSerializer.Deserialize<Settings>(File.ReadAllText(settingsPath));trackerKey=s?.TrackerKey??"";}}catch{} }
    void SaveSettings(){Directory.CreateDirectory(Path.GetDirectoryName(settingsPath)!);File.WriteAllText(settingsPath,JsonSerializer.Serialize(new Settings{TrackerKey=trackerKey}));}

    async Task Loop(){while(running){try{var gameRunning=Process.GetProcessesByName("eurotrucks2").Length>0;if(!gameRunning){StatusText.Text="○ ETS2 Offline";GameText.Text="Launch Euro Truck Simulator 2 to begin tracking";await Task.Delay(3000);continue;}var raw=await http.GetStringAsync(TelemetryUrl);using var doc=JsonDocument.Parse(raw);var d=doc.RootElement;StatusText.Text=trackerKey.Length>10?"● Tracking":"● ETS2 detected — tracker key required";GameText.Text="Euro Truck Simulator 2 detected";UpdateUi(d);if(trackerKey.Length>10)await Send(d);}
        catch{StatusText.Text="○ Waiting for telemetry";GameText.Text="ETS2 is running but localhost:6969 is not responding";}await Task.Delay(5000);}}

    void UpdateUi(JsonElement d){
        var truck=Find(d,"truck.make")+" "+Find(d,"truck.model");TruckText.Text="Truck: "+(truck.Trim().Length>0?truck.Trim():"—");
        var speed=Num(d,"truck.speed")*2.2369362921;SpeedText.Text=$"{speed:0} mph";
        var damage=Num(d,"truck.wearEngine")+Num(d,"truck.wearTransmission")+Num(d,"truck.wearCabin")+Num(d,"truck.wearChassis")+Num(d,"truck.wearWheels");DamageText.Text=$"Damage: {damage/5*100:0.0}%";
        FuelText.Text=$"Fuel: {Num(d,"truck.fuel"):0.0} L";
        var cargo=Find(d,"trailer.name");if(string.IsNullOrWhiteSpace(cargo))cargo=Find(d,"job.cargo");CargoText.Text=string.IsNullOrWhiteSpace(cargo)?"No active delivery":cargo;
        var source=Find(d,"job.sourceCity");var dest=Find(d,"job.destinationCity");RouteText.Text=$"{(source.Length>0?source:"—")} → {(dest.Length>0?dest:"—")}";
    }

    async Task Send(JsonElement d){
        var data=new Dictionary<string,object?>{
            ["game"]="ETS2",["truck"]=(Find(d,"truck.make")+" "+Find(d,"truck.model")).Trim(),["speedMps"]=Num(d,"truck.speed"),["fuelLiters"]=Num(d,"truck.fuel"),["odometerKm"]=Num(d,"truck.odometer"),["truckDamage"]=AverageDamage(d),["engineOn"]=Bool(d,"truck.engineOn"),["cargo"]=First(Find(d,"trailer.name"),Find(d,"job.cargo")),["sourceCity"]=Find(d,"job.sourceCity"),["destinationCity"]=Find(d,"job.destinationCity")};
        var body=JsonSerializer.Serialize(new{sessionCode,status="online",eventType="heartbeat",data});using var req=new HttpRequestMessage(HttpMethod.Post,ApiUrl);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",trackerKey);req.Content=new StringContent(body,Encoding.UTF8,"application/json");var res=await http.SendAsync(req);FooterText.Text=res.IsSuccessStatusCode?"Connected to Sterling • Live telemetry uploading":"Sterling API error: "+(int)res.StatusCode;
    }

    static double AverageDamage(JsonElement d)=>new[]{"truck.wearEngine","truck.wearTransmission","truck.wearCabin","truck.wearChassis","truck.wearWheels"}.Select(x=>Num(d,x)).Average();
    static string First(params string[] x)=>x.FirstOrDefault(v=>!string.IsNullOrWhiteSpace(v))??"";
    static JsonElement? At(JsonElement e,string path){foreach(var p in path.Split('.')){if(e.ValueKind!=JsonValueKind.Object||!e.TryGetProperty(p,out var n))return null;e=n;}return e;}
    static string Find(JsonElement e,string p){var x=At(e,p);return x is {ValueKind:JsonValueKind.String}?x.Value.GetString()??"":"";}
    static double Num(JsonElement e,string p){var x=At(e,p);return x is {ValueKind:JsonValueKind.Number}&&x.Value.TryGetDouble(out var n)?n:0;}
    static bool Bool(JsonElement e,string p){var x=At(e,p);return x is {ValueKind:JsonValueKind.True};}

    void SettingsButton_Click(object sender,RoutedEventArgs e){var w=new KeyWindow(trackerKey){Owner=this};if(w.ShowDialog()==true){trackerKey=w.Key.Trim();SaveSettings();}}
    class Settings{public string TrackerKey{get;set;}="";}
}

public sealed class KeyWindow:Window
{
    readonly System.Windows.Controls.TextBox box=new();public string Key=>box.Text;
    public KeyWindow(string current){Title="Sterling Tracker Key";Width=520;Height=190;WindowStartupLocation=WindowStartupLocation.CenterOwner;var panel=new System.Windows.Controls.StackPanel{Margin=new Thickness(20)};panel.Children.Add(new System.Windows.Controls.TextBlock{Text="Paste the private key generated by /trackerkey:",Margin=new Thickness(0,0,0,10)});box.Text=current;panel.Children.Add(box);var save=new System.Windows.Controls.Button{Content="Save",Margin=new Thickness(0,16,0,0),Padding=new Thickness(14,7,14,7),HorizontalAlignment=HorizontalAlignment.Right};save.Click+=(_,_)=>{DialogResult=true;Close();};panel.Children.Add(save);Content=panel;}
}
