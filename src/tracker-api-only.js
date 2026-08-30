import dotenv from "dotenv";
import path from "node:path";
import {fileURLToPath} from "node:url";
import express from "express";
import {loadConfig} from "./config.js";
import {initDatabase,pingDatabase,ensureSchema,db} from "./database/mysql.js";
import {ensureEconomySchema,getPendingEts2Payout,completeEts2Payout,failEts2Payout} from "./economy/service.js";
import {ensureDispatchSchema} from "./dispatch/schema.js";
import {syncDispatchFromTelemetry} from "./dispatch/service.js";
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

async function dispatchAuth(req){
  const d=await trackerAuth(req);if(!d)return null;
  const[rows]=await db().execute("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,department,status FROM drivers WHERE id=? LIMIT 1",[d.driver_id]);
  const staff=rows[0];if(!staff)return null;
  const allowIds=String(process.env.DISPATCH_STAFF_DISCORD_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
  const text=`${staff.rank_name||""} ${staff.department||""}`.toLowerCase();
  const roleAllowed=/(owner|founder|director|manager|management|dispatcher|dispatch|operations|admin)/.test(text);
  if(!allowIds.includes(String(staff.discord_id))&&!roleAllowed)return false;
  return staff;
}

async function requireDispatch(req,res){
  const staff=await dispatchAuth(req);
  if(staff===null){res.status(401).json({ok:false,error:"Invalid Sterling desktop session"});return null;}
  if(staff===false){res.status(403).json({ok:false,error:"Your Sterling profile is not authorised for Dispatch Staff Edition"});return null;}
  return staff;
}

app.get("/health",async(_req,res)=>{
  try{
    const d=await pingDatabase();
    res.json({ok:true,mode:"tracker-api-only",discord:false,database:d.db,schemaReady,desktopLogin:Boolean(c.discordClientSecret&&c.applicationId),dispatchApi:true});
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

app.get("/api/dispatch/me",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid Sterling desktop session"});
    const staff=await dispatchAuth(req);
    res.setHeader("Cache-Control","no-store");
    res.json({ok:true,isStaff:Boolean(staff),profile:staff||{sterling_driver_id:d.sterling_driver_id,discord_username:d.discord_username,rank_name:d.rank_name}});
  }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
});

app.get("/api/dispatch/drivers",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const staff=await requireDispatch(req,res);if(!staff)return;
    const[rows]=await db().query("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,department,total_miles,jobs_completed FROM drivers WHERE status='active' ORDER BY sterling_driver_id ASC,discord_username ASC LIMIT 500");
    res.setHeader("Cache-Control","no-store");res.json({ok:true,drivers:rows});
  }catch(e){console.error("[Dispatch Drivers]",e);res.status(500).json({ok:false,error:"Could not load drivers"});}
});

app.get("/api/dispatch/assignments",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const staff=await requireDispatch(req,res);if(!staff)return;
    const mode=String(req.query.status||"active").toLowerCase();
    let sql="SELECT w.*,d.discord_id,d.discord_username,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id";
    const args=[];
    if(mode==="active")sql+=" WHERE w.status IN ('assigned','in_progress')";
    else if(["assigned","in_progress","completed","cancelled"].includes(mode)){sql+=" WHERE w.status=?";args.push(mode);}
    sql+=" ORDER BY CASE WHEN w.status='in_progress' THEN 0 WHEN w.status='assigned' THEN 1 ELSE 2 END,w.deadline_at IS NULL,w.deadline_at ASC,w.assigned_at DESC LIMIT 200";
    const[rows]=await db().execute(sql,args);
    res.setHeader("Cache-Control","no-store");res.json({ok:true,assignments:rows});
  }catch(e){console.error("[Dispatch Assignments]",e);res.status(500).json({ok:false,error:"Could not load dispatch assignments"});}
});

