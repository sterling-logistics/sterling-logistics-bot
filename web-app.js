import dotenv from "dotenv";
import express from "express";
import {initDatabase,pingDatabase} from "./src/database/mysql.js";
import {ensureEconomySchema} from "./src/economy/service.js";
import {ensureWebsiteSchema,registerWebsiteRoutes} from "./src/web/site.js";
import {ensureApplicationSchema,registerApplicationRoutes} from "./src/web/applications.js";

dotenv.config();

const required=["DISCORD_APPLICATION_ID","DISCORD_CLIENT_SECRET","PUBLIC_BASE_URL","DB_HOST","DB_USER","DB_PASSWORD"];
const missing=required.filter(k=>!process.env[k]?.trim());
if(missing.length)throw new Error(`Missing web environment variables: ${missing.join(", ")}`);

const config={
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

initDatabase(config.db);
await pingDatabase();
await ensureWebsiteSchema();
await ensureApplicationSchema();
await ensureEconomySchema();

const app=express();
app.set("trust proxy",1);
app.use(express.json({limit:"256kb"}));
registerApplicationRoutes(app,config);
registerWebsiteRoutes(app,config);
app.get("/health",async(_req,res)=>{
  try{const d=await pingDatabase();res.json({ok:true,service:"sterling-web",database:d.db});}
  catch(e){res.status(500).json({ok:false,error:"Database unavailable"});}
});

app.listen(config.port,"0.0.0.0",()=>console.log(`[Sterling Web] Listening on ${config.port}`));
