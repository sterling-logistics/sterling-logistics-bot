using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

namespace SterlingTracker;

internal sealed record DispatchDriver(long Id, string SterlingDriverId, string DiscordUsername, string Rank, string Department)
{
    public override string ToString() => $"{SterlingDriverId} — {DiscordUsername}";
}

internal sealed record DispatchCatalog(List<string> Cargo,List<string> Locations);
internal sealed record DispatchAssignment(string WorkCode,string Driver,string Cargo,string Origin,string Destination,string Status,double MinMiles,string Deadline,bool TrackerVerified,double ActualMiles,double Damage,string Notes);
internal sealed record DispatchJobApproval(string ApprovalCode,string JobCode,string Driver,string Cargo,string Route,double Miles,decimal Revenue,decimal DriverPayment,double Damage,string Status,string CreatedAt);
internal sealed record DispatchPayout(long Id,string Driver,decimal Amount,string Status,string RequestedAt,string AppliedAt,string Error);

internal sealed class DispatchApiClient : IDisposable
{
    private readonly HttpClient _http = new() { Timeout = TimeSpan.FromSeconds(12) };
    private string? _base;

    private static IEnumerable<string> Candidates()
    {
        var state=LocalState.Load();
        return new[]{state.ApiBase,TrackerState.PrimaryApiBase,TrackerState.LegacyWebsiteApiBase,TrackerState.LegacyApiBase,TrackerState.LegacyApiBase8101}
            .Where(x=>!string.IsNullOrWhiteSpace(x)).Select(x=>x.TrimEnd('/')).Distinct(StringComparer.OrdinalIgnoreCase);
    }

    private static string Token()
    {
        var token=LocalState.Load().AccessToken;
        if(string.IsNullOrWhiteSpace(token))throw new UnauthorizedAccessException("Sign in on the Tracker tab first.");
        return token;
    }

    private async Task<string> ResolveBaseAsync(CancellationToken ct=default)
    {
        if(!string.IsNullOrWhiteSpace(_base))return _base;
        var token=Token();
        var failures=new List<string>();
        foreach(var candidate in Candidates())
        {
            try
            {
                using var cts=CancellationTokenSource.CreateLinkedTokenSource(ct);cts.CancelAfter(TimeSpan.FromSeconds(5));
                using var req=new HttpRequestMessage(HttpMethod.Get,candidate+"/api/dispatch/me");
                req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
                using var res=await _http.SendAsync(req,cts.Token);
                if(res.StatusCode==System.Net.HttpStatusCode.NotFound){failures.Add(candidate+" missing staff API");continue;}
                if((int)res.StatusCode>=500){failures.Add(candidate+" unavailable");continue;}
                _base=candidate;
                var state=LocalState.Load();state.ApiBase=candidate;LocalState.Save(state);
                return candidate;
            }
            catch(OperationCanceledException) when(!ct.IsCancellationRequested){failures.Add(candidate+" timed out");}
            catch(Exception ex){failures.Add(candidate+": "+ex.Message);}
        }
        throw new HttpRequestException("Sterling Dispatch API is unreachable. "+string.Join(" | ",failures.Take(3)));
    }

    private async Task<HttpRequestMessage> RequestAsync(HttpMethod method,string path,CancellationToken ct)
    {
        var b=await ResolveBaseAsync(ct);
        var req=new HttpRequestMessage(method,b+path);
        req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",Token());
        return req;
    }

    private static async Task<string> BodyAsync(HttpResponseMessage res,CancellationToken ct)
    {
        var body=await res.Content.ReadAsStringAsync(ct);
        if(res.StatusCode==System.Net.HttpStatusCode.Unauthorized)throw new UnauthorizedAccessException("Your Sterling login has expired. Sign in again on the Tracker tab.");
        if(res.StatusCode==System.Net.HttpStatusCode.Forbidden)throw new UnauthorizedAccessException("This Sterling profile is not authorised for Dispatch Staff Edition.");
        if(!res.IsSuccessStatusCode)
        {
            try{using var doc=JsonDocument.Parse(body);if(doc.RootElement.TryGetProperty("error",out var e))throw new InvalidOperationException(e.GetString()??body);}catch(JsonException){}
            throw new InvalidOperationException($"Sterling Dispatch API returned {(int)res.StatusCode}: {body}");
        }
        return body;
    }

    private async Task<JsonDocument> GetAsync(string path,CancellationToken ct)
    {
        using var req=await RequestAsync(HttpMethod.Get,path,ct);using var res=await _http.SendAsync(req,ct);return JsonDocument.Parse(await BodyAsync(res,ct));
    }

    private async Task PostAsync(string path,object body,CancellationToken ct)
    {
        using var req=await RequestAsync(HttpMethod.Post,path,ct);req.Content=JsonContent.Create(body);using var res=await _http.SendAsync(req,ct);_=await BodyAsync(res,ct);
    }

    public async Task<bool> IsStaffAsync(CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/me",ct);return doc.RootElement.TryGetProperty("isStaff",out var s)&&s.GetBoolean();
    }

    public async Task<List<DispatchDriver>> GetDriversAsync(CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/drivers",ct);var list=new List<DispatchDriver>();
        foreach(var d in doc.RootElement.GetProperty("drivers").EnumerateArray())list.Add(new DispatchDriver(d.GetProperty("id").GetInt64(),Text(d,"sterling_driver_id","Unknown"),Text(d,"discord_username","Unknown"),Text(d,"rank_name","Driver"),Text(d,"department","")));
        return list;
    }

