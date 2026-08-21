import {EmbedBuilder,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {db} from "../database/mysql.js";

const admin=PermissionFlagsBits.Administrator;
let schemaReady=false;

async function ensureManagementSchema(){
  if(schemaReady)return;
  const sql=[
    `CREATE TABLE IF NOT EXISTS driver_warnings(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      warning_code VARCHAR(24) UNIQUE,
      driver_id BIGINT UNSIGNED NOT NULL,
      issued_by VARCHAR(32) NOT NULL,
      severity VARCHAR(20) NOT NULL DEFAULT 'warning',
      points INT NOT NULL DEFAULT 0,
      reason VARCHAR(1000) NOT NULL,
      evidence TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'active',
      resolved_by VARCHAR(32),
      resolution_notes TEXT,
      issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      resolved_at TIMESTAMP NULL,
      INDEX(driver_id,status),INDEX(issued_at)
    )`,
    `CREATE TABLE IF NOT EXISTS convoy_attendance(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      convoy_id BIGINT UNSIGNED NOT NULL,
      driver_id BIGINT UNSIGNED NOT NULL,
      attendance_status VARCHAR(30) NOT NULL DEFAULT 'present',
      recorded_by VARCHAR(32) NOT NULL,
      notes VARCHAR(500),
      recorded_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_convoy_driver(convoy_id,driver_id),
      INDEX(driver_id,recorded_at)
    )`,
    `CREATE TABLE IF NOT EXISTS management_reports(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      report_type VARCHAR(50) NOT NULL,
      period_key VARCHAR(30),
      generated_by VARCHAR(32) NOT NULL,
      report_json JSON NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX(report_type,created_at)
    )`
  ];
  for(const q of sql)await db().query(q);
  schemaReady=true;
}

async function audit(actor,action,target,details){
  try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[actor,action,target||null,details||null]);}catch{}
}

async function getDriver(discordId){
  const [rows]=await db().execute("SELECT * FROM drivers WHERE discord_id=? LIMIT 1",[discordId]);
  return rows[0]||null;
}

function fmtHours(seconds){return `${(Number(seconds||0)/3600).toFixed(1)}h`;}
function pct(a,b){return b?`${((a/b)*100).toFixed(0)}%`:"0%";}

export function managementCommandData(){return[
  new SlashCommandBuilder().setName("warning").setDescription("Issue a formal driver warning").setDefaultMemberPermissions(admin)
    .addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true))
    .addStringOption(o=>o.setName("severity").setDescription("Warning severity").setRequired(true).addChoices(
      {name:"Advisory",value:"advisory"},{name:"Warning",value:"warning"},{name:"Final Warning",value:"final"},{name:"Suspension",value:"suspension"}))
    .addIntegerOption(o=>o.setName("points").setDescription("Disciplinary points").setRequired(true).setMinValue(0).setMaxValue(100))
    .addStringOption(o=>o.setName("reason").setDescription("Reason").setRequired(true).setMaxLength(1000))
    .addStringOption(o=>o.setName("evidence").setDescription("Evidence/reference").setRequired(false).setMaxLength(1500)),
  new SlashCommandBuilder().setName("warninghistory").setDescription("View a driver's disciplinary history").setDefaultMemberPermissions(admin)
    .addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true)),
  new SlashCommandBuilder().setName("warningresolve").setDescription("Resolve a formal driver warning").setDefaultMemberPermissions(admin)
    .addStringOption(o=>o.setName("code").setDescription("Warning code").setRequired(true))
    .addStringOption(o=>o.setName("notes").setDescription("Resolution notes").setRequired(true).setMaxLength(1000)),
  new SlashCommandBuilder().setName("staffstats").setDescription("View staff duty activity statistics").setDefaultMemberPermissions(admin)
    .addUserOption(o=>o.setName("user").setDescription("Optional staff member").setRequired(false))
    .addIntegerOption(o=>o.setName("days").setDescription("Reporting window in days").setRequired(false).setMinValue(1).setMaxValue(365)),
  new SlashCommandBuilder().setName("convoyattendance").setDescription("Record convoy attendance").setDefaultMemberPermissions(admin)
    .addIntegerOption(o=>o.setName("convoy").setDescription("Convoy database ID").setRequired(true).setMinValue(1))
    .addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true))
    .addStringOption(o=>o.setName("status").setDescription("Attendance status").setRequired(true).addChoices(
      {name:"Present",value:"present"},{name:"Absent",value:"absent"},{name:"Excused",value:"excused"},{name:"Late",value:"late"}))
    .addStringOption(o=>o.setName("notes").setDescription("Notes").setRequired(false).setMaxLength(500)),
  new SlashCommandBuilder().setName("convoyreport").setDescription("View convoy attendance report").setDefaultMemberPermissions(admin)
    .addIntegerOption(o=>o.setName("convoy").setDescription("Convoy database ID").setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName("activitycheck").setDescription("Find drivers below recent activity targets").setDefaultMemberPermissions(admin)
    .addIntegerOption(o=>o.setName("days").setDescription("Lookback period").setRequired(false).setMinValue(7).setMaxValue(180))
    .addNumberOption(o=>o.setName("miles").setDescription("Minimum miles required").setRequired(false).setMinValue(0))
    .addIntegerOption(o=>o.setName("jobs").setDescription("Minimum jobs required").setRequired(false).setMinValue(0)),
  new SlashCommandBuilder().setName("managementreport").setDescription("Generate Sterling VTC management overview").setDefaultMemberPermissions(admin)
].map(x=>x.toJSON());}

