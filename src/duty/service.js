import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";

async function audit(actor,action,details){
  try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,details) VALUES(?,?,?)",[actor,action,details||null]);}catch{}
}

function formatDuration(totalSeconds){
  const s=Math.max(0,Number(totalSeconds||0));
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
  return `${h}h ${m}m`;
}

export async function handleSignOn(i){
  const [open]=await db().execute("SELECT id,started_at FROM staff_duty_sessions WHERE discord_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",[i.user.id]);
  if(open[0])return i.reply({content:`You are already signed on for duty since **${open[0].started_at}**.`,flags:MessageFlags.Ephemeral});
  const [r]=await db().execute("INSERT INTO staff_duty_sessions(discord_id,discord_username) VALUES(?,?)",[i.user.id,i.user.username]);
  await audit(i.user.id,"duty.signon",`Duty session #${r.insertId}`);
  return i.reply({content:`✅ <@${i.user.id}> is now **signed on for duty**.`});
}

export async function handleSignOff(i){
  const [open]=await db().execute("SELECT id,started_at,TIMESTAMPDIFF(SECOND,started_at,CURRENT_TIMESTAMP) seconds FROM staff_duty_sessions WHERE discord_id=? AND ended_at IS NULL ORDER BY id DESC LIMIT 1",[i.user.id]);
  if(!open[0])return i.reply({content:"You are not currently signed on for duty.",flags:MessageFlags.Ephemeral});
  const seconds=Number(open[0].seconds||0);
  await db().execute("UPDATE staff_duty_sessions SET ended_at=CURRENT_TIMESTAMP,duration_seconds=? WHERE id=?",[seconds,open[0].id]);
  await audit(i.user.id,"duty.signoff",`Duty session #${open[0].id} | ${seconds}s`);
  return i.reply({content:`🛑 <@${i.user.id}> signed off duty after **${formatDuration(seconds)}**.`});
}

export async function handleDutyStatus(i){
  const [rows]=await db().execute("SELECT discord_id,discord_username,started_at,TIMESTAMPDIFF(SECOND,started_at,CURRENT_TIMESTAMP) seconds FROM staff_duty_sessions WHERE ended_at IS NULL ORDER BY started_at ASC");
  const text=rows.length?rows.map(r=>`<@${r.discord_id}> — **${formatDuration(r.seconds)}** — since ${r.started_at}`).join("\n"):"No staff are currently signed on for duty.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Staff Duty Status").setDescription(text.slice(0,4000))]});
}
