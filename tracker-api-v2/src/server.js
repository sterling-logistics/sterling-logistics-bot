import dotenv from "dotenv";
import crypto from "node:crypto";
import express from "express";
import mysql from "mysql2/promise";

dotenv.config({path:new URL("../../.env",import.meta.url).pathname});

const required=["DISCORD_APPLICATION_ID","DISCORD_CLIENT_SECRET","DB_HOST","DB_PORT","DB_NAME","DB_USER","DB_PASSWORD"];
const missing=required.filter(k=>!String(process.env[k]||"").trim());
if(missing.length)throw new Error(`Missing Tracker API environment variables: ${missing.join(", ")}`);

const PORT=Number(process.env.SERVER_PORT||process.env.PORT||8101);
const DRIVER_PAY_RATE=Math.max(0,Math.min(1,Number(process.env.DRIVER_PAY_RATE||0.55)));
const APP_ID=process.env.DISCORD_APPLICATION_ID.trim();
const CLIENT_SECRET=process.env.DISCORD_CLIENT_SECRET.trim();

const pool=mysql.createPool({
  host:process.env.DB_HOST.trim(),port:Number(process.env.DB_PORT||3306),database:process.env.DB_NAME.trim(),
  user:process.env.DB_USER.trim(),password:process.env.DB_PASSWORD,waitForConnections:true,connectionLimit:10,queueLimit:0
});

const app=express();
app.set("trust proxy",true);
app.use(express.json({limit:"512kb"}));
const pending=new Map();
const sha256=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const number=v=>Number(v)||0;
const safeText=(v,n=150)=>String(v??"").trim().slice(0,n)||null;
const html=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]));

function jobCode(driverId,sessionCode,data){
  const seed=[driverId,sessionCode,data.sourceCity,data.destinationCity,data.cargo].join("|");
  return `TRK-${crypto.createHash("sha1").update(seed).digest("hex").slice(0,20).toUpperCase()}`;
}
function cleanupPending(){const now=Date.now();for(const[k,v]of pending)if(now-v.createdAt>10*60*1000)pending.delete(k);}
setInterval(cleanupPending,60000).unref?.();

