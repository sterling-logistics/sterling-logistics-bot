import crypto from "node:crypto";
import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";
import {syncDispatchFromTelemetry} from "../dispatch/service.js";

const hash=v=>crypto.createHash("sha256").update(String(v)).digest("hex");
const safeJson=v=>JSON.parse(JSON.stringify(v,(k,x)=>typeof x==="bigint"?x.toString():x));
const num=v=>Number(v)||0;
const hours=s=>`${(num(s)/3600).toFixed(1)}h`;

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
  const[r]=await db().execute("SELECT tt.driver_id,d.sterling_driver_id,d.discord_id,d.discord_username FROM tracker_tokens tt JOIN drivers d ON d.id=tt.driver_id WHERE tt.token_hash=? AND tt.revoked_at IS NULL LIMIT 1",[hash(token)]);
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
  const sessionBecameOnline=!s[0]||s[0].status!=="online";
  let sessionId;
  if(!s[0]){const[r]=await db().execute("INSERT INTO telemetry_sessions(session_code,driver_id,status) VALUES(?,?,?)",[sessionCode,driverId,status]);sessionId=r.insertId;}
  else{sessionId=s[0].id;await db().execute("UPDATE telemetry_sessions SET status=?,last_seen_at=NOW(),ended_at=IF(?='offline',NOW(),NULL) WHERE id=?",[status,status,sessionId]);}
  await db().execute("INSERT INTO telemetry_events(session_id,driver_id,event_type,direct_event,event_json) VALUES(?,?,?,?,?)",[sessionId,driverId,eventType,p.directEvent?1:0,JSON.stringify(data)]);

  const[prevRows]=await db().execute("SELECT raw_json,last_seen_at FROM live_telemetry WHERE driver_id=? LIMIT 1",[driverId]);
  const prev=prevRows[0];
  let prevData={};
  try{prevData=typeof prev?.raw_json==="string"?JSON.parse(prev.raw_json):(prev?.raw_json||{});}catch{}

  const speedMps=num(data.speedMps??data.speed);
  const speedMph=speedMps*2.2369362921;
  const fuel=num(data.fuelLiters);
  const prevFuel=num(prevData.fuelLiters);
  const truckDamage=num(data.truckDamage);
  const prevTruckDamage=num(prevData.truckDamage);
  const odometerKm=num(data.odometerKm);
  const prevOdometerKm=num(prevData.odometerKm);
  const engineOn=Boolean(data.engineOn);
  let elapsed=0;
  if(prev?.last_seen_at){elapsed=Math.max(0,Math.min(30,Math.round((Date.now()-new Date(prev.last_seen_at).getTime())/1000)));}
  const milesDelta=(odometerKm>prevOdometerKm&&odometerKm-prevOdometerKm<20)?(odometerKm-prevOdometerKm)*0.621371:0;
  const fuelUsed=(prevFuel>fuel&&prevFuel-fuel<10)?prevFuel-fuel:0;
  const fuelAdded=(fuel>prevFuel&&fuel-prevFuel>=5&&speedMph<3)?fuel-prevFuel:0;
  const damageDelta=(truckDamage>prevTruckDamage)?truckDamage-prevTruckDamage:0;
  const crashDetected=(damageDelta>=0.005)||["crash","collision"].includes(eventType);

  await db().execute(`INSERT INTO driver_metrics(driver_id,total_online_seconds,driving_seconds,idle_seconds,tracked_miles,fuel_used_liters,fuel_purchased_liters,fuel_stops,crashes,jobs_tracked,max_speed_mph)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE total_online_seconds=total_online_seconds+VALUES(total_online_seconds),driving_seconds=driving_seconds+VALUES(driving_seconds),idle_seconds=idle_seconds+VALUES(idle_seconds),tracked_miles=tracked_miles+VALUES(tracked_miles),fuel_used_liters=fuel_used_liters+VALUES(fuel_used_liters),fuel_purchased_liters=fuel_purchased_liters+VALUES(fuel_purchased_liters),fuel_stops=fuel_stops+VALUES(fuel_stops),crashes=crashes+VALUES(crashes),jobs_tracked=jobs_tracked+VALUES(jobs_tracked),max_speed_mph=GREATEST(max_speed_mph,VALUES(max_speed_mph))`,[
      driverId,elapsed,speedMph>1?elapsed:0,engineOn&&speedMph<=1?elapsed:0,milesDelta,fuelUsed,fuelAdded,fuelAdded>0?1:0,crashDetected?1:0,eventType==="job-delivered"?1:0,speedMph
    ]);

  if(fuelAdded>0)await db().execute("INSERT INTO fuel_stops(driver_id,session_id,liters_added,fuel_before,fuel_after,latitude,longitude) VALUES(?,?,?,?,?,?,?)",[driverId,sessionId,fuelAdded,prevFuel,fuel,data.latitude??null,data.longitude??null]);
  if(crashDetected)await db().execute("INSERT INTO driver_incidents(driver_id,session_id,event_type,speed_mph,truck_damage_before,truck_damage_after,damage_delta,latitude,longitude,details_json) VALUES(?,?,?,?,?,?,?,?,?,?)",[driverId,sessionId,"crash",speedMph,prevTruckDamage,truckDamage,damageDelta,data.latitude??null,data.longitude??null,JSON.stringify({eventType,data})]);

  await db().execute(`INSERT INTO live_telemetry(driver_id,session_code,status,game,truck,cargo,source_city,destination_city,speed_mph,latitude,longitude,raw_json,last_seen_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW())
    ON DUPLICATE KEY UPDATE session_code=VALUES(session_code),status=VALUES(status),game=VALUES(game),truck=VALUES(truck),cargo=VALUES(cargo),source_city=VALUES(source_city),destination_city=VALUES(destination_city),speed_mph=VALUES(speed_mph),latitude=VALUES(latitude),longitude=VALUES(longitude),raw_json=VALUES(raw_json),last_seen_at=NOW()`,[
      driverId,sessionCode,status,data.game||"ETS2",data.truck||null,data.cargo||null,data.sourceCity||null,data.destinationCity||null,speedMph,data.latitude??null,data.longitude??null,JSON.stringify(data)
    ]);
  if(eventType==="job-delivered"){
    const miles=(num(data.distanceKm||data.jobDeliveredDistanceKm))*0.621371;
    const income=num(data.revenue||data.jobDeliveredRevenue);
    if(miles>0)await db().execute("UPDATE drivers SET total_miles=total_miles+?,monthly_miles=monthly_miles+?,jobs_completed=jobs_completed+1,total_income=total_income+? WHERE id=?",[miles,miles,income,driverId]);
  }
  let dispatch=null;try{dispatch=await syncDispatchFromTelemetry(driverId,eventType,data);}catch(e){console.error("[Dispatch Sync]",e);}
  return{ok:true,sessionId,sessionBecameOnline,metrics:{elapsed,milesDelta,fuelUsed,fuelAdded,crashDetected,damageDelta},dispatch};
}

