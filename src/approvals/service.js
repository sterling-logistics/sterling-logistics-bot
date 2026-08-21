import crypto from "node:crypto";
import {db} from "../database/mysql.js";
import {ensureEconomySchema} from "../economy/service.js";
import {processDriverProgression} from "../progression/service.js";

const num=v=>Number(v)||0;
const payRate=()=>Math.max(0,Math.min(1,Number(process.env.DRIVER_PAY_RATE||0.35)));
const jobCode=(driverId,sessionCode,data)=>{
  const seed=[driverId,sessionCode,data.sourceCity,data.destinationCity,data.cargo].join("|");
  return `TRK-${crypto.createHash("sha1").update(seed).digest("hex").slice(0,20).toUpperCase()}`;
};
let ready=false;

export async function ensureApprovalSchema(){
  if(ready)return;
  await ensureEconomySchema();
  await db().query(`CREATE TABLE IF NOT EXISTS tracked_job_approvals(
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    approval_code VARCHAR(24) UNIQUE,
    job_code VARCHAR(32),
    driver_id BIGINT UNSIGNED NOT NULL,
    session_id BIGINT UNSIGNED,
    reference_key VARCHAR(255) NOT NULL UNIQUE,
    cargo VARCHAR(150),
    origin_city VARCHAR(150),
    destination_city VARCHAR(150),
    distance_miles DECIMAL(12,2) NOT NULL DEFAULT 0,
    revenue DECIMAL(16,2) NOT NULL DEFAULT 0,
    driver_payment DECIMAL(16,2) NOT NULL DEFAULT 0,
    damage DECIMAL(8,4) NOT NULL DEFAULT 0,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    reviewed_by VARCHAR(32),
    review_notes VARCHAR(1000),
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at TIMESTAMP NULL,
    INDEX(status,created_at),INDEX(driver_id,created_at),INDEX(job_code))`);
  try{await db().query("ALTER TABLE tracked_job_approvals ADD COLUMN job_code VARCHAR(32) NULL AFTER approval_code");}catch(e){if(e.code!=="ER_DUP_FIELDNAME")throw e;}
  try{await db().query("CREATE INDEX idx_tracked_approval_job_code ON tracked_job_approvals(job_code)");}catch(e){if(!["ER_DUP_KEYNAME","ER_DUP_INDEX"].includes(e.code))throw e;}
  ready=true;
}

