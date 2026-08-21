import {EmbedBuilder,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {db} from "../database/mysql.js";

const admin=PermissionFlagsBits.Administrator;

export function analyticsCommandData(){return[
  new SlashCommandBuilder().setName("driverofthemonth").setDescription("Show the top Sterling driver for the last 30 days"),
  new SlashCommandBuilder().setName("staffleaderboard").setDescription("Show staff duty leaderboard").setDefaultMemberPermissions(admin)
    .addIntegerOption(o=>o.setName("days").setDescription("Reporting window").setRequired(false).setMinValue(1).setMaxValue(365)),
  new SlashCommandBuilder().setName("vtchealth").setDescription("Show overall Sterling VTC operational health").setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName("performance").setDescription("Show detailed driver performance report")
    .addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(false)),
  new SlashCommandBuilder().setName("rankrecommendations").setDescription("Find drivers ready for promotion review").setDefaultMemberPermissions(admin)
].map(x=>x.toJSON());}

export async function registerAnalyticsCommands(c){
  const r=new REST({version:"10"}).setToken(c.token),route=Routes.applicationGuildCommands(c.applicationId,c.guildId),existing=await r.get(route);
  for(const body of analyticsCommandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await r.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
    else await r.post(route,{body});
  }
}

async function driverRow(discordId){const [r]=await db().execute("SELECT * FROM drivers WHERE discord_id=? LIMIT 1",[discordId]);return r[0]||null;}
const n=v=>Number(v||0);
const fmt=v=>n(v).toLocaleString("en-GB",{maximumFractionDigits:0});

async function driverOfMonth(i){
  const [rows]=await db().query(`SELECT d.id,d.discord_id,d.sterling_driver_id,d.safety_score,
    COALESCE(SUM(CASE WHEN j.completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY) AND j.status='completed' THEN j.distance_miles ELSE 0 END),0) miles,
    COUNT(CASE WHEN j.completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY) AND j.status='completed' THEN 1 END) jobs,
    COALESCE(AVG(CASE WHEN j.completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY) AND j.status='completed' THEN (1-LEAST(1,COALESCE(j.cargo_damage,0))) * 100 END),100) cargo_score
    FROM drivers d LEFT JOIN jobs j ON j.driver_id=d.id WHERE d.status='active' GROUP BY d.id`);
  if(!rows.length)return i.reply("No active Sterling drivers found.");
  const scored=rows.map(x=>({...x,score:(n(x.miles)/100)+(n(x.jobs)*15)+(n(x.safety_score)*1.5)+(n(x.cargo_score)*0.5)})).sort((a,b)=>b.score-a.score);
  const w=scored[0];
  const top=scored.slice(0,5).map((x,idx)=>`**${idx+1}.** <@${x.discord_id}> — ${fmt(x.miles)} mi • ${x.jobs} jobs • ${n(x.safety_score).toFixed(0)} safety`).join("\n");
  return i.reply({embeds:[new EmbedBuilder().setTitle("🏆 Sterling Driver of the Month").setDescription(`**Winner:** <@${w.discord_id}> (${w.sterling_driver_id||"Sterling Driver"})\n\n${top}`).addFields(
    {name:"Winner Miles",value:fmt(w.miles),inline:true},{name:"Winner Jobs",value:String(w.jobs),inline:true},{name:"Safety",value:`${n(w.safety_score).toFixed(0)}/100`,inline:true}
  ).setFooter({text:"Rolling 30-day score: activity + safety + cargo care"})]});
}

async function staffLeaderboard(i){
  const days=i.options.getInteger("days")||30;
  const [rows]=await db().execute(`SELECT discord_id,COUNT(*) sessions,COALESCE(SUM(CASE WHEN ended_at IS NULL THEN TIMESTAMPDIFF(SECOND,started_at,CURRENT_TIMESTAMP) ELSE duration_seconds END),0) seconds FROM staff_duty_sessions WHERE started_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL ? DAY) GROUP BY discord_id ORDER BY seconds DESC LIMIT 20`,[days]);
  const text=rows.length?rows.map((x,idx)=>`**${idx+1}.** <@${x.discord_id}> — **${(n(x.seconds)/3600).toFixed(1)}h** • ${x.sessions} sessions`).join("\n"):"No duty sessions recorded.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Staff Leaderboard | ${days} Days`).setDescription(text)],flags:MessageFlags.Ephemeral});
}

