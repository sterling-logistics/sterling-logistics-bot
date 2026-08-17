import {db} from "../database/mysql.js";

const num=v=>Number(v||0);

export function registerPublicLiveRoutes(app){
  app.get("/api/public/live",async(_req,res)=>{
    try{
      const[[liveRows],[topRows],[recentRows]]=await Promise.all([
        db().query(`SELECT d.sterling_driver_id,d.discord_username,d.rank_name,l.status,l.truck,l.cargo,l.source_city,l.destination_city,l.speed_mph,l.last_seen_at
          FROM live_telemetry l JOIN drivers d ON d.id=l.driver_id
          WHERE d.status='active' AND l.status<>'offline' AND l.last_seen_at>=NOW()-INTERVAL 2 MINUTE
          ORDER BY l.last_seen_at DESC LIMIT 12`),
        db().query(`SELECT sterling_driver_id,discord_username,rank_name,total_miles,jobs_completed
          FROM drivers WHERE status='active' ORDER BY total_miles DESC,jobs_completed DESC LIMIT 5`),
        db().query(`SELECT j.completed_at,j.cargo,j.origin_city,j.destination_city,j.distance_miles,d.sterling_driver_id,d.discord_username
          FROM jobs j JOIN drivers d ON d.id=j.driver_id
          WHERE j.status='completed' ORDER BY COALESCE(j.completed_at,j.created_at) DESC LIMIT 8`)
      ]);
      res.json({ok:true,online:liveRows.map(x=>({id:x.sterling_driver_id,name:x.discord_username||x.sterling_driver_id,rank:x.rank_name||'Driver',status:x.status,truck:x.truck||null,cargo:x.cargo||null,origin:x.source_city||null,destination:x.destination_city||null,speedMph:num(x.speed_mph),lastSeenAt:x.last_seen_at})),top:topRows.map(x=>({id:x.sterling_driver_id,name:x.discord_username||x.sterling_driver_id,rank:x.rank_name||'Driver',miles:num(x.total_miles),jobs:num(x.jobs_completed)})),recent:recentRows.map(x=>({completedAt:x.completed_at,cargo:x.cargo||'Delivery',origin:x.origin_city||null,destination:x.destination_city||null,miles:num(x.distance_miles),driverId:x.sterling_driver_id,driverName:x.discord_username||x.sterling_driver_id}))});
    }catch(e){console.error('[Public Live]',e);res.status(500).json({ok:false,error:'Live operations are temporarily unavailable'});}
  });
}
