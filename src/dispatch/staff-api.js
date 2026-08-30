import {db} from "../database/mysql.js";
import {ensureDispatchSchema} from "./schema.js";
import {ensureApprovalSchema,reviewTrackedApproval} from "../approvals/service.js";
import {ensureEconomySchema} from "../economy/service.js";

async function dispatchAuth(req,trackerAuth){
  const d=await trackerAuth(req);if(!d)return null;
  const[rows]=await db().execute("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,department,status FROM drivers WHERE id=? LIMIT 1",[d.driver_id]);
  const staff=rows[0];if(!staff)return null;
  const allowIds=String(process.env.DISPATCH_STAFF_DISCORD_IDS||"").split(",").map(x=>x.trim()).filter(Boolean);
  const text=`${staff.rank_name||""} ${staff.department||""}`.toLowerCase();
  const roleAllowed=/(owner|founder|director|manager|management|dispatcher|dispatch|operations|admin)/.test(text);
  if(!allowIds.includes(String(staff.discord_id))&&!roleAllowed)return false;
  return staff;
}

async function requireDispatch(req,res,trackerAuth){
  const staff=await dispatchAuth(req,trackerAuth);
  if(staff===null){res.status(401).json({ok:false,error:"Invalid Sterling desktop session"});return null;}
  if(staff===false){res.status(403).json({ok:false,error:"Your Sterling profile is not authorised for Dispatch Staff Edition"});return null;}
  return staff;
}

export async function ensureDispatchStaffApiSchema(){
  await ensureDispatchSchema();
  await ensureApprovalSchema();
  await ensureEconomySchema();
}

