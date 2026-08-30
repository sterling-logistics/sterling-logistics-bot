import dotenv from "dotenv";
import express from "express";
import {initDatabase,pingDatabase,ensureSchema} from "./src/database/mysql.js";
import {ensureEconomySchema,getPendingEts2Payout,completeEts2Payout,failEts2Payout} from "./src/economy/service.js";
import {ensureWebsiteSchema,registerWebsiteRoutes} from "./src/web/site.js";
import {ensureApplicationSchema,registerApplicationRoutes} from "./src/web/applications.js";
import {registerPublicLiveRoutes} from "./src/web/public-live.js";
import {registerDesktopAuthRoutes,authenticateDesktopSession} from "./src/auth/desktop.js";
import {authenticateTracker,ingestTrackerTelemetry} from "./src/telemetry/service.js";
import {persistTrackerJobEvent} from "./src/jobs/persistence.js";
import {ensureDispatchStaffApiSchema,registerDispatchStaffRoutes} from "./src/dispatch/staff-api.js";

dotenv.config();

const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"512kb"}));

const required=["DISCORD_APPLICATION_ID","DISCORD_CLIENT_SECRET","PUBLIC_BASE_URL","DB_HOST","DB_USER","DB_PASSWORD"];
const missing=required.filter(k=>!process.env[k]?.trim());
let startupError=null;
let backendReady=false;
let config=null;

async function trackerAuth(req){
  const auth=String(req.headers.authorization||"");
  const token=auth.startsWith("Bearer ")?auth.slice(7):"";
  return (await authenticateTracker(token)) || (await authenticateDesktopSession(token));
}

if(!missing.length){
  config={
    applicationId:process.env.DISCORD_APPLICATION_ID.trim(),
    discordClientSecret:process.env.DISCORD_CLIENT_SECRET.trim(),
    publicBaseUrl:process.env.PUBLIC_BASE_URL.trim().replace(/\/$/,""),
    db:{
      host:process.env.DB_HOST.trim(),
      port:Number(process.env.DB_PORT||3306),
      database:(process.env.DB_NAME||"s248720_sterling_logistics").trim(),
      user:process.env.DB_USER.trim(),
      password:process.env.DB_PASSWORD
    },
    port:Number(process.env.PORT||3000)
  };

  try{
    initDatabase(config.db);
    await pingDatabase();
    await ensureSchema();
    await ensureWebsiteSchema();
    await ensureApplicationSchema();
    await ensureEconomySchema();
    await ensureDispatchStaffApiSchema();

    registerDesktopAuthRoutes(app,config);
    registerDispatchStaffRoutes(app,trackerAuth,{includeAssignments:true});

    app.get("/api/desktop/me",async(req,res)=>{
      try{
        const d=await trackerAuth(req);
        if(!d)return res.status(401).json({ok:false,error:"Session expired"});
        res.json({ok:true,driver:{
          sterlingDriverId:d.sterling_driver_id,
          discordUsername:d.discord_username,
          rank:d.rank_name||null,
          totalMiles:Number(d.total_miles||0),
          jobsCompleted:Number(d.jobs_completed||0)
        }});
      }catch(e){
        res.status(400).json({ok:false,error:String(e.message||e)});
      }
    });

    app.post("/api/tracker/telemetry",async(req,res)=>{
      try{
        const driver=await trackerAuth(req);
        if(!driver)return res.status(401).json({ok:false,error:"Invalid tracker session"});
        const body=req.body||{};
        const eventType=String(body.eventType||"heartbeat");
        const out=await ingestTrackerTelemetry(driver.driver_id,body);
        let persistedJob=null;
        if(["job-started","job-delivered","job-cancelled"].includes(eventType)){
          persistedJob=await persistTrackerJobEvent(driver.driver_id,body);
        }
        res.json({...out,persistedJob,driver:driver.sterling_driver_id});
      }catch(e){
        console.error("[Sterling Web Tracker API]",e);
        res.status(400).json({ok:false,error:String(e.message||e)});
      }
    });

    app.get("/api/tracker/jobs",async(req,res)=>{
      try{
        const d=await trackerAuth(req);
        if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
        const {db}=await import("./src/database/mysql.js");
        const[rows]=await db().execute(`SELECT job_code,status,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,started_at,completed_at,created_at FROM jobs WHERE driver_id=? ORDER BY COALESCE(completed_at,created_at) DESC LIMIT 100`,[d.driver_id]);
        res.setHeader("Cache-Control","no-store");res.json({ok:true,jobs:rows});
      }catch(e){res.status(500).json({ok:false,error:"Could not load tracker job history"});}
    });

    app.get("/api/tracker/payout",async(req,res)=>{
      try{
        const d=await trackerAuth(req);
        if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
        res.json({ok:true,payout:await getPendingEts2Payout(d.driver_id)});
      }catch(e){
        res.status(400).json({ok:false,error:String(e.message||e)});
      }
    });

    app.post("/api/tracker/payout/:id/complete",async(req,res)=>{
      try{
        const d=await trackerAuth(req);
        if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
        res.json({ok:await completeEts2Payout(d.driver_id,Number(req.params.id),req.body?.savePath)});
      }catch(e){
        res.status(400).json({ok:false,error:String(e.message||e)});
      }
    });

    app.post("/api/tracker/payout/:id/fail",async(req,res)=>{
      try{
        const d=await trackerAuth(req);
        if(!d)return res.status(401).json({ok:false,error:"Invalid tracker session"});
        await failEts2Payout(d.driver_id,Number(req.params.id),req.body?.error);
        res.json({ok:true});
      }catch(e){
        res.status(400).json({ok:false,error:String(e.message||e)});
      }
    });

    registerApplicationRoutes(app,config);
    registerPublicLiveRoutes(app);
    registerWebsiteRoutes(app,config);
    backendReady=true;
  }catch(e){
    startupError=e;
    console.error("[Sterling Web Startup]",e);
  }
}

app.get("/health",async(_req,res)=>{
  if(missing.length){
    return res.status(503).json({ok:false,service:"sterling-web",stage:"configuration",missing});
  }
  if(!backendReady){
    return res.status(503).json({
      ok:false,
      service:"sterling-web",
      stage:"startup",
      error:startupError?.code||startupError?.name||"BACKEND_STARTUP_FAILED",
      message:String(startupError?.message||"Backend startup failed").slice(0,240)
    });
  }
  try{
    const d=await pingDatabase();
    res.json({ok:true,service:"sterling-web",database:d.db,discord:true,desktopLogin:true,trackerApi:true,dispatchApi:true,staffJobApprovals:true,staffPayouts:true});
  }catch(e){
    res.status(503).json({ok:false,service:"sterling-web",stage:"database",error:e?.code||"DATABASE_UNAVAILABLE"});
  }
});

if(!backendReady){
  app.get("/auth/web/discord",(_req,res)=>res.status(503).type("html").send(`<!doctype html><meta charset="utf-8"><title>Sterling Login Unavailable</title><style>body{margin:0;background:#05070a;color:#eef6fc;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.box{max-width:650px;padding:34px;border:1px solid #233746;border-radius:16px;background:#0b121a}h1{margin-top:0}code{color:#7fd2ff}</style><div class="box"><h1>Sterling login is temporarily unavailable</h1><p>The Node backend is running, but its server configuration is incomplete or the database could not start.</p><p>Open <code>/health</code> to see the safe diagnostic status.</p></div>`));
}

const port=Number(process.env.PORT||3000);
app.listen(port,"0.0.0.0",()=>console.log(`[Sterling Web] Listening on ${port}${backendReady?" (ready + tracker/dispatch API)":" (diagnostic mode)"}`));