export async function markStaleTrackerSessionsOffline(staleSeconds=90){
  const seconds=Math.max(30,Math.min(600,Number(staleSeconds)||90));
  const[r]=await db().query(`SELECT ts.driver_id,MAX(ts.last_seen_at) last_seen_at,d.sterling_driver_id,d.discord_id,d.discord_username,lt.raw_json
    FROM telemetry_sessions ts JOIN drivers d ON d.id=ts.driver_id LEFT JOIN live_telemetry lt ON lt.driver_id=ts.driver_id
    WHERE ts.status<>'offline' GROUP BY ts.driver_id,d.sterling_driver_id,d.discord_id,d.discord_username,lt.raw_json
    HAVING MAX(ts.last_seen_at)<DATE_SUB(NOW(),INTERVAL ${seconds} SECOND)`);
  const out=[];
  for(const x of r){
    await db().execute(`UPDATE telemetry_sessions SET status='offline',ended_at=COALESCE(ended_at,NOW()) WHERE driver_id=? AND status<>'offline' AND last_seen_at<DATE_SUB(NOW(),INTERVAL ${seconds} SECOND)`,[x.driver_id]);
    await db().execute("UPDATE live_telemetry SET status='offline' WHERE driver_id=?",[x.driver_id]);
    let data={};try{data=typeof x.raw_json==="string"?JSON.parse(x.raw_json):(x.raw_json||{});}catch{}
    out.push({driver_id:x.driver_id,sterling_driver_id:x.sterling_driver_id,discord_id:x.discord_id,discord_username:x.discord_username,last_seen_at:x.last_seen_at,data});
  }
  return out;
}

export async function ingestTelemetry(p){const{driverId}=p;if(!driverId)throw new Error("driverId required");return ingestTrackerTelemetry(driverId,p);}

export async function getLiveFleet(){const[r]=await db().query(`SELECT lt.*,d.sterling_driver_id,d.discord_username,dm.driving_seconds,dm.crashes,dm.fuel_stops FROM live_telemetry lt JOIN drivers d ON d.id=lt.driver_id LEFT JOIN driver_metrics dm ON dm.driver_id=d.id WHERE lt.status<>'offline' AND lt.last_seen_at >= (NOW()-INTERVAL 2 MINUTE) ORDER BY lt.last_seen_at DESC`);return r;}

export async function handleDrivingStats(i){
  const u=i.options.getUser("user")||i.user;
  const[r]=await db().execute(`SELECT d.sterling_driver_id,d.discord_id,d.discord_username,d.total_miles,d.jobs_completed,d.safety_score,dm.* FROM drivers d LEFT JOIN driver_metrics dm ON dm.driver_id=d.id WHERE d.discord_id=? LIMIT 1`,[u.id]);
  const x=r[0];
  if(!x)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const[f]=await db().execute("SELECT COUNT(*) incidents FROM driver_incidents WHERE driver_id=(SELECT id FROM drivers WHERE discord_id=? LIMIT 1) AND occurred_at>=DATE_FORMAT(NOW(),'%Y-%m-01')",[u.id]);
  await i.reply({embeds:[new EmbedBuilder().setTitle(`🚛 Driving Stats | ${x.sterling_driver_id}`).addFields(
    {name:"Driving Hours",value:hours(x.driving_seconds),inline:true},
    {name:"Online Hours",value:hours(x.total_online_seconds),inline:true},
    {name:"Idle Hours",value:hours(x.idle_seconds),inline:true},
    {name:"Tracked Miles",value:Number(x.tracked_miles||0).toLocaleString(undefined,{maximumFractionDigits:1}),inline:true},
    {name:"Fuel Used",value:`${Number(x.fuel_used_liters||0).toFixed(1)} L`,inline:true},
    {name:"Fuel Stops",value:String(x.fuel_stops||0),inline:true},
    {name:"Crashes",value:String(x.crashes||0),inline:true},
    {name:"Crashes This Month",value:String(f[0]?.incidents||0),inline:true},
    {name:"Max Speed",value:`${Number(x.max_speed_mph||0).toFixed(1)} mph`,inline:true},
    {name:"Tracked Jobs",value:String(x.jobs_tracked||0),inline:true}
  ).setFooter({text:"Sterling Logistics Live Tracker"})]});
}
