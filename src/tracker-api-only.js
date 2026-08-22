import dotenv from "dotenv";
import path from "node:path";
import {fileURLToPath} from "node:url";
import express from "express";
import {loadConfig} from "./config.js";
import {initDatabase,pingDatabase,ensureSchema,db} from "./database/mysql.js";
import {ensureEconomySchema,getPendingEts2Payout,completeEts2Payout,failEts2Payout} from "./economy/service.js";
import {ensureDispatchSchema} from "./dispatch/schema.js";
import {registerDesktopAuthRoutes,authenticateDesktopSession} from "./auth/desktop.js";
import {authenticateTracker,ingestTrackerTelemetry,ingestTelemetry} from "./telemetry/service.js";
import {persistTrackerJobEvent} from "./jobs/persistence.js";

const envPath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../.env");
const envResult=dotenv.config({path:envPath});
if(envResult.error)console.warn(`[Config] Could not load ${envPath}: ${envResult.error.message}`);else console.log(`[Config] Loaded environment from ${envPath}`);

const c=loadConfig();
initDatabase(c.db);
const app=express();
let schemaReady=false;
app.use(express.json({limit:"512kb"}));
registerDesktopAuthRoutes(app,c);

async function trackerAuth(req){
  const auth=String(req.headers.authorization||"");
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  return(await authenticateTracker(token))||(await authenticateDesktopSession(token));
}

app.get("/health",async(_req,res)=>{
  try{
    const d=await pingDatabase();
    res.json({ok:true,mode:"tracker-api-only",discord:false,database:d.db,schemaReady,desktopLogin:Boolean(c.discordClientSecret&&c.applicationId)});
  }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
});

app.post("/api/telemetry",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    if(!c.telemetryApiSecret)return res.status(503).json({ok:false,error:"Telemetry API not enabled"});
    if(req.headers.authorization!==`Bearer ${c.telemetryApiSecret}`)return res.status(401).json({ok:false,error:"Unauthorized"});
    res.json(await ingestTelemetry(req.body));
  }catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}
});

app.get("/api/desktop/me",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false,error:"Session expired"});
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,driver:{sterlingDriverId:d.sterling_driver_id,discordUsername:d.discord_username,rank:d.rank_name||null,totalMiles:Number(d.total_miles||0),jobsCompleted:Number(d.jobs_completed||0)}});
  }catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}
});

app.get("/api/tracker/jobs",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
    const[rows]=await db().execute(`SELECT job_code,status,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,started_at,completed_at,created_at FROM jobs WHERE driver_id=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 100`,[d.driver_id]);
    res.setHeader("Cache-Control","no-store");res.json({ok:true,jobs:rows});
  }catch(e){console.error("[Tracker Jobs]",e);res.status(500).json({ok:false,error:"Could not load tracker job history"});}
});

app.get("/api/tracker/payout",async(req,res)=>{
  try{if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});res.json({ok:true,payout:await getPendingEts2Payout(d.driver_id)});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}
});
app.post("/api/tracker/payout/:id/complete",async(req,res)=>{
  try{const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false});res.json({ok:await completeEts2Payout(d.driver_id,Number(req.params.id),req.body?.savePath)});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}
});
app.post("/api/tracker/payout/:id/fail",async(req,res)=>{
  try{const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false});await failEts2Payout(d.driver_id,Number(req.params.id),req.body?.error);res.json({ok:true});}catch(e){res.status(400).json({ok:false,error:String(e.message||e)});}
});

app.post("/api/tracker/telemetry",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const driver=await trackerAuth(req);if(!driver)return res.status(401).json({ok:false,error:"Invalid tracker session"});
    const body=req.body||{};const eventType=String(body.eventType||"heartbeat");
    const out=await ingestTrackerTelemetry(driver.driver_id,body);
    let persistedJob=null;
    if(["job-started","job-delivered","job-cancelled"].includes(eventType)){
      try{persistedJob=await persistTrackerJobEvent(driver.driver_id,body);}catch(e){console.error("[Job Persistence]",e);}
    }
    res.json({...out,persistedJob,driver:driver.sterling_driver_id});
  }catch(e){console.error("[Tracker API]",e);res.status(400).json({ok:false,error:String(e.message||e)});}
});

app.listen(c.port,"0.0.0.0",()=>console.log(`[Tracker API] Listening on ${c.port}`));

(async()=>{
  try{
    const d=await pingDatabase();console.log(`[DB] Connected to ${d.db} as ${d.username}`);
    await ensureSchema();await ensureDispatchSchema();await ensureEconomySchema();
    schemaReady=true;
    console.log("[DB] MySQL schema ready");
    console.log("[Sterling] Tracker API-only host ready • Discord bot login disabled");
  }catch(e){schemaReady=false;console.error("[Tracker API Startup]",e);}
})();