export async function registerManagementCommands(c){
  const r=new REST({version:"10"}).setToken(c.token);
  const route=Routes.applicationGuildCommands(c.applicationId,c.guildId);
  const existing=await r.get(route);
  for(const body of managementCommandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await r.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
    else await r.post(route,{body});
  }
  await ensureManagementSchema();
}

async function issueWarning(i){
  await ensureManagementSchema();
  const u=i.options.getUser("user",true),d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member does not have a Sterling driver profile.",flags:MessageFlags.Ephemeral});
  const severity=i.options.getString("severity",true),points=i.options.getInteger("points",true),reason=i.options.getString("reason",true),evidence=i.options.getString("evidence");
  const [r]=await db().execute("INSERT INTO driver_warnings(driver_id,issued_by,severity,points,reason,evidence) VALUES(?,?,?,?,?,?)",[d.id,i.user.id,severity,points,reason,evidence||null]);
  const code=`SL-W-${String(r.insertId).padStart(5,"0")}`;
  await db().execute("UPDATE driver_warnings SET warning_code=? WHERE id=?",[code,r.insertId]);
  if(severity==="suspension")await db().execute("UPDATE drivers SET status='suspended' WHERE id=?",[d.id]);
  await audit(i.user.id,"discipline.warning.issue",u.id,`${code} | ${severity} | ${points} points | ${reason}`);
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Formal Driver Action | ${code}`).setDescription(`<@${u.id}>`).addFields(
    {name:"Severity",value:severity.toUpperCase(),inline:true},{name:"Points",value:String(points),inline:true},{name:"Issued By",value:`<@${i.user.id}>`,inline:true},{name:"Reason",value:reason.slice(0,1024)},{name:"Evidence",value:evidence||"None supplied"}
  )]});
}

async function warningHistory(i){
  await ensureManagementSchema();
  const u=i.options.getUser("user",true),d=await getDriver(u.id);
  if(!d)return i.reply({content:"Driver not found.",flags:MessageFlags.Ephemeral});
  const [rows]=await db().execute("SELECT warning_code,severity,points,reason,status,issued_at,resolved_at FROM driver_warnings WHERE driver_id=? ORDER BY issued_at DESC LIMIT 20",[d.id]);
  const [sum]=await db().execute("SELECT COALESCE(SUM(points),0) points,COUNT(*) total,SUM(status='active') active FROM driver_warnings WHERE driver_id=?",[d.id]);
  const text=rows.length?rows.map(x=>`**${x.warning_code}** • ${x.severity} • ${x.points} pts • **${x.status}**\n${x.reason}`).join("\n\n"):"No disciplinary history recorded.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Driver Compliance | ${d.sterling_driver_id||u.username}`).setDescription(text.slice(0,3800)).addFields(
    {name:"Total Records",value:String(sum[0].total||0),inline:true},{name:"Active",value:String(sum[0].active||0),inline:true},{name:"Lifetime Points",value:String(sum[0].points||0),inline:true}
  )],flags:MessageFlags.Ephemeral});
}

async function resolveWarning(i){
  await ensureManagementSchema();
  const code=i.options.getString("code",true).toUpperCase(),notes=i.options.getString("notes",true);
  const [rows]=await db().execute("SELECT w.id,w.status,d.discord_id FROM driver_warnings w JOIN drivers d ON d.id=w.driver_id WHERE w.warning_code=? LIMIT 1",[code]);
  if(!rows[0])return i.reply({content:"Warning code not found.",flags:MessageFlags.Ephemeral});
  if(rows[0].status!=="active")return i.reply({content:"That warning is already resolved.",flags:MessageFlags.Ephemeral});
  await db().execute("UPDATE driver_warnings SET status='resolved',resolved_by=?,resolution_notes=?,resolved_at=CURRENT_TIMESTAMP WHERE id=?",[i.user.id,notes,rows[0].id]);
  await audit(i.user.id,"discipline.warning.resolve",rows[0].discord_id,`${code} | ${notes}`);
  return i.reply({content:`✅ **${code}** has been resolved and retained in the permanent audit history.`});
}

