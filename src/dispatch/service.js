import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";
import {getDriver} from "../drivers/service.js";

const norm=v=>String(v||"").trim().toLowerCase().replace(/\s+/g," ");
const match=(expected,actual)=>!expected||!norm(expected)||norm(actual)===norm(expected)||norm(actual).includes(norm(expected))||norm(expected).includes(norm(actual));
const miles=km=>(Number(km)||0)*0.621371;
const fmtDate=v=>v?new Date(v).toLocaleString():"No deadline";

async function assignmentByCode(code){const[r]=await db().execute("SELECT w.*,d.discord_id,d.discord_username,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id WHERE w.work_code=? LIMIT 1",[String(code||"").toUpperCase()]);return r[0]||null;}
function embedWork(w){return new EmbedBuilder().setTitle(`📦 ${w.work_code} | ${w.status.replaceAll("_"," ").toUpperCase()}`).addFields(
{name:"Driver",value:`${w.sterling_driver_id||"Unknown"} — <@${w.discord_id}>`,inline:false},
{name:"Cargo",value:w.cargo||"Any cargo",inline:true},
{name:"Route",value:`${w.origin_city||"Any"} → ${w.destination_city||"Any"}`,inline:true},
{name:"Minimum Miles",value:Number(w.min_miles||0)>0?`${Number(w.min_miles).toFixed(1)} mi`:"None",inline:true},
{name:"Deadline",value:fmtDate(w.deadline_at),inline:false},
{name:"Tracker Verified",value:w.tracker_verified?"✅ Yes":"❌ Not yet",inline:true},
{name:"Actual Miles",value:`${Number(w.actual_distance_miles||0).toFixed(1)} mi`,inline:true},
{name:"Damage",value:`${(Number(w.actual_damage||0)*100).toFixed(1)}%`,inline:true},
{name:"Notes",value:w.notes||"None",inline:false},
{name:"Verification",value:w.verification_notes||"Waiting for tracker data.",inline:false}
).setFooter({text:"Sterling Logistics Dispatch"});}

export async function handleWorkCreate(i){
  const u=i.options.getUser("user",true);const d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member needs a Sterling driver profile first.",flags:MessageFlags.Ephemeral});
  const cargo=i.options.getString("cargo",true).trim(),origin=i.options.getString("origin",true).trim(),destination=i.options.getString("destination",true).trim();
  const deadline=i.options.getString("deadline")?.trim()||null,minMiles=i.options.getNumber("minmiles")||0,notes=i.options.getString("notes")?.trim()||null;
  let deadlineSql=null;if(deadline){const x=new Date(deadline);if(Number.isNaN(x.getTime()))return i.reply({content:"Deadline must be a valid date/time, for example `2026-08-17 20:00`.",flags:MessageFlags.Ephemeral});deadlineSql=x;}
  const[r]=await db().execute("INSERT INTO work_assignments(driver_id,cargo,origin_city,destination_city,min_miles,deadline_at,notes,created_by) VALUES(?,?,?,?,?,?,?,?)",[d.id,cargo,origin,destination,minMiles,deadlineSql,notes,i.user.id]);
  const code=`SLW-${String(r.insertId).padStart(5,"0")}`;await db().execute("UPDATE work_assignments SET work_code=? WHERE id=?",[code,r.insertId]);
  const w=await assignmentByCode(code);return i.reply({content:`Assigned work to <@${u.id}>.`,embeds:[embedWork(w)]});
}

export async function handleMyWork(i){
  const d=await getDriver(i.user.id);if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const[r]=await db().execute("SELECT * FROM work_assignments WHERE driver_id=? AND status IN ('assigned','in_progress') ORDER BY assigned_at ASC LIMIT 10",[d.id]);
  const text=r.length?r.map(w=>`**${w.work_code}** — ${w.cargo} — ${w.origin_city} → ${w.destination_city} — **${w.status.replaceAll("_"," ")}**${w.deadline_at?` — due ${fmtDate(w.deadline_at)}`:""}`).join("\n"):"You have no active Sterling work assignments.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("📋 My Sterling Work").setDescription(text)]});
}

export async function handleWorkInfo(i){const w=await assignmentByCode(i.options.getString("code",true));if(!w)return i.reply({content:"Work assignment not found.",flags:MessageFlags.Ephemeral});if(!i.memberPermissions?.has("Administrator")&&w.discord_id!==i.user.id)return i.reply({content:"You can only view your own work assignments.",flags:MessageFlags.Ephemeral});return i.reply({embeds:[embedWork(w)]});}

export async function handleWorkList(i){const status=i.options.getString("status")||null;const[r]=status?await db().execute("SELECT w.*,d.discord_id,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id WHERE w.status=? ORDER BY w.assigned_at DESC LIMIT 20",[status]):await db().query("SELECT w.*,d.discord_id,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id ORDER BY w.assigned_at DESC LIMIT 20");const text=r.length?r.map(w=>`**${w.work_code}** — ${w.sterling_driver_id} — ${w.cargo} — ${w.origin_city} → ${w.destination_city} — **${w.status}**${w.tracker_verified?" ✅":""}`).join("\n"):"No assignments found.";return i.reply({embeds:[new EmbedBuilder().setTitle("🚚 Sterling Dispatch List").setDescription(text)]});}

