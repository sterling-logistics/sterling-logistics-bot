import crypto from "node:crypto";
import path from "node:path";
import {fileURLToPath} from "node:url";
import express from "express";
import {db} from "../database/mysql.js";
import {calculateDriveScore,getDriverEconomy} from "../economy/service.js";
import {authenticateTracker} from "../telemetry/service.js";
import {authenticateDesktopSession} from "../auth/desktop.js";
import {registerPublicLiveRoutes} from "./public-live.js";

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const publicDir=path.resolve(__dirname,"../../website");
const hash=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const cookieName="sterling_web";
const parseCookies=req=>Object.fromEntries(String(req.headers.cookie||"").split(";").map(x=>x.trim()).filter(Boolean).map(x=>{const i=x.indexOf("=");return[decodeURIComponent(i<0?x:x.slice(0,i)),decodeURIComponent(i<0?"":x.slice(i+1))]}));
const avatarUrl=(discordId,avatarHash)=>avatarHash?`https://cdn.discordapp.com/avatars/${discordId}/${avatarHash}.png?size=256`:null;

export async function ensureWebsiteSchema(){
  await db().query(`CREATE TABLE IF NOT EXISTS web_oauth_states(
    state_hash CHAR(64) PRIMARY KEY,
    next_path VARCHAR(200) NOT NULL DEFAULT '/dashboard',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP NOT NULL,
    INDEX(expires_at))`);
  await db().query(`CREATE TABLE IF NOT EXISTS web_sessions(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    driver_id BIGINT UNSIGNED NOT NULL,
    token_hash CHAR(64) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_used_at TIMESTAMP NULL,
    expires_at TIMESTAMP NOT NULL,
    revoked_at TIMESTAMP NULL,
    INDEX(driver_id,revoked_at),INDEX(expires_at))`);
  try{await db().query("ALTER TABLE drivers ADD COLUMN discord_avatar VARCHAR(255) NULL");}catch(e){if(e.code!=="ER_DUP_FIELDNAME")throw e;}
}

async function webSession(req){
  const token=parseCookies(req)[cookieName];if(!token)return null;
  const[r]=await db().execute(`SELECT ws.id session_id,d.* FROM web_sessions ws JOIN drivers d ON d.id=ws.driver_id
    WHERE ws.token_hash=? AND ws.revoked_at IS NULL AND ws.expires_at>NOW() AND d.status<>'left' LIMIT 1`,[hash(token)]);
  if(!r[0])return null;
  await db().execute("UPDATE web_sessions SET last_used_at=NOW() WHERE id=?",[r[0].session_id]);
  return r[0];
}

async function trackerSession(req){
  const auth=String(req.headers.authorization||"");
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  if(!token)return null;
  return(await authenticateTracker(token))||(await authenticateDesktopSession(token));
}

function setSessionCookie(res,token,c){
  const secure=String(c.publicBaseUrl||"").startsWith("https://");
  res.setHeader("Set-Cookie",`${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60*60*24*7}${secure?"; Secure":""}`);
}
function clearSessionCookie(res,c){const secure=String(c.publicBaseUrl||"").startsWith("https://");res.setHeader("Set-Cookie",`${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure?"; Secure":""}`);}