async function staffStats(i){
  await ensureManagementSchema();
  const u=i.options.getUser("user"),days=i.options.getInteger("days")||30;
  const params=[days];let where="started_at >= DATE_SUB(CURRENT_TIMESTAMP,INTERVAL ? DAY)";
  if(u){where+=" AND discord_id=?";params.push(u.id);}
  const [rows]=await db().execute(`SELECT discord_id,MAX(discord_username) username,COUNT(*) sessions,COALESCE(SUM(CASE WHEN ended_at IS NULL THEN TIMESTAMPDIFF(SECOND,started_at,CURRENT_TIMESTAMP) ELSE duration_seconds END),0) seconds,MAX(started_at) last_session FROM staff_duty_sessions WHERE ${where} GROUP BY discord_id ORDER BY seconds DESC LIMIT 25`,params);
  const text=rows.length?rows.map((x,n)=>`**${n+1}.** <@${x.discord_id}> — **${fmtHours(x.seconds)}** — ${x.sessions} sessions`).join("\n"):"No duty activity in this reporting period.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Staff Activity | Last ${days} Days`).setDescription(text).setFooter({text:"Sterling Logistics management reporting"})],flags:MessageFlags.Ephemeral});
}

async function convoyAttendance(i){
  await ensureManagementSchema();
  const convoy=i.options.getInteger("convoy",true),u=i.options.getUser("user",true),status=i.options.getString("status",true),notes=i.options.getString("notes");
  const d=await getDriver(u.id);if(!d)return i.reply({content:"Driver not found.",flags:MessageFlags.Ephemeral});
  const [c]=await db().execute("SELECT id,name,event_date FROM convoys WHERE id=? LIMIT 1",[convoy]);if(!c[0])return i.reply({content:"Convoy not found.",flags:MessageFlags.Ephemeral});
  await db().execute("INSERT INTO convoy_attendance(convoy_id,driver_id,attendance_status,recorded_by,notes) VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE attendance_status=VALUES(attendance_status),recorded_by=VALUES(recorded_by),notes=VALUES(notes),recorded_at=CURRENT_TIMESTAMP",[convoy,d.id,status,i.user.id,notes||null]);
  if(status==="present")await db().execute("UPDATE drivers SET convoys_attended=(SELECT COUNT(*) FROM convoy_attendance WHERE driver_id=? AND attendance_status='present') WHERE id=?",[d.id,d.id]);
  await audit(i.user.id,"convoy.attendance",u.id,`Convoy #${convoy} | ${status}${notes?` | ${notes}`:""}`);
  return i.reply({content:`✅ Attendance for <@${u.id}> at **${c[0].name}** recorded as **${status}**.`});
}

async function convoyReport(i){
  await ensureManagementSchema();
  const convoy=i.options.getInteger("convoy",true);
  const [c]=await db().execute("SELECT id,name,event_date,departure_city,destination FROM convoys WHERE id=? LIMIT 1",[convoy]);if(!c[0])return i.reply({content:"Convoy not found.",flags:MessageFlags.Ephemeral});
  const [rows]=await db().execute("SELECT a.attendance_status,a.notes,d.discord_id,d.sterling_driver_id FROM convoy_attendance a JOIN drivers d ON d.id=a.driver_id WHERE a.convoy_id=? ORDER BY a.attendance_status,d.sterling_driver_id",[convoy]);
  const counts={present:0,absent:0,excused:0,late:0};for(const x of rows)counts[x.attendance_status]=(counts[x.attendance_status]||0)+1;
  const text=rows.length?rows.map(x=>`<@${x.discord_id}> — **${x.attendance_status}**${x.notes?` — ${x.notes}`:""}`).join("\n"):"No attendance has been recorded yet.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Convoy Report | ${c[0].name}`).setDescription(text.slice(0,3600)).addFields(
    {name:"Present",value:String(counts.present),inline:true},{name:"Late",value:String(counts.late),inline:true},{name:"Absent",value:String(counts.absent),inline:true},{name:"Excused",value:String(counts.excused),inline:true},{name:"Attendance",value:pct(counts.present+counts.late,rows.length),inline:true}
  )],flags:MessageFlags.Ephemeral});
}

