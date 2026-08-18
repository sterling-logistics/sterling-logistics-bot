import crypto from "node:crypto";
import {db} from "../database/mysql.js";

const num=v=>Number(v)||0;
const text=(v,n=150)=>String(v??"").trim().slice(0,n)||null;
const startCode=(driverId,sessionCode,data)=>{
  const seed=[driverId,sessionCode,data.sourceCity,data.destinationCity,data.cargo].join("|");
  return `TRK-${crypto.createHash("sha1").update(seed).digest("hex").slice(0,20).toUpperCase()}`;
};

async function activeJob(driverId){
  const[r]=await db().execute("SELECT * FROM jobs WHERE driver_id=? AND status='in_progress' ORDER BY started_at DESC,id DESC LIMIT 1",[driverId]);
  return r[0]||null;
}

export async function persistTrackerJobEvent(driverId,body){
  const eventType=String(body?.eventType||"");
  if(!["job-started","job-delivered","job-cancelled"].includes(eventType))return null;

  const data=body?.data||{};
  const sessionCode=String(body?.sessionCode||`drv-${driverId}`);
  const truck=text(data.truck,200),cargo=text(data.cargo),origin=text(data.sourceCity),destination=text(data.destinationCity);
  const miles=Math.max(0,num(data.distanceKm||data.jobDeliveredDistanceKm))*0.621371;
  const revenue=Math.max(0,num(data.revenue||data.jobDeliveredRevenue));
  const truckDamage=Math.max(0,num(data.truckDamage));
  const trailerDamage=Math.max(0,num(data.trailerDamage));
  const cargoDamage=Math.max(0,num(data.cargoDamage));

  if(eventType==="job-started"){
    const existing=await activeJob(driverId);
    if(existing){
      await db().execute(`UPDATE jobs SET truck_model=COALESCE(?,truck_model),cargo=COALESCE(?,cargo),origin_city=COALESCE(?,origin_city),destination_city=COALESCE(?,destination_city) WHERE id=?`,[truck,cargo,origin,destination,existing.id]);
      return{jobCode:existing.job_code,status:"in_progress",reused:true};
    }
    const jobCode=startCode(driverId,sessionCode,data);
    await db().execute(`INSERT INTO jobs(job_code,driver_id,truck_model,cargo,origin_city,destination_city,status,started_at)
      VALUES(?,?,?,?,?,?,'in_progress',NOW())
      ON DUPLICATE KEY UPDATE truck_model=COALESCE(VALUES(truck_model),truck_model),cargo=COALESCE(VALUES(cargo),cargo),origin_city=COALESCE(VALUES(origin_city),origin_city),destination_city=COALESCE(VALUES(destination_city),destination_city),status=IF(status='completed',status,'in_progress'),started_at=COALESCE(started_at,NOW())`,
      [jobCode,driverId,truck,cargo,origin,destination]);
    return{jobCode,status:"in_progress"};
  }

  const current=await activeJob(driverId);
  const status=eventType==="job-delivered"?"completed":"cancelled";
  if(current){
    await db().execute(`UPDATE jobs SET truck_model=COALESCE(?,truck_model),cargo=COALESCE(?,cargo),origin_city=COALESCE(?,origin_city),destination_city=COALESCE(?,destination_city),distance_miles=IF(?>0,?,distance_miles),income=IF(?>0,?,income),truck_damage=?,trailer_damage=?,cargo_damage=?,status=?,completed_at=IF(?='completed',NOW(),completed_at) WHERE id=?`,
      [truck,cargo,origin,destination,miles,miles,revenue,revenue,truckDamage,trailerDamage,cargoDamage,status,status,current.id]);
    return{jobCode:current.job_code,status,updated:true};
  }

  const fallbackCode=startCode(driverId,sessionCode,data);
  await db().execute(`INSERT INTO jobs(job_code,driver_id,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,status,started_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW(),IF(?='completed',NOW(),NULL))
    ON DUPLICATE KEY UPDATE distance_miles=IF(VALUES(distance_miles)>0,VALUES(distance_miles),distance_miles),income=IF(VALUES(income)>0,VALUES(income),income),truck_damage=VALUES(truck_damage),trailer_damage=VALUES(trailer_damage),cargo_damage=VALUES(cargo_damage),status=VALUES(status),completed_at=IF(VALUES(status)='completed',NOW(),completed_at)`,
    [fallbackCode,driverId,truck,cargo,origin,destination,miles,revenue,truckDamage,trailerDamage,cargoDamage,status,status]);
  return{jobCode:fallbackCode,status,fallback:true};
}