export function registerDispatchStaffRoutes(app,trackerAuth,{includeAssignments=false}={}){
  app.get("/api/dispatch/job-approvals",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      await ensureApprovalSchema();
      const status=String(req.query.status||"pending").toLowerCase();
      const allowed=["pending","approved","declined"];
      const where=allowed.includes(status)?"WHERE a.status=?":"";
      const args=allowed.includes(status)?[status]:[];
      const[rows]=await db().execute(`SELECT a.id,a.approval_code,a.job_code,a.driver_id,a.cargo,a.origin_city,a.destination_city,a.distance_miles,a.revenue,a.driver_payment,a.damage,a.status,a.reviewed_by,a.review_notes,a.created_at,a.reviewed_at,d.sterling_driver_id,d.discord_username,d.discord_id FROM tracked_job_approvals a JOIN drivers d ON d.id=a.driver_id ${where} ORDER BY CASE WHEN a.status='pending' THEN 0 ELSE 1 END,a.created_at DESC LIMIT 200`,args);
      res.setHeader("Cache-Control","no-store");res.json({ok:true,approvals:rows});
    }catch(e){console.error("[Dispatch Job Approvals]",e);res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  app.post("/api/dispatch/job-approvals/:code/decision",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      const code=String(req.params.code||"").trim().toUpperCase();
      const decision=String(req.body?.decision||"").toLowerCase();
      const notes=String(req.body?.notes||"").trim().slice(0,1000)||null;
      if(!["approve","decline"].includes(decision))return res.status(400).json({ok:false,error:"Decision must be approve or decline"});
      const out=await reviewTrackedApproval(code,decision,String(staff.discord_id),notes);
      try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[String(staff.discord_id),`dispatch_job_${decision}`,String(out.discord_id||""),`${code}${notes?` • ${notes}`:""}`]);}catch{}
      res.json({ok:true,result:{approvalCode:code,status:out.status,payoutId:out.payoutId||null}});
    }catch(e){console.error("[Dispatch Job Decision]",e);res.status(400).json({ok:false,error:String(e.message||e)});}
  });

  app.get("/api/dispatch/payouts",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      await ensureEconomySchema();
      const status=String(req.query.status||"pending").toLowerCase();
      const allowed=["pending","applied"];
      const where=allowed.includes(status)?"WHERE p.status=?":"";
      const args=allowed.includes(status)?[status]:[];
      const[rows]=await db().execute(`SELECT p.id,p.driver_id,p.amount,p.status,p.requested_at,p.applied_at,p.save_path,p.error_text,d.sterling_driver_id,d.discord_username,d.discord_id FROM ets2_payouts p JOIN drivers d ON d.id=p.driver_id ${where} ORDER BY CASE WHEN p.status='pending' THEN 0 ELSE 1 END,p.requested_at DESC LIMIT 200`,args);
      res.setHeader("Cache-Control","no-store");res.json({ok:true,payouts:rows});
    }catch(e){console.error("[Dispatch Payouts]",e);res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  app.post("/api/dispatch/payouts/:id/retry",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      const id=Number(req.params.id||0);if(!id)return res.status(400).json({ok:false,error:"Invalid payout id"});
      const[r]=await db().execute("UPDATE ets2_payouts SET error_text=NULL WHERE id=? AND status='pending'",[id]);
      if(!r.affectedRows)return res.status(404).json({ok:false,error:"Pending payout not found"});
      try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,details) VALUES(?,?,?)",[String(staff.discord_id),"dispatch_payout_retry",`Payout ${id}`]);}catch{}
      res.json({ok:true});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  if(!includeAssignments)return;

  app.get("/api/dispatch/me",async(req,res)=>{
    try{
      const d=await trackerAuth(req);if(!d)return res.status(401).json({ok:false,error:"Invalid Sterling desktop session"});
      const staff=await dispatchAuth(req,trackerAuth);
      res.setHeader("Cache-Control","no-store");
      res.json({ok:true,isStaff:Boolean(staff),profile:staff||{sterling_driver_id:d.sterling_driver_id,discord_username:d.discord_username,rank_name:d.rank_name}});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  app.get("/api/dispatch/drivers",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      const[rows]=await db().query("SELECT id,sterling_driver_id,discord_id,discord_username,rank_name,department,total_miles,jobs_completed FROM drivers WHERE status='active' ORDER BY sterling_driver_id ASC,discord_username ASC LIMIT 500");
      res.setHeader("Cache-Control","no-store");res.json({ok:true,drivers:rows});
    }catch(e){res.status(500).json({ok:false,error:"Could not load drivers"});}
  });

  app.get("/api/dispatch/assignments",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      const mode=String(req.query.status||"active").toLowerCase();
      let sql="SELECT w.*,d.discord_id,d.discord_username,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id";
      const args=[];
      if(mode==="active")sql+=" WHERE w.status IN ('assigned','in_progress')";
      else if(["assigned","in_progress","completed","cancelled"].includes(mode)){sql+=" WHERE w.status=?";args.push(mode);}
      sql+=" ORDER BY CASE WHEN w.status='in_progress' THEN 0 WHEN w.status='assigned' THEN 1 ELSE 2 END,w.deadline_at IS NULL,w.deadline_at ASC,w.assigned_at DESC LIMIT 200";
      const[rows]=await db().execute(sql,args);res.setHeader("Cache-Control","no-store");res.json({ok:true,assignments:rows});
    }catch(e){res.status(500).json({ok:false,error:"Could not load dispatch assignments"});}
  });

  app.post("/api/dispatch/assignments",async(req,res)=>{
    try{
      const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;
      const driverId=Number(req.body?.driverId||0),cargo=String(req.body?.cargo||"").trim(),origin=String(req.body?.origin||"").trim(),destination=String(req.body?.destination||"").trim();
      const minMiles=Math.max(0,Number(req.body?.minMiles||0)),notes=String(req.body?.notes||"").trim().slice(0,2000)||null;
      if(!driverId||!cargo||!origin||!destination)return res.status(400).json({ok:false,error:"Driver, cargo, origin and destination are required"});
      const[driverRows]=await db().execute("SELECT id,sterling_driver_id,discord_id FROM drivers WHERE id=? AND status='active' LIMIT 1",[driverId]);
      if(!driverRows[0])return res.status(404).json({ok:false,error:"Active Sterling driver not found"});
      let deadline=null;if(req.body?.deadline){const d=new Date(req.body.deadline);if(Number.isNaN(d.getTime()))return res.status(400).json({ok:false,error:"Deadline is not a valid date/time"});deadline=d;}
      const[r]=await db().execute("INSERT INTO work_assignments(driver_id,cargo,origin_city,destination_city,min_miles,deadline_at,notes,created_by) VALUES(?,?,?,?,?,?,?,?)",[driverId,cargo,origin,destination,minMiles,deadline,notes,String(staff.discord_id)]);
      const code=`SLW-${String(r.insertId).padStart(5,"0")}`;await db().execute("UPDATE work_assignments SET work_code=? WHERE id=?",[code,r.insertId]);
      res.status(201).json({ok:true,workCode:code});
    }catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  app.post("/api/dispatch/assignments/:code/cancel",async(req,res)=>{
    try{const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;const code=String(req.params.code||"").toUpperCase(),reason=String(req.body?.reason||"Cancelled by dispatch").trim().slice(0,1000);const[r]=await db().execute("UPDATE work_assignments SET status='cancelled',verification_notes=? WHERE work_code=? AND status IN ('assigned','in_progress')",[reason,code]);if(!r.affectedRows)return res.status(404).json({ok:false,error:"Active assignment not found"});res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });

  app.post("/api/dispatch/assignments/:code/reassign",async(req,res)=>{
    try{const staff=await requireDispatch(req,res,trackerAuth);if(!staff)return;const code=String(req.params.code||"").toUpperCase(),driverId=Number(req.body?.driverId||0);const[d]=await db().execute("SELECT id,discord_id FROM drivers WHERE id=? AND status='active' LIMIT 1",[driverId]);if(!d[0])return res.status(404).json({ok:false,error:"Active Sterling driver not found"});const[r]=await db().execute("UPDATE work_assignments SET driver_id=?,status='assigned',started_at=NULL,completed_at=NULL,tracker_verified=0,verification_notes=NULL WHERE work_code=? AND status<>'cancelled'",[driverId,code]);if(!r.affectedRows)return res.status(404).json({ok:false,error:"Assignment not found"});res.json({ok:true});}catch(e){res.status(500).json({ok:false,error:String(e.message||e)});}
  });
}
