import crypto from "node:crypto";
import {db} from "../database/mysql.js";

const pending=new Map();
const hash=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

function cleanup(){const now=Date.now();for(const[k,v]of pending)if(now-v.createdAt>10*60*1000)pending.delete(k);}
setInterval(cleanup,60_000).unref?.();

async function createDesktopSession(driverId,deviceName){
  const device=String(deviceName||"Sterling Tracker").slice(0,120);
  await db().execute("UPDATE desktop_sessions SET revoked_at=NOW() WHERE driver_id=? AND device_name=? AND revoked_at IS NULL",[driverId,device]);
  const token=`sldsk_${crypto.randomBytes(32).toString("hex")}`;
  await db().execute("INSERT INTO desktop_sessions(driver_id,token_hash,device_name,created_at,last_used_at,expires_at,revoked_at) VALUES(?,?,?,NOW(),NULL,DATE_ADD(NOW(),INTERVAL 90 DAY),NULL)",[driverId,hash(token),device]);
  return token;
}

export async function authenticateDesktopSession(token){
  if(!token)return null;
  const[r]=await db().execute(`SELECT ds.id session_id,ds.driver_id,d.sterling_driver_id,d.discord_id,d.discord_username,d.rank_name,d.total_miles,d.jobs_completed
    FROM desktop_sessions ds JOIN drivers d ON d.id=ds.driver_id
    WHERE ds.token_hash=? AND ds.revoked_at IS NULL AND ds.expires_at>NOW() AND d.status='active' LIMIT 1`,[hash(token)]);
  if(!r[0])return null;
  await db().execute("UPDATE desktop_sessions SET last_used_at=NOW() WHERE id=?",[r[0].session_id]);
  return r[0];
}

export function registerDesktopAuthRoutes(app,c){
  app.post("/auth/desktop/start",(q,r)=>{
    if(!c.discordClientSecret||!c.publicBaseUrl)return r.status(503).json({ok:false,error:"Discord desktop login is not configured"});
    const state=crypto.randomBytes(32).toString("hex");
    const deviceName=String(q.body?.deviceName||"Sterling Tracker").slice(0,120);
    pending.set(state,{createdAt:Date.now(),status:"pending",deviceName});
    const redirectUri=`${c.publicBaseUrl}/auth/discord/callback`;
    const u=new URL("https://discord.com/oauth2/authorize");
    u.searchParams.set("client_id",c.applicationId);u.searchParams.set("response_type","code");u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("scope","identify");u.searchParams.set("state",state);
    r.json({ok:true,state,authorizeUrl:u.toString(),expiresIn:600});
  });

  app.get("/auth/desktop/status",(q,r)=>{
    cleanup();const state=String(q.query.state||"");const p=pending.get(state);
    if(!p)return r.status(404).json({ok:false,status:"expired",error:"Login request expired"});
    if(p.status==="complete"){pending.delete(state);return r.json({ok:true,status:"complete",token:p.token,driver:p.driver});}
    if(p.status==="error"){pending.delete(state);return r.status(400).json({ok:false,status:"error",error:p.error});}
    r.json({ok:true,status:"pending"});
  });

  app.get("/auth/discord/callback",async(q,r)=>{
    const state=String(q.query.state||""),code=String(q.query.code||"");const p=pending.get(state);
    if(!p||Date.now()-p.createdAt>10*60*1000)return r.status(400).send("Sterling Tracker login request expired. Return to the tracker and try again.");
    try{
      if(!code)throw new Error("Discord did not return an authorization code");
      const redirectUri=`${c.publicBaseUrl}/auth/discord/callback`;
      const form=new URLSearchParams({client_id:c.applicationId,client_secret:c.discordClientSecret,grant_type:"authorization_code",code,redirect_uri:redirectUri});
      const tokenRes=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form});
      const tokenText=await tokenRes.text();
      if(!tokenRes.ok){
        let detail=tokenText;
        try{const j=JSON.parse(tokenText);detail=String(j.error_description||j.message||j.error||tokenText);}catch{}
        console.error("[Desktop OAuth Token Exchange]",{status:tokenRes.status,applicationId:c.applicationId,redirectUri,detail});
        throw new Error(`Discord token exchange failed (${tokenRes.status}): ${detail}`);
      }
      let oauth;
      try{oauth=JSON.parse(tokenText);}catch{throw new Error("Discord returned an invalid token response");}
      const userRes=await fetch("https://discord.com/api/v10/users/@me",{headers:{Authorization:`Bearer ${oauth.access_token}`}});
      if(!userRes.ok)throw new Error(`Discord identity lookup failed (${userRes.status})`);
      const user=await userRes.json();
      const[rows]=await db().execute("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,total_miles,jobs_completed FROM drivers WHERE discord_id=? AND status='active' LIMIT 1",[String(user.id)]);
      const driver=rows[0];if(!driver)throw new Error("Your Discord account is not currently approved for Sterling Tracker access");
      await db().execute("UPDATE drivers SET discord_username=? WHERE id=?",[String(user.global_name||user.username||driver.discord_username||"").slice(0,100),driver.id]);
      const token=await createDesktopSession(driver.id,p.deviceName);
      p.status="complete";p.token=token;p.driver={sterlingDriverId:driver.sterling_driver_id,discordUsername:user.global_name||user.username,rank:driver.rank_name,totalMiles:Number(driver.total_miles||0),jobsCompleted:Number(driver.jobs_completed||0)};
      r.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><title>Sterling Tracker</title><style>body{font-family:Segoe UI,Arial;background:#07111f;color:#fff;display:grid;place-items:center;height:100vh;margin:0}.card{background:#101b2c;border:1px solid #233653;border-radius:18px;padding:40px;text-align:center;max-width:520px}h1{color:#48a7ff}p{color:#b8c7da}</style></head><body><div class="card"><h1>Connected to Sterling</h1><p>${esc(user.global_name||user.username)} has been linked successfully</p><p>You can close this window and return to Sterling Tracker</p></div></body></html>`);
    }catch(e){p.status="error";p.error=String(e.message||e);r.status(400).type("html").send(`<h2>Sterling Tracker login failed</h2><p>${esc(p.error)}</p><p>Return to the tracker and try again.</p>`);}
  });

  app.post("/auth/desktop/logout",async(q,r)=>{const auth=String(q.headers.authorization||"");const token=auth.startsWith("Bearer ")?auth.slice(7):"";if(token)await db().execute("UPDATE desktop_sessions SET revoked_at=NOW() WHERE token_hash=?",[hash(token)]);r.json({ok:true});});
}