async function vtcHealth(i){
  const [[drivers],[jobs],[incidents],[tracker],[tickets],[apps],[warnings]]=await Promise.all([
    db().query("SELECT COUNT(*) total,SUM(status='active') active,SUM(status='loa') loa,SUM(status='suspended') suspended,AVG(safety_score) safety FROM drivers"),
    db().query("SELECT COUNT(*) jobs,COALESCE(SUM(distance_miles),0) miles,COALESCE(SUM(income),0) income FROM jobs WHERE status='completed' AND completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)"),
    db().query("SELECT COUNT(*) crashes FROM driver_incidents WHERE occurred_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)"),
    db().query("SELECT COUNT(*) online FROM live_telemetry WHERE status='online' AND last_seen_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 2 MINUTE)"),
    db().query("SELECT COUNT(*) open FROM tickets WHERE status='open'"),
    db().query("SELECT COUNT(*) pending FROM applications WHERE status IN ('pending','interview','hold')"),
    db().query("SELECT COUNT(*) active,COALESCE(SUM(points),0) points FROM driver_warnings WHERE status='active'")
  ]);
  const active=n(drivers[0].active),total=n(drivers[0].total),jobs30=n(jobs[0].jobs),safety=n(drivers[0].safety);
  let score=100;
  if(total&&active/total<0.7)score-=15;
  if(safety<90)score-=Math.min(20,(90-safety));
  if(n(warnings[0].active)>Math.max(2,active*0.15))score-=10;
  if(jobs30<Math.max(1,active))score-=10;
  score=Math.max(0,Math.round(score));
  const state=score>=90?"Excellent":score>=75?"Good":score>=60?"Watch":"Needs Attention";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics | VTC Health").setDescription(`**Operational Health: ${score}/100 — ${state}**`).addFields(
    {name:"Drivers",value:`${active} active / ${total} total`,inline:true},{name:"Safety",value:`${safety.toFixed(1)}/100`,inline:true},{name:"Live Tracker",value:String(tracker[0].online||0),inline:true},
    {name:"30d Jobs",value:String(jobs30),inline:true},{name:"30d Miles",value:fmt(jobs[0].miles),inline:true},{name:"30d Crashes",value:String(incidents[0].crashes||0),inline:true},
    {name:"Open Tickets",value:String(tickets[0].open||0),inline:true},{name:"Recruitment Queue",value:String(apps[0].pending||0),inline:true},{name:"Active Discipline",value:`${warnings[0].active||0} / ${warnings[0].points||0} pts`,inline:true}
  )],flags:MessageFlags.Ephemeral});
}

async function performance(i){
  const u=i.options.getUser("user")||i.user,d=await driverRow(u.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const [[jobs],[metrics],[warn],[attendance]]=await Promise.all([
    db().execute("SELECT COUNT(*) jobs,COALESCE(SUM(distance_miles),0) miles,COALESCE(SUM(income),0) income,COALESCE(AVG(cargo_damage),0) cargo_damage,COALESCE(AVG(max_speed_mph),0) avg_max_speed FROM jobs WHERE driver_id=? AND status='completed' AND completed_at>=DATE_SUB(CURRENT_TIMESTAMP,INTERVAL 30 DAY)",[d.id]),
    db().execute("SELECT * FROM driver_metrics WHERE driver_id=? LIMIT 1",[d.id]),
    db().execute("SELECT COUNT(*) active,COALESCE(SUM(points),0) points FROM driver_warnings WHERE driver_id=? AND status='active'",[d.id]),
    db().execute("SELECT COUNT(*) total,SUM(attendance_status IN ('present','late')) attended FROM convoy_attendance WHERE driver_id=?",[d.id])
  ]);
  const m=metrics[0]||{};
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Driver Performance | ${d.sterling_driver_id||u.username}`).setDescription(`<@${u.id}>`).addFields(
    {name:"30d Miles",value:fmt(jobs[0].miles),inline:true},{name:"30d Jobs",value:String(jobs[0].jobs||0),inline:true},{name:"Safety Score",value:`${n(d.safety_score).toFixed(1)}/100`,inline:true},
    {name:"Tracked Driving",value:`${(n(m.driving_seconds)/3600).toFixed(1)}h`,inline:true},{name:"Crashes",value:String(m.crashes||0),inline:true},{name:"Fuel Stops",value:String(m.fuel_stops||0),inline:true},
    {name:"Active Discipline",value:`${warn[0].active||0} records / ${warn[0].points||0} pts`,inline:true},{name:"Convoy Attendance",value:`${attendance[0].attended||0}/${attendance[0].total||0}`,inline:true},{name:"Rank",value:d.rank_name||"Driver",inline:true}
  )]});
}

async function rankRecommendations(i){
  const [rows]=await db().query(`SELECT d.discord_id,d.sterling_driver_id,d.rank_name,d.total_miles,d.jobs_completed,d.safety_score,
    COALESCE((SELECT SUM(points) FROM driver_warnings w WHERE w.driver_id=d.id AND w.status='active'),0) active_points
    FROM drivers d WHERE d.status='active' ORDER BY d.total_miles DESC`);
  const eligible=rows.filter(x=>n(x.safety_score)>=90&&n(x.active_points)===0&&((n(x.total_miles)>=10000&&n(x.jobs_completed)>=25)||(n(x.total_miles)>=5000&&n(x.jobs_completed)>=12)));
  const text=eligible.length?eligible.slice(0,25).map(x=>`<@${x.discord_id}> — **${x.rank_name}** — ${fmt(x.total_miles)} mi • ${x.jobs_completed} jobs • ${n(x.safety_score).toFixed(0)} safety`).join("\n"):"No drivers currently meet the review thresholds.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Promotion Review Candidates").setDescription(text).setFooter({text:"Recommendation only — management retains final approval"})],flags:MessageFlags.Ephemeral});
}

export async function handleAnalyticsInteraction(i){
  if(!i.isChatInputCommand())return false;
  const map={driverofthemonth:driverOfMonth,staffleaderboard:staffLeaderboard,vtchealth:vtcHealth,performance,rankrecommendations:rankRecommendations};
  const fn=map[i.commandName];if(!fn)return false;
  try{await fn(i);}catch(e){console.error("[Analytics]",e);const msg=`Analytics command failed: ${String(e.message||e).slice(0,800)}`;if(i.replied||i.deferred)await i.followUp({content:msg,flags:MessageFlags.Ephemeral});else await i.reply({content:msg,flags:MessageFlags.Ephemeral});}
  return true;
}
