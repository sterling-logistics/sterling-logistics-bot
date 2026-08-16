import crypto from "node:crypto";
import {db} from "../database/mysql.js";

const num=v=>Number(v)||0;
const text=(v,n=150)=>String(v??"").trim().slice(0,n)||null;
const stableCode=(driverId,sessionCode,data)=>{
  const seed=[driverId,sessionCode,data.sourceCity,data.destinationCity,data.cargo,data.revenue||data.jobDeliveredRevenue,data.distanceKm||data.jobDeliveredDistanceKm].join("|");
  return `TRK-${crypto.createHash("sha1").update(seed).digest("hex").slice(0,20).toUpperCase()}`;
};

export async function persistTrackerJobEvent(driverId,body){
  const eventType=String(body?.eventType||"");if(!["job-started","job-delivered","job-cancelled"].includes(eventType))return null;
  const data=body?.data||{},sessionCode=String(body?.sessionCode||`drv-${driverId}`),jobCode=stableCode(driverId,sessionCode,data);
  const truck=text(data.truck,200),cargo=text(data.cargo),origin=text(data.sourceCity),destination=text(data.destinationCity);
  const miles=Math.max(0,num(data.distanceKm||data.jobDeliveredDistanceKm))*0.621371;
  const revenue=Math.max(0,num(data.revenue||data.jobDeliveredRevenue));
  const truckDamage=Math.max(0,num(data.truckDamage)),trailerDamage=Math.max(0,num(data.trailerDamage)),cargoDamage=Math.max(0,num(data.cargoDamage));
  if(eventType==="job-started"){
    await db().execute(`INSERT INTO jobs(job_code,driver_id,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,status,started_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,'in_progress',NOW())
      ON DUPLICATE KEY UPDATE truck_model=COALESCE(VALUES(truck_model),truck_model),cargo=COALESCE(VALUES(cargo),cargo),origin_city=COALESCE(VALUES(origin_city),origin_city),destination_city=COALESCE(VALUES(destination_city),destination_city),status=IF(status='completed',status,'in_progress')`,
      [jobCode,driverId,truck,cargo,origin,destination,miles||null,revenue||null,truckDamage,trailerDamage,cargoDamage]);
    return{jobCode,status:"in_progress"};
  }
  const status=eventType==="job-delivered"?"completed":"cancelled";
  await db().execute(`INSERT INTO jobs(job_code,driver_id,truck_model,cargo,origin_city,destination_city,distance_miles,income,truck_damage,trailer_damage,cargo_damage,status,started_at,completed_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,NOW(),IF(?='completed',NOW(),NULL))
    ON DUPLICATE KEY UPDATE truck_model=COALESCE(VALUES(truck_model),truck_model),cargo=COALESCE(VALUES(cargo),cargo),origin_city=COALESCE(VALUES(origin_city),origin_city),destination_city=COALESCE(VALUES(destination_city),destination_city),distance_miles=IF(VALUES(distance_miles)>0,VALUES(distance_miles),distance_miles),income=IF(VALUES(income)>0,VALUES(income),income),truck_damage=VALUES(truck_damage),trailer_damage=VALUES(trailer_damage),cargo_damage=VALUES(cargo_damage),status=VALUES(status),completed_at=IF(VALUES(status)='completed',NOW(),completed_at)`,
    [jobCode,driverId,truck,cargo,origin,destination,miles,revenue,truckDamage,trailerDamage,cargoDamage,status,status]);
  return{jobCode,status};
}