export async function queueTrackedJobForApproval(driverId,data,sessionId,sessionCode){
  await ensureApprovalSchema();
  const revenue=Math.max(0,num(data.revenue||data.jobDeliveredRevenue));
  const miles=Math.max(0,num(data.distanceKm||data.jobDeliveredDistanceKm))*0.621371;
  const damage=Math.max(num(data.truckDamage),num(data.trailerDamage),num(data.cargoDamage));
  const payment=Math.round(revenue*payRate()*100)/100;
  const origin=String(data.sourceCity||"").slice(0,150)||null;
  const destination=String(data.destinationCity||"").slice(0,150)||null;
  const cargo=String(data.cargo||"").slice(0,150)||null;
  const code=jobCode(driverId,String(sessionCode||`drv-${driverId}`),data);
  const ref=`tracker:${code}`;
  try{
    const[r]=await db().execute(`INSERT INTO tracked_job_approvals(job_code,driver_id,session_id,reference_key,cargo,origin_city,destination_city,distance_miles,revenue,driver_payment,damage)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,[code,driverId,sessionId,ref,cargo,origin,destination,miles,revenue,payment,damage]);
    const approvalCode=`SL-JA-${String(r.insertId).padStart(5,"0")}`;
    await db().execute("UPDATE tracked_job_approvals SET approval_code=? WHERE id=?",[approvalCode,r.insertId]);
    return{queued:true,approvalId:r.insertId,approvalCode,jobCode:code,status:"pending",payment,revenue};
  }catch(e){
    if(e.code!=="ER_DUP_ENTRY")throw e;
    const[rows]=await db().execute("SELECT id,approval_code,job_code,status,driver_payment,revenue FROM tracked_job_approvals WHERE reference_key=? LIMIT 1",[ref]);
    const x=rows[0];return{queued:false,approvalId:x?.id,approvalCode:x?.approval_code,jobCode:x?.job_code,status:x?.status,payment:num(x?.driver_payment),revenue:num(x?.revenue)};
  }
}

export async function listPendingApprovals(){
  await ensureApprovalSchema();
  const[rows]=await db().query(`SELECT a.*,d.discord_id,d.sterling_driver_id,d.discord_username
    FROM tracked_job_approvals a JOIN drivers d ON d.id=a.driver_id
    WHERE a.status='pending' ORDER BY a.created_at ASC LIMIT 25`);
  return rows;
}

export async function reviewTrackedApproval(code,decision,reviewer,notes){
  await ensureApprovalSchema();
  if(!["approve","decline"].includes(decision))throw new Error("Invalid approval decision.");
  const conn=await db().getConnection();
  let result=null;
  try{
    await conn.beginTransaction();
    const[rows]=await conn.execute(`SELECT a.*,d.discord_id,d.sterling_driver_id FROM tracked_job_approvals a JOIN drivers d ON d.id=a.driver_id WHERE a.approval_code=? LIMIT 1 FOR UPDATE`,[String(code).toUpperCase()]);
    const a=rows[0];
    if(!a)throw new Error("Approval code not found.");
    if(a.status!=="pending")throw new Error(`That delivery has already been ${a.status}.`);

    if(decision==="approve"){
      const incomeKey=`tracked-approval:${a.id}:income`,payKey=`tracked-approval:${a.id}:pay`;
      if(num(a.revenue)>0)await conn.execute("INSERT INTO economy_transactions(driver_id,type,amount,category,reference_key,details_json) VALUES(?,?,?,?,?,?)",[a.driver_id,"income",a.revenue,"job_revenue",incomeKey,JSON.stringify({approvalId:a.id,jobCode:a.job_code,cargo:a.cargo,sourceCity:a.origin_city,destinationCity:a.destination_city})]);
      if(num(a.driver_payment)>0)await conn.execute("INSERT INTO economy_transactions(driver_id,type,amount,category,reference_key,details_json) VALUES(?,?,?,?,?,?)",[a.driver_id,"expense",a.driver_payment,"driver_payment",payKey,JSON.stringify({approvalId:a.id,jobCode:a.job_code,rate:payRate()})]);
      await conn.execute(`INSERT INTO driver_wallets(driver_id,balance,total_earned,paid_jobs) VALUES(?,?,?,1)
        ON DUPLICATE KEY UPDATE balance=balance+VALUES(balance),total_earned=total_earned+VALUES(total_earned),paid_jobs=paid_jobs+1`,[a.driver_id,a.driver_payment,a.driver_payment]);
      await conn.execute("UPDATE drivers SET total_miles=total_miles+?,monthly_miles=monthly_miles+?,jobs_completed=jobs_completed+1,total_income=total_income+? WHERE id=?",[a.distance_miles,a.distance_miles,a.revenue,a.driver_id]);
      if(a.job_code)await conn.execute("UPDATE jobs SET status='completed',completed_at=COALESCE(completed_at,NOW()) WHERE job_code=? AND driver_id=?",[a.job_code,a.driver_id]);
      await conn.execute("UPDATE tracked_job_approvals SET status='approved',reviewed_by=?,review_notes=?,reviewed_at=NOW() WHERE id=?",[reviewer,notes||null,a.id]);
    }else{
      if(a.job_code)await conn.execute("UPDATE jobs SET status='rejected' WHERE job_code=? AND driver_id=?",[a.job_code,a.driver_id]);
      await conn.execute("UPDATE tracked_job_approvals SET status='declined',reviewed_by=?,review_notes=?,reviewed_at=NOW() WHERE id=?",[reviewer,notes||null,a.id]);
    }
    await conn.commit();
    result={...a,status:decision==="approve"?"approved":"declined"};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
  if(decision==="approve"){try{result.progression=await processDriverProgression(result.driver_id);}catch(e){console.error("[Job Approval Progression]",e);}}
  return result;
}
