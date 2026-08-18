import dotenv from "dotenv";
import express from "express";
import {initDatabase,pingDatabase} from "./src/database/mysql.js";
import {ensureEconomySchema} from "./src/economy/service.js";
import {ensureWebsiteSchema,registerWebsiteRoutes} from "./src/web/site.js";
import {ensureApplicationSchema,registerApplicationRoutes} from "./src/web/applications.js";
import {registerPublicLiveRoutes} from "./src/web/public-live.js";

dotenv.config();

const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"256kb"}));

const required=["DISCORD_APPLICATION_ID","DISCORD_CLIENT_SECRET","PUBLIC_BASE_URL","DB_HOST","DB_USER","DB_PASSWORD"];
const missing=required.filter(k=>!process.env[k]?.trim());
let startupError=null;
let backendReady=false;
let config=null;

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
    await ensureWebsiteSchema();
    await ensureApplicationSchema();
    await ensureEconomySchema();
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
    res.json({ok:true,service:"sterling-web",database:d.db,discord:true});
  }catch(e){
    res.status(503).json({ok:false,service:"sterling-web",stage:"database",error:e?.code||"DATABASE_UNAVAILABLE"});
  }
});

if(!backendReady){
  app.get("/auth/web/discord",(_req,res)=>res.status(503).type("html").send(`<!doctype html><meta charset="utf-8"><title>Sterling Login Unavailable</title><style>body{margin:0;background:#05070a;color:#eef6fc;font:16px system-ui;display:grid;place-items:center;min-height:100vh}.box{max-width:650px;padding:34px;border:1px solid #233746;border-radius:16px;background:#0b121a}h1{margin-top:0}code{color:#7fd2ff}</style><div class="box"><h1>Sterling login is temporarily unavailable</h1><p>The Node backend is running, but its server configuration is incomplete or the database could not start.</p><p>Open <code>/health</code> to see the safe diagnostic status.</p></div>`));
}

const port=Number(process.env.PORT||3000);
app.listen(port,"0.0.0.0",()=>console.log(`[Sterling Web] Listening on ${port}${backendReady?" (ready)":" (diagnostic mode)"}`));
