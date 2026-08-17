import crypto from 'node:crypto';
import {db} from '../database/mysql.js';

const clean=(v,max=500)=>String(v??'').trim().slice(0,max);
const ipHash=req=>crypto.createHash('sha256').update(String(req.ip||req.socket?.remoteAddress||'unknown')).digest('hex');
const code=()=>`SL-${new Date().getFullYear()}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

export async function ensureApplicationSchema(){
  await db().query(`CREATE TABLE IF NOT EXISTS recruitment_applications(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    application_code VARCHAR(32) NOT NULL UNIQUE,
    discord_username VARCHAR(100) NOT NULL,
    discord_id VARCHAR(32) NULL,
    age TINYINT UNSIGNED NOT NULL,
    country VARCHAR(100) NOT NULL,
    timezone VARCHAR(80) NULL,
    ets2_hours INT UNSIGNED NOT NULL DEFAULT 0,
    truckersmp VARCHAR(255) NOT NULL,
    previous_vtc VARCHAR(255) NULL,
    preferred_truck VARCHAR(100) NULL,
    availability VARCHAR(100) NOT NULL,
    why_sterling TEXT NOT NULL,
    experience TEXT NOT NULL,
    convoy_experience TEXT NULL,
    additional_notes TEXT NULL,
    status ENUM('pending','reviewing','accepted','declined','withdrawn') NOT NULL DEFAULT 'pending',
    ip_hash CHAR(64) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX(status,created_at),INDEX(discord_username),INDEX(ip_hash,created_at))`);
}

async function notifyDiscord(c,a){
  const webhook=process.env.RECRUITMENT_WEBHOOK_URL?.trim();if(!webhook)return;
  const fields=[
    {name:'Applicant',value:a.discordUsername,inline:true},{name:'Age / Country',value:`${a.age} • ${a.country}`,inline:true},
    {name:'ETS2 hours',value:String(a.ets2Hours),inline:true},{name:'Availability',value:a.availability,inline:true},
    {name:'TruckersMP',value:a.truckersMp.slice(0,1024)},{name:'Why Sterling?',value:a.whySterling.slice(0,1024)},
    {name:'Experience',value:a.experience.slice(0,1024)}];
  try{await fetch(webhook,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'Sterling Recruitment',embeds:[{title:`New application • ${a.applicationCode}`,color:2795509,fields,timestamp:new Date().toISOString(),footer:{text:'Sterling Logistics Recruitment'}}]})});}catch(e){console.error('[Recruitment webhook]',e.message)}
}

export function registerApplicationRoutes(app,c){
  app.post('/api/public/applications',async(req,res)=>{
    try{
      if(clean(req.body?.website,200))return res.status(200).json({ok:true});
      const a={discordUsername:clean(req.body?.discordUsername,100),discordId:clean(req.body?.discordId,32)||null,age:Number(req.body?.age),country:clean(req.body?.country,100),timezone:clean(req.body?.timezone,80)||null,ets2Hours:Number(req.body?.ets2Hours),truckersMp:clean(req.body?.truckersMp,255),previousVtc:clean(req.body?.previousVtc,255)||null,preferredTruck:clean(req.body?.preferredTruck,100)||null,availability:clean(req.body?.availability,100),whySterling:clean(req.body?.whySterling,1800),experience:clean(req.body?.experience,1800),convoyExperience:clean(req.body?.convoyExperience,1200)||null,additionalNotes:clean(req.body?.additionalNotes,1200)||null};
      if(!a.discordUsername||!a.country||!a.truckersMp||!a.availability||a.whySterling.length<30||a.experience.length<20||!Number.isFinite(a.age)||a.age<13||a.age>99||!Number.isFinite(a.ets2Hours)||a.ets2Hours<0)return res.status(400).json({ok:false,error:'Please complete all required application fields.'});
      if(req.body?.agreementRules!==true||req.body?.agreementTruth!==true)return res.status(400).json({ok:false,error:'You must accept the recruitment declarations.'});
      const ip=ipHash(req);const[recent]=await db().execute("SELECT COUNT(*) count FROM recruitment_applications WHERE ip_hash=? AND created_at>NOW()-INTERVAL 24 HOUR",[ip]);if(Number(recent[0]?.count||0)>=3)return res.status(429).json({ok:false,error:'Too many applications from this connection. Please try again later.'});
      const applicationCode=code();a.applicationCode=applicationCode;
      await db().execute(`INSERT INTO recruitment_applications(application_code,discord_username,discord_id,age,country,timezone,ets2_hours,truckersmp,previous_vtc,preferred_truck,availability,why_sterling,experience,convoy_experience,additional_notes,ip_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,[applicationCode,a.discordUsername,a.discordId,a.age,a.country,a.timezone,a.ets2Hours,a.truckersMp,a.previousVtc,a.preferredTruck,a.availability,a.whySterling,a.experience,a.convoyExperience,a.additionalNotes,ip]);
      await notifyDiscord(c,a);res.status(201).json({ok:true,applicationCode,status:'pending'});
    }catch(e){console.error('[Recruitment application]',e);res.status(500).json({ok:false,error:'Could not submit application right now.'});}
  });
}