async function ensureSchema(){
  await pool.query(`CREATE TABLE IF NOT EXISTS desktop_sessions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,driver_id BIGINT UNSIGNED NOT NULL,token_hash CHAR(64) NOT NULL,
    device_name VARCHAR(120),created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_used_at TIMESTAMP NULL,
    expires_at TIMESTAMP NULL,revoked_at TIMESTAMP NULL,UNIQUE KEY(token_hash),INDEX(driver_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS telemetry_sessions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,session_code VARCHAR(120) NOT NULL UNIQUE,driver_id BIGINT UNSIGNED NOT NULL,
    status VARCHAR(50) DEFAULT 'online',created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,INDEX(driver_id),INDEX(status,last_seen_at))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS telemetry_events(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,session_id BIGINT UNSIGNED,driver_id BIGINT UNSIGNED NOT NULL,
    event_type VARCHAR(80) NOT NULL,direct_event TINYINT(1) DEFAULT 0,event_json JSON,created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX(driver_id,created_at),INDEX(session_id))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS live_telemetry(
    driver_id BIGINT UNSIGNED PRIMARY KEY,session_code VARCHAR(120),status VARCHAR(50),game VARCHAR(30),truck VARCHAR(200),cargo VARCHAR(150),
    source_city VARCHAR(150),destination_city VARCHAR(150),speed_mph DECIMAL(10,2) DEFAULT 0,latitude DECIMAL(12,7),longitude DECIMAL(12,7),
    raw_json JSON,last_seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS tracked_job_approvals(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,approval_code VARCHAR(24) UNIQUE,job_code VARCHAR(32),driver_id BIGINT UNSIGNED NOT NULL,
    session_id BIGINT UNSIGNED,reference_key VARCHAR(255) NOT NULL UNIQUE,cargo VARCHAR(150),origin_city VARCHAR(150),destination_city VARCHAR(150),
    distance_miles DECIMAL(12,2) NOT NULL DEFAULT 0,revenue DECIMAL(16,2) NOT NULL DEFAULT 0,driver_payment DECIMAL(16,2) NOT NULL DEFAULT 0,
    damage DECIMAL(8,4) NOT NULL DEFAULT 0,status VARCHAR(30) NOT NULL DEFAULT 'pending',reviewed_by VARCHAR(32),review_notes VARCHAR(1000),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,reviewed_at TIMESTAMP NULL,INDEX(status,created_at),INDEX(driver_id,created_at),INDEX(job_code))`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ets2_payouts(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,driver_id BIGINT UNSIGNED NOT NULL,amount DECIMAL(16,2) NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,applied_at TIMESTAMP NULL,
    save_path VARCHAR(500),error_text VARCHAR(1000),INDEX(driver_id,status,requested_at))`);
}

async function auth(req){
  const h=String(req.headers.authorization||"");const token=h.startsWith("Bearer ")?h.slice(7):"";if(!token)return null;
  const[r]=await pool.execute(`SELECT ds.id session_id,ds.driver_id,d.sterling_driver_id,d.discord_id,d.discord_username,d.rank_name,d.total_miles,d.jobs_completed
    FROM desktop_sessions ds JOIN drivers d ON d.id=ds.driver_id
    WHERE ds.token_hash=? AND ds.revoked_at IS NULL AND ds.expires_at>NOW() AND d.status='active' LIMIT 1`,[sha256(token)]);
  if(!r[0])return null;await pool.execute("UPDATE desktop_sessions SET last_used_at=NOW() WHERE id=?",[r[0].session_id]);return r[0];
}

async function createDesktopSession(driverId,deviceName){
  const device=safeText(deviceName,120)||"Sterling Tracker";
  await pool.execute("UPDATE desktop_sessions SET revoked_at=NOW() WHERE driver_id=? AND device_name=? AND revoked_at IS NULL",[driverId,device]);
  const token=`sldsk_${crypto.randomBytes(32).toString("hex")}`;
  await pool.execute("INSERT INTO desktop_sessions(driver_id,token_hash,device_name,expires_at) VALUES(?,?,?,DATE_ADD(NOW(),INTERVAL 90 DAY))",[driverId,sha256(token),device]);
  return token;
}

app.get("/health",async(_req,res)=>{try{const[c]=await pool.query("SELECT DATABASE() db");res.json({ok:true,service:"sterling-tracker-api-v2",database:c[0].db,driverPayRate:DRIVER_PAY_RATE});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}});

app.post("/auth/desktop/start",(req,res)=>{
  const state=crypto.randomBytes(32).toString("hex");
  const deviceName=safeText(req.body?.deviceName,120)||"Sterling Tracker";
  const proto=String(req.get("x-forwarded-proto")||req.protocol||"http").split(",")[0].trim();
  const host=String(req.get("host")||"").trim();if(!host)return res.status(400).json({ok:false,error:"Could not determine tracker API host"});
  const redirectUri=`${proto}://${host}/auth/discord/callback`;
  pending.set(state,{createdAt:Date.now(),status:"pending",deviceName,redirectUri});
  const u=new URL("https://discord.com/oauth2/authorize");u.searchParams.set("client_id",APP_ID);u.searchParams.set("response_type","code");u.searchParams.set("redirect_uri",redirectUri);u.searchParams.set("scope","identify");u.searchParams.set("state",state);
  console.log("[OAuth] start",redirectUri);res.json({ok:true,state,authorizeUrl:u.toString(),expiresIn:600});
});
app.get("/auth/desktop/status",(req,res)=>{cleanupPending();const p=pending.get(String(req.query.state||""));if(!p)return res.status(404).json({ok:false,status:"expired",error:"Login request expired"});if(p.status==="complete"){pending.delete(String(req.query.state));return res.json({ok:true,status:"complete",token:p.token,driver:p.driver});}if(p.status==="error"){pending.delete(String(req.query.state));return res.status(400).json({ok:false,status:"error",error:p.error});}res.json({ok:true,status:"pending"});});
app.get("/auth/discord/callback",async(req,res)=>{
  const state=String(req.query.state||""),code=String(req.query.code||""),p=pending.get(state);
  if(!p||Date.now()-p.createdAt>600000)return res.status(400).send("Sterling Tracker login request expired.");
  try{
    const basic=Buffer.from(`${APP_ID}:${CLIENT_SECRET}`).toString("base64");
    const form=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:p.redirectUri});
    const tr=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded",Authorization:`Basic ${basic}`},body:form});
    const tt=await tr.text();if(!tr.ok)throw new Error(`Discord token exchange failed (${tr.status}): ${tt}`);const oauth=JSON.parse(tt);
    const ur=await fetch("https://discord.com/api/v10/users/@me",{headers:{Authorization:`Bearer ${oauth.access_token}`}});if(!ur.ok)throw new Error(`Discord identity lookup failed (${ur.status})`);const user=await ur.json();
    const[rows]=await pool.execute("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,total_miles,jobs_completed FROM drivers WHERE discord_id=? AND status='active' LIMIT 1",[String(user.id)]);
    const d=rows[0];if(!d)throw new Error("Your Discord account is not currently approved for Sterling Tracker access");
    await pool.execute("UPDATE drivers SET discord_username=? WHERE id=?",[safeText(user.global_name||user.username,100),d.id]);
    const token=await createDesktopSession(d.id,p.deviceName);p.status="complete";p.token=token;p.driver={sterlingDriverId:d.sterling_driver_id,discordUsername:user.global_name||user.username,rank:d.rank_name,totalMiles:Number(d.total_miles||0),jobsCompleted:Number(d.jobs_completed||0)};
    res.type("html").send(`<!doctype html><html><body style="font-family:Segoe UI;background:#07111f;color:white;text-align:center;padding:80px"><h1 style="color:#48a7ff">Connected to Sterling</h1><p>${html(user.global_name||user.username)} has been linked successfully.</p><p>You can close this window and return to Sterling Tracker.</p></body></html>`);
  }catch(e){p.status="error";p.error=String(e.message||e);res.status(400).type("html").send(`<h2>Sterling Tracker login failed</h2><p>${html(p.error)}</p>`);}
});
app.post("/auth/desktop/logout",async(req,res)=>{const h=String(req.headers.authorization||"");const token=h.startsWith("Bearer ")?h.slice(7):"";if(token)await pool.execute("UPDATE desktop_sessions SET revoked_at=NOW() WHERE token_hash=?",[sha256(token)]);res.json({ok:true});});