export async function handleWorkStart(i){const d=await getDriver(i.user.id);const code=i.options.getString("code",true).toUpperCase();const[w]=await db().execute("SELECT * FROM work_assignments WHERE work_code=? AND driver_id=? LIMIT 1",[code,d?.id||0]);if(!w[0])return i.reply({content:"That assignment is not assigned to you.",flags:MessageFlags.Ephemeral});if(!["assigned","in_progress"].includes(w[0].status))return i.reply({content:`That assignment is already ${w[0].status}.`,flags:MessageFlags.Ephemeral});await db().execute("UPDATE work_assignments SET status='in_progress',started_at=COALESCE(started_at,NOW()) WHERE id=?",[w[0].id]);return i.reply({content:`🚛 **${code}** marked in progress. The tracker will verify your ETS2 job automatically.`});}

export async function handleWorkCancel(i){const code=i.options.getString("code",true).toUpperCase(),reason=i.options.getString("reason")?.trim()||"Cancelled by management";const w=await assignmentByCode(code);if(!w)return i.reply({content:"Work assignment not found.",flags:MessageFlags.Ephemeral});await db().execute("UPDATE work_assignments SET status='cancelled',verification_notes=? WHERE id=?",[reason,w.id]);return i.reply({content:`Cancelled **${code}**.`});}

export async function handleWorkReassign(i){const code=i.options.getString("code",true).toUpperCase(),u=i.options.getUser("user",true),d=await getDriver(u.id);if(!d)return i.reply({content:"That member needs a Sterling driver profile first.",flags:MessageFlags.Ephemeral});const w=await assignmentByCode(code);if(!w)return i.reply({content:"Work assignment not found.",flags:MessageFlags.Ephemeral});await db().execute("UPDATE work_assignments SET driver_id=?,status='assigned',started_at=NULL,completed_at=NULL,tracker_verified=0,verification_notes=NULL WHERE id=?",[d.id,w.id]);return i.reply({content:`Reassigned **${code}** to <@${u.id}>.`});}

export async function handleDispatchBoard(i){const[r]=await db().query("SELECT w.*,d.discord_id,d.sterling_driver_id FROM work_assignments w JOIN drivers d ON d.id=w.driver_id WHERE w.status IN ('assigned','in_progress') ORDER BY FIELD(w.status,'in_progress','assigned'),w.deadline_at IS NULL,w.deadline_at ASC,w.assigned_at ASC LIMIT 20");const text=r.length?r.map(w=>`${w.status==='in_progress'?'🟢':'🟡'} **${w.work_code}** — ${w.sterling_driver_id} — ${w.cargo} — ${w.origin_city} → ${w.destination_city}${w.deadline_at?` — due ${fmtDate(w.deadline_at)}`:""}`).join("\n"):"No active dispatch work.";return i.reply({embeds:[new EmbedBuilder().setTitle("📡 Sterling Dispatch Board").setDescription(text)]});}

export async function syncDispatchFromTelemetry(driverId,eventType,data){
  const[r]=await db().execute("SELECT * FROM work_assignments WHERE driver_id=? AND status IN ('assigned','in_progress') ORDER BY CASE WHEN status='in_progress' THEN 0 ELSE 1 END,assigned_at ASC LIMIT 1",[driverId]);
  const w=r[0];if(!w)return null;
  const routeOk=match(w.cargo,data.cargo)&&match(w.origin_city,data.sourceCity)&&match(w.destination_city,data.destinationCity);
  if(eventType==="job-started"){
    if(routeOk){await db().execute("UPDATE work_assignments SET status='in_progress',started_at=COALESCE(started_at,NOW()),actual_cargo=?,actual_origin_city=?,actual_destination_city=?,verification_notes='Matching ETS2 job detected by Sterling Tracker.' WHERE id=?",[data.cargo||null,data.sourceCity||null,data.destinationCity||null,w.id]);return{code:w.work_code,status:"in_progress",matched:true};}
    return{code:w.work_code,status:w.status,matched:false};
  }
  if(w.status!=="in_progress")return null;
  const dist=miles(data.distanceKm),damage=Math.max(Number(data.truckDamage)||0,Number(data.trailerDamage)||0,Number(data.cargoDamage)||0);
  if(eventType==="job-delivered"){
    const distanceOk=!Number(w.min_miles)||dist>=Number(w.min_miles)*0.9;
    const verified=routeOk&&distanceOk;
    const notes=verified?"✅ Tracker verified cargo, route and delivery.":`⚠️ Delivery recorded but verification mismatch.${routeOk?"":" Cargo/route did not match assignment."}${distanceOk?"":" Distance was below the assigned minimum."}`;
    await db().execute("UPDATE work_assignments SET status='completed',completed_at=NOW(),tracker_verified=?,actual_cargo=?,actual_origin_city=?,actual_destination_city=?,actual_distance_miles=?,actual_damage=?,actual_revenue=?,verification_notes=? WHERE id=?",[verified?1:0,data.cargo||null,data.sourceCity||null,data.destinationCity||null,dist,damage,Number(data.revenue)||0,notes,w.id]);
    return{code:w.work_code,status:"completed",matched:verified};
  }
  if(eventType==="job-cancelled"){
    await db().execute("UPDATE work_assignments SET status='assigned',started_at=NULL,verification_notes='ETS2 job was cancelled; assignment returned to waiting.' WHERE id=?",[w.id]);return{code:w.work_code,status:"assigned",matched:false};
  }
  await db().execute("UPDATE work_assignments SET actual_cargo=?,actual_origin_city=?,actual_destination_city=?,actual_distance_miles=GREATEST(actual_distance_miles,?),actual_damage=GREATEST(actual_damage,?),actual_revenue=? WHERE id=?",[data.cargo||null,data.sourceCity||null,data.destinationCity||null,dist,damage,Number(data.revenue)||0,w.id]);
  return{code:w.work_code,status:"in_progress",matched:routeOk};
}