    public async Task<DispatchCatalog> GetCatalogAsync(CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/catalog",ct);
        var cargo=doc.RootElement.GetProperty("cargo").EnumerateArray().Select(x=>x.GetString()??"").Where(x=>!string.IsNullOrWhiteSpace(x)).ToList();
        var locations=doc.RootElement.GetProperty("locations").EnumerateArray().Select(x=>x.GetString()??"").Where(x=>!string.IsNullOrWhiteSpace(x)).ToList();
        return new DispatchCatalog(cargo,locations);
    }

    public async Task<List<DispatchAssignment>> GetAssignmentsAsync(string status="active",CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/assignments?status="+Uri.EscapeDataString(status),ct);var list=new List<DispatchAssignment>();
        foreach(var w in doc.RootElement.GetProperty("assignments").EnumerateArray())list.Add(new DispatchAssignment(Text(w,"work_code"),$"{Text(w,"sterling_driver_id")} — {Text(w,"discord_username")}",Text(w,"cargo"),Text(w,"origin_city"),Text(w,"destination_city"),Text(w,"status"),Num(w,"min_miles"),Text(w,"deadline_at"),Bool(w,"tracker_verified"),Num(w,"actual_distance_miles"),Num(w,"actual_damage"),Text(w,"notes")));
        return list;
    }

    public async Task<string> CreateAssignmentAsync(long driverId,string cargo,string origin,string destination,double minMiles,DateTime? deadline,string notes,CancellationToken ct=default)
    {
        using var req=await RequestAsync(HttpMethod.Post,"/api/dispatch/assignments",ct);req.Content=JsonContent.Create(new{driverId,cargo,origin,destination,minMiles,deadline=deadline?.ToString("O"),notes});using var res=await _http.SendAsync(req,ct);using var doc=JsonDocument.Parse(await BodyAsync(res,ct));return doc.RootElement.GetProperty("workCode").GetString()??"Created";
    }

    public Task CancelAsync(string code,string reason,CancellationToken ct=default)=>PostAsync($"/api/dispatch/assignments/{Uri.EscapeDataString(code)}/cancel",new{reason},ct);
    public Task ReassignAsync(string code,long driverId,CancellationToken ct=default)=>PostAsync($"/api/dispatch/assignments/{Uri.EscapeDataString(code)}/reassign",new{driverId},ct);

    public async Task<List<DispatchJobApproval>> GetJobApprovalsAsync(string status="pending",CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/job-approvals?status="+Uri.EscapeDataString(status),ct);var list=new List<DispatchJobApproval>();
        foreach(var a in doc.RootElement.GetProperty("approvals").EnumerateArray())list.Add(new DispatchJobApproval(Text(a,"approval_code"),Text(a,"job_code"),$"{Text(a,"sterling_driver_id")} — {Text(a,"discord_username")}",Text(a,"cargo"),$"{Text(a,"origin_city")} → {Text(a,"destination_city")}",Num(a,"distance_miles"),Dec(a,"revenue"),Dec(a,"driver_payment"),Num(a,"damage")*100,Text(a,"status"),Text(a,"created_at")));
        return list;
    }

    public Task DecideJobAsync(string code,string decision,string? notes=null,CancellationToken ct=default)=>PostAsync($"/api/dispatch/job-approvals/{Uri.EscapeDataString(code)}/decision",new{decision,notes},ct);

    public async Task<List<DispatchPayout>> GetPayoutsAsync(string status="pending",CancellationToken ct=default)
    {
        using var doc=await GetAsync("/api/dispatch/payouts?status="+Uri.EscapeDataString(status),ct);var list=new List<DispatchPayout>();
        foreach(var p in doc.RootElement.GetProperty("payouts").EnumerateArray())list.Add(new DispatchPayout(Long(p,"id"),$"{Text(p,"sterling_driver_id")} — {Text(p,"discord_username")}",Dec(p,"amount"),Text(p,"status"),Text(p,"requested_at"),Text(p,"applied_at"),Text(p,"error_text")));
        return list;
    }

    public Task RetryPayoutAsync(long id,CancellationToken ct=default)=>PostAsync($"/api/dispatch/payouts/{id}/retry",new{},ct);

    private static string Text(JsonElement e,string name,string fallback="")=>e.TryGetProperty(name,out var v)&&v.ValueKind!=JsonValueKind.Null?v.ToString():fallback;
    private static double Num(JsonElement e,string name)=>e.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.Number?v.GetDouble():double.TryParse(Text(e,name),out var x)?x:0;
    private static decimal Dec(JsonElement e,string name)=>e.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.Number?v.GetDecimal():decimal.TryParse(Text(e,name),out var x)?x:0;
    private static long Long(JsonElement e,string name)=>e.TryGetProperty(name,out var v)&&v.ValueKind==JsonValueKind.Number?v.GetInt64():long.TryParse(Text(e,name),out var x)?x:0;
    private static bool Bool(JsonElement e,string name)=>e.TryGetProperty(name,out var v)&&(v.ValueKind==JsonValueKind.True||(v.ValueKind==JsonValueKind.Number&&v.GetInt32()!=0));

    public void Dispose()=>_http.Dispose();
}