app.get("/api/desktop/me",async(req,res)=>{try{const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Session expired"});res.json({ok:true,driver:{sterlingDriverId:d.sterling_driver_id,discordUsername:d.discord_username,rank:d.rank_name,totalMiles:Number(d.total_miles||0),jobsCompleted:Number(d.jobs_completed||0)}});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}});
app.get("/api/tracker/jobs",async(req,res)=>{try{const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Session expired"});const[r]=await pool.execute("SELECT job_code,status,cargo,origin_city,destination_city,distance_miles,income,started_at,completed_at FROM jobs WHERE driver_id=? ORDER BY id DESC LIMIT 20",[d.driver_id]);res.json({ok:true,jobs:r});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}});

app.get("/api/tracker/payout",async(req,res)=>{try{const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});const[r]=await pool.execute("SELECT id,amount,requested_at FROM ets2_payouts WHERE driver_id=? AND status='pending' ORDER BY requested_at ASC LIMIT 1",[d.driver_id]);res.json({ok:true,payout:r[0]||null});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}});
app.post("/api/tracker/payout/:id/complete",async(req,res)=>{try{const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});const id=Number(req.params.id);const[r]=await pool.execute("UPDATE ets2_payouts SET status='applied',applied_at=NOW(),save_path=?,error_text=NULL WHERE id=? AND driver_id=? AND status='pending'",[String(req.body?.savePath||'').slice(0,500),id,d.driver_id]);if(r.affectedRows){await pool.execute("UPDATE driver_wallets SET total_withdrawn=total_withdrawn+(SELECT amount FROM ets2_payouts WHERE id=?) WHERE driver_id=?",[id,d.driver_id]);}res.json({ok:r.affectedRows>0});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}});
app.post("/api/tracker/payout/:id/fail",async(req,res)=>{try{const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});await pool.execute("UPDATE ets2_payouts SET error_text=? WHERE id=? AND driver_id=? AND status='pending'",[String(req.body?.error||'Unknown error').slice(0,1000),Number(req.params.id),d.driver_id]);res.json({ok:true});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}});