export function registerWebsiteRoutes(app,c){
  app.use(express.static(publicDir,{extensions:["html"],index:"index.html"}));
  registerPublicLiveRoutes(app);

  app.get("/api/public/overview",async(_req,res)=>{
    try{
      const[[drivers],[jobs],[distance],[live],[convoys],[activity]]=await Promise.all([
        db().query("SELECT COUNT(*) count FROM drivers WHERE status='active'"),
        db().query("SELECT COUNT(*) count FROM jobs WHERE status='completed'"),
        db().query("SELECT COALESCE(SUM(distance_miles),0) miles FROM jobs WHERE status='completed'"),
        db().query("SELECT COUNT(*) count FROM live_telemetry WHERE status<>'offline' AND last_seen_at>=NOW()-INTERVAL 2 MINUTE"),
        db().query("SELECT convoy_code,name,event_date,meetup_time,departure_time,departure_city,destination,server_name,dlc_requirements FROM convoys WHERE event_date>=CURDATE() ORDER BY event_date ASC LIMIT 3"),
        db().query(`SELECT j.id,j.completed_at,j.cargo,j.origin_city,j.destination_city,j.distance_miles,j.income,d.sterling_driver_id,d.discord_username
          FROM jobs j JOIN drivers d ON d.id=j.driver_id WHERE j.status='completed' ORDER BY COALESCE(j.completed_at,j.created_at) DESC LIMIT 6`)
      ]);
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,stats:{drivers:Number(drivers[0]?.count||0),jobs:Number(jobs[0]?.count||0),miles:Number(distance[0]?.miles||0),live:Number(live[0]?.count||0)},convoys,activity});
    }catch(e){res.status(500).json({ok:false,error:"Company data is temporarily unavailable"});}
  });

  app.get("/auth/web/discord",async(req,res)=>{
    try{
      if(!c.discordClientSecret||!c.publicBaseUrl)return res.status(503).send("Discord website login is not configured yet.");
      const state=crypto.randomBytes(32).toString("hex");
      const requested=String(req.query.next||"/dashboard");const next=requested.startsWith("/")&&!requested.startsWith("//")?requested:"/dashboard";
      await db().execute("DELETE FROM web_oauth_states WHERE expires_at<NOW()");
      await db().execute("INSERT INTO web_oauth_states(state_hash,next_path,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))",[hash(state),next.slice(0,200)]);
      const redirectUri=`${c.publicBaseUrl}/auth/web/discord/callback`;
      const url=new URL("https://discord.com/oauth2/authorize");
      url.searchParams.set("client_id",c.applicationId);url.searchParams.set("response_type","code");url.searchParams.set("redirect_uri",redirectUri);url.searchParams.set("scope","identify");url.searchParams.set("state",state);
      res.redirect(url.toString());
    }catch(e){console.error("[Website OAuth Start]",e);res.status(500).send("Could not start Discord sign in.");}
  });

  app.get("/auth/web/discord/callback",async(req,res)=>{
    const state=String(req.query.state||""),code=String(req.query.code||"");
    try{
      const[s]=await db().execute("SELECT next_path FROM web_oauth_states WHERE state_hash=? AND expires_at>NOW() LIMIT 1",[hash(state)]);
      if(!s[0]||!code)return res.redirect("/?login=expired");
      await db().execute("DELETE FROM web_oauth_states WHERE state_hash=?",[hash(state)]);
      const redirectUri=`${c.publicBaseUrl}/auth/web/discord/callback`;
      const form=new URLSearchParams({grant_type:"authorization_code",code,redirect_uri:redirectUri});
      const basic=Buffer.from(`${c.applicationId}:${c.discordClientSecret}`,"utf8").toString("base64");
      const tokenRes=await fetch("https://discord.com/api/v10/oauth2/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Authorization":`Basic ${basic}`},body:form});
      const tokenText=await tokenRes.text();
      if(!tokenRes.ok){
        let detail=tokenText;
        try{const j=JSON.parse(tokenText);detail=String(j.error_description||j.message||j.error||tokenText);}catch{}
        console.error("[Website OAuth Token Exchange]",{status:tokenRes.status,applicationId:c.applicationId,redirectUri,detail});
        throw new Error(`Discord token exchange failed (${tokenRes.status}): ${detail}`);
      }
      const oauth=JSON.parse(tokenText);
      const userRes=await fetch("https://discord.com/api/v10/users/@me",{headers:{Authorization:`Bearer ${oauth.access_token}`}});if(!userRes.ok)throw new Error("Discord identity lookup failed");
      const user=await userRes.json();
      const[d]=await db().execute("SELECT * FROM drivers WHERE discord_id=? AND status<>'left' LIMIT 1",[String(user.id)]);const driver=d[0];
      if(!driver)return res.redirect("/?login=not-driver");
      const name=String(user.global_name||user.username||driver.discord_username||"").slice(0,100),avatar=String(user.avatar||"").slice(0,255)||null;
      await db().execute("UPDATE drivers SET discord_username=?,discord_avatar=? WHERE id=?",[name,avatar,driver.id]);
      const token=`slweb_${crypto.randomBytes(32).toString("hex")}`;
      await db().execute("INSERT INTO web_sessions(driver_id,token_hash,expires_at) VALUES(?,?,DATE_ADD(NOW(),INTERVAL 7 DAY))",[driver.id,hash(token)]);
      setSessionCookie(res,token,c);res.redirect(s[0].next_path||"/dashboard");
    }catch(e){console.error("[Website OAuth]",e);res.redirect("/?login=failed");}
  });

  app.post("/auth/web/logout",async(req,res)=>{const token=parseCookies(req)[cookieName];if(token)await db().execute("UPDATE web_sessions SET revoked_at=NOW() WHERE token_hash=?",[hash(token)]);clearSessionCookie(res,c);res.json({ok:true});});

  app.get("/api/web/me",async(req,res)=>{
    try{
      const d=await webSession(req);if(!d)return res.status(401).json({ok:false,error:"Not signed in"});
      const[[liveRows],[jobRows],score,economy,[achievementRows]]=await Promise.all([
        db().execute("SELECT * FROM live_telemetry WHERE driver_id=? LIMIT 1",[d.id]),
        db().execute("SELECT * FROM jobs WHERE driver_id=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 25",[d.id]),
        calculateDriveScore(d.id),getDriverEconomy(d.id),
        db().execute("SELECT name,description,awarded_at FROM achievements WHERE driver_id=? ORDER BY awarded_at DESC LIMIT 8",[d.id])
      ]);
      const live=liveRows[0]||null;let raw={};try{raw=typeof live?.raw_json==="string"?JSON.parse(live.raw_json):(live?.raw_json||{});}catch{}
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,serverTime:new Date().toISOString(),driver:{sterlingDriverId:d.sterling_driver_id,discordId:d.discord_id,name:d.discord_username,avatar:avatarUrl(d.discord_id,d.discord_avatar),rank:d.rank_name,status:d.status,totalMiles:Number(d.total_miles||0),monthlyMiles:Number(d.monthly_miles||0),jobsCompleted:Number(d.jobs_completed||0),totalIncome:Number(d.total_income||0),driveScore:score,economy},live:live?{status:live.status,truck:live.truck,cargo:live.cargo,origin:live.source_city,destination:live.destination_city,speedMph:Number(live.speed_mph||0),lastSeenAt:live.last_seen_at,distanceKm:Number(raw.distanceKm||0),revenue:Number(raw.revenue||0),engineRpm:Number(raw.engineRpm||0),speedLimitMph:Number(raw.speedLimitMph||0),fuelLiters:Number(raw.fuelLiters||0),truckDamage:Number(raw.truckDamage||0),trailerDamage:Number(raw.trailerDamage||0),cargoDamage:Number(raw.cargoDamage||0),onJob:Boolean(raw.onJob)}:null,jobs:jobRows,achievements:achievementRows});
    }catch(e){console.error("[Website Me]",e);res.status(500).json({ok:false,error:"Could not load driver dashboard"});}
  });

  app.get("/api/tracker/jobs",async(req,res)=>{
    try{
      const d=await trackerSession(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
      const[rows]=await db().execute(`SELECT job_code,status,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,started_at,completed_at,created_at FROM jobs WHERE driver_id=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 100`,[d.driver_id]);
      res.setHeader("Cache-Control","no-store");res.json({ok:true,jobs:rows});
    }catch(e){console.error("[Tracker Jobs]",e);res.status(500).json({ok:false,error:"Could not load tracker job history"});}
  });

  app.get("/downloads/tracker",async(_req,res)=>{
    try{
      const r=await fetch("https://api.github.com/repos/sterling-logistics/sterling-logistics-bot/releases/latest",{headers:{Accept:"application/vnd.github+json","User-Agent":"Sterling-Logistics-Website"}});
      if(r.ok){const release=await r.json();const asset=(release.assets||[]).find(x=>/\.exe$/i.test(x.name))||(release.assets||[]).find(x=>/setup|installer/i.test(x.name));if(asset?.browser_download_url)return res.redirect(asset.browser_download_url);}
    }catch{}
    res.redirect("https://github.com/sterling-logistics/sterling-logistics-bot/releases/latest");
  });

  app.get("/dashboard",(_req,res)=>res.sendFile(path.join(publicDir,"dashboard.html")));
}