app.post("/api/dispatch/assignments",async(req,res)=>{
  try{
    if(!schemaReady)return res.status(503).json({ok:false,error:"Database schema is still starting"});
    const staff=await requireDispatch(req,res);if(!staff)return;
    const driverId=Number(req.body?.driverId||0),cargo=String(req.body?.cargo||"").trim(),origin=String(req.body?.origin||"").trim(),destination=String(req.body?.destination||"").trim();
    const minMiles=Math.max(0,Number(req.body?.minMiles||0)),notes=String(req.body?.notes||"").trim().slice(0,2000)||null;
    if(!driverId||!cargo||!origin||!destination)return res.status(400).json({ok:false,error:"Driver, cargo, origin and destination are required"});
    const[driverRows]=await db().execute("SELECT id,sterling_driver_id,discord_id FROM drivers WHERE id=? AND status='active' LIMIT 1",[driverId]);
    if(!driverRows[0])return res.status(404).json({ok:false,error:"Active Sterling driver not found"});
    let deadline=null;
    if(req.body?.deadline){const d=new Date(req.body.deadline);if(Number.isNaN(d.getTime()))return res.status(400).json({ok:false,error:"Deadline is not a valid date/time"});deadline=d;}
    const[r]=await db().execute("INSERT INTO work_assignments(driver_id,cargo,origin_city,destination_city,min_miles,deadline_at,notes,created_by) VALUES(?,?,?,?,?,?,?,?)",[driverId,cargo,origin,destination,minMiles,deadline,notes,String(staff.discord_id)]);
    const code=`SLW-${String(r.insertId).padStart(5,"0")}`;
    await db().execute("UPDATE work_assignments SET work_code=? WHERE id=?",[code,r.insertId]);
    await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[String(staff.discord_id),"dispatch_work_create",String(driverRows[0].discord_id),`${code} • ${cargo} • ${origin} -> ${destination}`]);
    res.status(201).json({ok:true,workCode:code});
  }catch(e){console.error("[Dispatch Create]",e);res.status(500).json({ok:false,error:String(e.message||e)});}
});

app.post("/api/dispatch/assignments/:code/cancel",async(req,res)=>{
  try{
    const staff=await requireDispatch(req,res);if(!staff)return;
    const code=String(req.params.code||"").toUpperCase(),reason=String(req.body?.reason||"Cancelled by dispatch").trim().slice(0,1000);
    const[r]=await db().execute("UPDATE work_assignments SET status='cancelled',verification_notes=? WHERE work_code=? AND status IN ('assigned','in_progress')",[reason,code]);
    if(!r.affectedRows)return res.status(404).json({ok:false,error:"Active assignment not found"});
    await db().execute("INSERT INTO audit_logs(actor_discord_id,action,details) VALUES(?,?,?)",[String(staff.discord_id),"dispatch_work_cancel",`${code} • ${reason}`]);
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
});

app.post("/api/dispatch/assignments/:code/reassign",async(req,res)=>{
  try{
    const staff=await requireDispatch(req,res);if(!staff)return;
    const code=String(req.params.code||"").toUpperCase(),driverId=Number(req.body?.driverId||0);
    const[d]=await db().execute("SELECT id,discord_id FROM drivers WHERE id=? AND status='active' LIMIT 1",[driverId]);if(!d[0])return res.status(404).json({ok:false,error:"Active Sterling driver not found"});
    const[r]=await db().execute("UPDATE work_assignments SET driver_id=?,status='assigned',started_at=NULL,completed_at=NULL,tracker_verified=0,verification_notes=NULL WHERE work_code=? AND status<>'cancelled'",[driverId,code]);
    if(!r.affectedRows)return res.status(404).json({ok:false,error:"Assignment not found"});
    await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[String(staff.discord_id),"dispatch_work_reassign",String(d[0].discord_id),code]);
    res.json({ok:true});
  }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
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
    const body=req.body||{};const eventType=String(body.eventType||"heartbeat"),data=body.data||{};
    const out=await ingestTrackerTelemetry(driver.driver_id,body);
    let persistedJob=null,dispatch=null;
    if(["job-started","job-delivered","job-cancelled"].includes(eventType)){
      try{persistedJob=await persistTrackerJobEvent(driver.driver_id,body);}catch(e){console.error("[Job Persistence]",e);}
      try{dispatch=await syncDispatchFromTelemetry(driver.driver_id,eventType,data);}catch(e){console.error("[Dispatch Sync]",e);}
    }
    res.json({...out,persistedJob,dispatch,driver:driver.sterling_driver_id});
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