app.post("/api/tracker/telemetry",async(req,res)=>{
  try{
    const d=await auth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
    const body=req.body||{},data=body.data||{},eventType=String(body.eventType||"heartbeat").slice(0,80),sessionCode=String(body.sessionCode||`drv-${d.driver_id}`).slice(0,120),status=String(body.status||"online").slice(0,50);
    let[ss]=await pool.execute("SELECT id,status FROM telemetry_sessions WHERE session_code=? LIMIT 1",[sessionCode]);let sessionId;
    if(!ss[0]){const[r]=await pool.execute("INSERT INTO telemetry_sessions(session_code,driver_id,status) VALUES(?,?,?)",[sessionCode,d.driver_id,status]);sessionId=r.insertId;}else{sessionId=ss[0].id;await pool.execute("UPDATE telemetry_sessions SET status=?,last_seen_at=NOW(),ended_at=IF(?='offline',NOW(),NULL) WHERE id=?",[status,status,sessionId]);}
    await pool.execute("INSERT INTO telemetry_events(session_id,driver_id,event_type,direct_event,event_json) VALUES(?,?,?,?,?)",[sessionId,d.driver_id,eventType,body.directEvent?1:0,JSON.stringify(data)]);
    const speedMph=number(data.speedMps??data.speed)*2.2369362921;
    await pool.execute(`INSERT INTO live_telemetry(driver_id,session_code,status,game,truck,cargo,source_city,destination_city,speed_mph,latitude,longitude,raw_json,last_seen_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW()) ON DUPLICATE KEY UPDATE session_code=VALUES(session_code),status=VALUES(status),game=VALUES(game),truck=VALUES(truck),cargo=VALUES(cargo),source_city=VALUES(source_city),destination_city=VALUES(destination_city),speed_mph=VALUES(speed_mph),latitude=VALUES(latitude),longitude=VALUES(longitude),raw_json=VALUES(raw_json),last_seen_at=NOW()`,
      [d.driver_id,sessionCode,status,data.game||"ETS2",safeText(data.truck,200),safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity),speedMph,data.latitude??null,data.longitude??null,JSON.stringify(data)]);

    let persistedJob=null,approval=null;
    const code=jobCode(d.driver_id,sessionCode,data);
    if(eventType==="job-started"){
      const[active]=await pool.execute("SELECT id,job_code FROM jobs WHERE driver_id=? AND status='in_progress' ORDER BY id DESC LIMIT 1",[d.driver_id]);
      if(active[0]){await pool.execute("UPDATE jobs SET truck_model=COALESCE(?,truck_model),cargo=COALESCE(?,cargo),origin_city=COALESCE(?,origin_city),destination_city=COALESCE(?,destination_city) WHERE id=?",[safeText(data.truck,200),safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity),active[0].id]);persistedJob={jobCode:active[0].job_code,status:"in_progress",reused:true};}
      else{await pool.execute("INSERT INTO jobs(job_code,driver_id,truck_model,cargo,origin_city,destination_city,status,started_at) VALUES(?,?,?,?,?,?,'in_progress',NOW()) ON DUPLICATE KEY UPDATE status=IF(status IN ('completed','rejected'),status,'in_progress')",[code,d.driver_id,safeText(data.truck,200),safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity)]);persistedJob={jobCode:code,status:"in_progress"};}
    }
    if(eventType==="job-delivered"){
      const miles=Math.max(0,number(data.distanceKm||data.jobDeliveredDistanceKm))*0.621371,revenue=Math.max(0,number(data.revenue||data.jobDeliveredRevenue)),damage=Math.max(number(data.truckDamage),number(data.trailerDamage),number(data.cargoDamage));
      const[active]=await pool.execute("SELECT id,job_code FROM jobs WHERE driver_id=? AND status='in_progress' ORDER BY id DESC LIMIT 1",[d.driver_id]);const finalCode=active[0]?.job_code||code;
      if(active[0])await pool.execute("UPDATE jobs SET cargo=COALESCE(?,cargo),origin_city=COALESCE(?,origin_city),destination_city=COALESCE(?,destination_city),distance_miles=?,income=?,truck_damage=?,trailer_damage=?,cargo_damage=?,status='pending_review',completed_at=NOW() WHERE id=?",[safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity),miles,revenue,number(data.truckDamage),number(data.trailerDamage),number(data.cargoDamage),active[0].id]);
      else await pool.execute("INSERT INTO jobs(job_code,driver_id,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,status,started_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,'pending_review',NOW(),NOW()) ON DUPLICATE KEY UPDATE status=IF(status IN ('completed','rejected'),status,'pending_review'),completed_at=COALESCE(completed_at,NOW())",[finalCode,d.driver_id,safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity),miles,revenue,number(data.truckDamage),number(data.trailerDamage),number(data.cargoDamage)]);
      persistedJob={jobCode:finalCode,status:"pending_review"};
      const ref=`tracker:${finalCode}`,payment=Math.round(revenue*DRIVER_PAY_RATE*100)/100;
      try{const[r]=await pool.execute("INSERT INTO tracked_job_approvals(job_code,driver_id,session_id,reference_key,cargo,origin_city,destination_city,distance_miles,revenue,driver_payment,damage) VALUES(?,?,?,?,?,?,?,?,?,?,?)",[finalCode,d.driver_id,sessionId,ref,safeText(data.cargo),safeText(data.sourceCity),safeText(data.destinationCity),miles,revenue,payment,damage]);const approvalCode=`SL-JA-${String(r.insertId).padStart(5,"0")}`;await pool.execute("UPDATE tracked_job_approvals SET approval_code=? WHERE id=?",[approvalCode,r.insertId]);approval={approvalCode,status:"pending",payment};}catch(e){if(e.code!=="ER_DUP_ENTRY")throw e;const[r]=await pool.execute("SELECT approval_code,status,driver_payment FROM tracked_job_approvals WHERE reference_key=? LIMIT 1",[ref]);approval={approvalCode:r[0]?.approval_code,status:r[0]?.status,payment:number(r[0]?.driver_payment)};}
    }
    if(eventType==="job-cancelled"){await pool.execute("UPDATE jobs SET status='cancelled' WHERE driver_id=? AND status='in_progress'",[d.driver_id]);persistedJob={jobCode:code,status:"cancelled"};}
    res.json({ok:true,service:"sterling-tracker-api-v2",sessionId,persistedJob,approval,driver:d.sterling_driver_id});
  }catch(e){console.error("[Telemetry]",e);res.status(400).json({ok:false,error:String(e.message||e)});}
});

await ensureSchema();
const[c]=await pool.query("SELECT DATABASE() db,CURRENT_USER() user");
console.log(`[Tracker API v2] DB connected to ${c[0].db} as ${c[0].user}`);
app.listen(PORT,"0.0.0.0",()=>console.log(`[Tracker API v2] Listening on ${PORT} • Discord bot login disabled • driver pay ${Math.round(DRIVER_PAY_RATE*100)}%`));