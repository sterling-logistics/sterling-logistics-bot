import crypto from "node:crypto";
import {MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";

const hash=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const safeJson=v=>JSON.parse(JSON.stringify(v,(k,x)=>typeof x==="bigint"?x.toString():x));

export async function issueTrackerKey(i){
  const[d]=await db().execute("SELECT id,sterling_driver_id FROM drivers WHERE discord_id=? AND status<>'left' LIMIT 1",[i.user.id]);
  const driver=d[0];
  if(!driver)return i.reply({content:"You need an active Sterling driver profile before a tracker key can be issued.",flags:MessageFlags.Ephemeral});
  const token=`sltrk_${crypto.randomBytes(24).toString("hex")}`;
  await db().execute("INSERT INTO tracker_tokens(driver_id,token_hash,created_at,revoked_at) VALUES(?,?,NOW(),NULL) ON DUPLICATE KEY UPDATE token_hash=VALUES(token_hash),created_at=NOW(),last_used_at=NULL,revoked_at=NULL",[driver.id,hash(token)]);
  await i.reply({content:`**Sterling Tracker key for ${driver.sterling_driver_id}**\n\n\`${token}\`\n\nKeep this private. Generating another key replaces this one.`,flags:MessageFlags.Ephemeral});
}

export async function authenticateTracker(token){
  if(!token)return null;
  const[r]=await db().execute("SELECT tt.driver_id,d.sterling_driver_id,d.discord_username FROM tracker_tokens tt JOIN drivers d ON d.id=tt.driver_id WHERE tt.token_hash=? AND tt.revoked_at IS NULL LIMIT 1",[hash(token)]);
  if(!r[0])return null;
  await db().execute("UPDATE tracker_tokens SET last_used_at=NOW() WHERE driver_id=?",[r[0].driver_id]);
  return r[0];
}

export async function ingestTrackerTelemetry(driverId,p){
  const sessionCode=String(p.sessionCode||`drv-${driverId}`);
  const status=String(p.status||"online").slice(0,50);
  const eventType=String(p.eventType||"heartbeat").slice(0,80);
  const data=safeJson(p.data||{});
  const[s]=await db().execute("SELECT * FROM telemetry_sessions WHERE session_code=? LIMIT 1",[sessionCode]);
  let sessionId;
  if(!s[0]){const[r]=await db().execute("INSERT INTO telemetry_sessions(session_code,driver_id,status) VALUES(?,?,?)",[sessionCode,driverId,status]);sessionId=r.insertId;}
  else{sessionId=s[0].id;await db().execute("UPDATE telemetry_sessions SET status=?,last_seen_at=NOW(),ended_at=IF(?='offline',NOW(),NULL) WHERE id=?",[status,status,sessionId]);}
  await db().execute("INSERT INTO telemetry_events(session_id,driver_id,event_type,direct_event,event_json) VALUES(?,?,?,?,?)",[sessionId,driverId,eventType,p.directEvent?1:0,JSON.stringify(data)]);
  const speedMps=Number(data.speedMps??data.speed??0)||0;
  const speedMph=speedMps*2.2369362921;
  await db().execute(`INSERT INTO live_telemetry(driver_id,session_code,status,game,truck,cargo,source_city,destination_city,speed_mph,latitude,longitude,raw_json,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE session_code=VALUES(session_code),status=VALUES(status),game=VALUES(game),truck=VALUES(truck),cargo=VALUES(cargo),source_city=VALUES(source_city),destination_city=VALUES(destination_city),speed_mph=VALUES(speed_mph),latitude=VALUES(latitude),longitude=VALUES(longitude),raw_json=VALUES(raw_json),last_seen_at=NOW()`,[
      driverId,sessionCode,status,data.game||"ETS2",data.truck||null,data.cargo||null,data.sourceCity||null,data.destinationCity||null,speedMph,data.latitude??null,data.longitude??null,JSON.stringify(data)
    ]);
  if(eventType==="job-delivered"){
    const miles=(Number(data.distanceKm||data.jobDeliveredDistanceKm||0)||0)*0.621371;
    const income=Number(data.revenue||data.jobDeliveredRevenue||0)||0;
    if(miles>0)await db().execute("UPDATE drivers SET total_miles=total_miles+?,monthly_miles=monthly_miles+?,jobs_completed=jobs_completed+1,total_income=total_income+? WHERE id=?",[miles,miles,income,driverId]);
  }
  return{ok:true,sessionId};
}

export async function ingestTelemetry(p){const{driverId}=p;if(!driverId)throw new Error("driverId required");return ingestTrackerTelemetry(driverId,p);}

export async function getLiveFleet(){const[r]=await db().query(`SELECT lt.*,d.sterling_driver_id,d.discord_username FROM live_telemetry lt JOIN drivers d ON d.id=lt.driver_id WHERE lt.status<>'offline' AND lt.last_seen_at >= (NOW()-INTERVAL 2 MINUTE) ORDER BY lt.last_seen_at DESC`);return r;}