async function activityCheck(i){
  await ensureManagementSchema();
  const days=i.options.getInteger("days")||30,minMiles=i.options.getNumber("miles")??500,minJobs=i.options.getInteger("jobs")??2;
  const [rows]=await db().execute(`SELECT d.id,d.discord_id,d.sterling_driver_id,d.status,COALESCE(SUM(CASE WHEN j.completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL ? DAY) AND j.status='completed' THEN j.distance_miles ELSE 0 END),0) miles,COUNT(CASE WHEN j.completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL ? DAY) AND j.status='completed' THEN 1 END) jobs FROM drivers d LEFT JOIN jobs j ON j.driver_id=d.id WHERE d.status='active' GROUP BY d.id HAVING miles<? OR jobs<? ORDER BY miles ASC,jobs ASC`,[days,days,minMiles,minJobs]);
  const text=rows.length?rows.slice(0,30).map(x=>`<@${x.discord_id}> (${x.sterling_driver_id||"No ID"}) — **${Number(x.miles).toFixed(0)} mi / ${x.jobs} jobs**`).join("\n"):"✅ All active drivers meet the selected activity target.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Driver Activity Compliance").setDescription(text.slice(0,3900)).addFields({name:"Target",value:`${minMiles} miles and ${minJobs} jobs in ${days} days`})],flags:MessageFlags.Ephemeral});
}

async function managementReport(i){
  await ensureManagementSchema();
  const [[drivers],[jobs],[warnings],[duty],[applications],[fleet]]=await Promise.all([
    db().query("SELECT COUNT(*) total,SUM(status='active') active,SUM(status='loa') loa,SUM(status='suspended') suspended FROM drivers"),
    db().query("SELECT COUNT(*) total,COALESCE(SUM(distance_miles),0) miles,COALESCE(SUM(income),0) income FROM jobs WHERE status='completed' AND completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)"),
    db().query("SELECT COUNT(*) total,COALESCE(SUM(points),0) points FROM driver_warnings WHERE status='active'"),
    db().query("SELECT COALESCE(SUM(CASE WHEN ended_at IS NULL THEN TIMESTAMPDIFF(SECOND,started_at,CURRENT_TIMESTAMP) ELSE duration_seconds END),0) seconds,COUNT(*) sessions FROM staff_duty_sessions WHERE started_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)"),
    db().query("SELECT COUNT(*) pending FROM applications WHERE status IN ('pending','interview','hold')"),
    db().query("SELECT COUNT(*) online FROM live_telemetry WHERE status='online' AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)")
  ]);
  const snapshot={drivers:drivers[0],jobs30d:jobs[0],warnings:warnings[0],duty30d:duty[0],applications:applications[0],fleet:fleet[0]};
  await db().execute("INSERT INTO management_reports(report_type,period_key,generated_by,report_json) VALUES('overview','30d',?,?)",[i.user.id,JSON.stringify(snapshot)]);
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics | Management Overview").addFields(
    {name:"Drivers",value:`${drivers[0].active||0} active / ${drivers[0].total||0} total`,inline:true},
    {name:"LOA / Suspended",value:`${drivers[0].loa||0} / ${drivers[0].suspended||0}`,inline:true},
    {name:"Live Fleet",value:String(fleet[0].online||0),inline:true},
    {name:"30-Day Jobs",value:String(jobs[0].total||0),inline:true},
    {name:"30-Day Miles",value:Number(jobs[0].miles||0).toLocaleString("en-GB",{maximumFractionDigits:0}),inline:true},
    {name:"30-Day Revenue",value:`£${Number(jobs[0].income||0).toLocaleString("en-GB",{maximumFractionDigits:0})}`,inline:true},
    {name:"Open Discipline",value:`${warnings[0].total||0} records / ${warnings[0].points||0} pts`,inline:true},
    {name:"Staff Duty (30d)",value:`${fmtHours(duty[0].seconds)} / ${duty[0].sessions||0} sessions`,inline:true},
    {name:"Recruitment Queue",value:String(applications[0].pending||0),inline:true}
  ).setFooter({text:"Database-backed operational snapshot"})],flags:MessageFlags.Ephemeral});
}

export async function handleManagementInteraction(i){
  if(!i.isChatInputCommand())return false;
  const handlers={warning:issueWarning,warninghistory:warningHistory,warningresolve:resolveWarning,staffstats:staffStats,convoyattendance:convoyAttendance,convoyreport:convoyReport,activitycheck:activityCheck,managementreport:managementReport};
  const fn=handlers[i.commandName];if(!fn)return false;
  try{await fn(i);}catch(e){console.error("[Management]",e);const msg=`Management command failed: ${String(e.message||e).slice(0,800)}`;if(i.deferred||i.replied)await i.followUp({content:msg,flags:MessageFlags.Ephemeral});else await i.reply({content:msg,flags:MessageFlags.Ephemeral});}
  return true;
}
