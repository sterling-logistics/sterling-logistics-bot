import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";
import {getDriver} from "../drivers/service.js";

const metricMap={monthly:{column:"monthly_miles",label:"Monthly Miles",format:v=>Number(v).toLocaleString()},total:{column:"total_miles",label:"Total Miles",format:v=>Number(v).toLocaleString()},jobs:{column:"jobs_completed",label:"Jobs Completed",format:v=>String(v)},safety:{column:"safety_score",label:"Safety Score",format:v=>`${Number(v).toFixed(1)}/100`}};

export async function handleLeaderboard(i){
  const metric=i.options.getString("metric")||"monthly";
  const m=metricMap[metric]||metricMap.monthly;
  const [rows]=await db().query(`SELECT sterling_driver_id,discord_id,discord_username,${m.column} value FROM drivers WHERE status='active' ORDER BY ${m.column} DESC LIMIT 10`);
  const text=rows.length?rows.map((r,n)=>`**${n+1}.** ${r.sterling_driver_id||"SL-????"} — <@${r.discord_id}> — **${m.format(r.value)}**`).join("\n"):"No active drivers found yet.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Sterling Logistics Leaderboard | ${m.label}`).setDescription(text)]});
}

export async function handleCompanyStats(i){
  const [d]=await db().query("SELECT COUNT(*) active_drivers,COALESCE(SUM(total_miles),0) total_miles,COALESCE(SUM(monthly_miles),0) monthly_miles,COALESCE(SUM(jobs_completed),0) jobs_completed,COALESCE(AVG(safety_score),0) safety_score FROM drivers WHERE status='active'");
  const [j]=await db().query("SELECT COUNT(*) jobs,COALESCE(SUM(distance_miles),0) miles,COALESCE(SUM(income),0) income FROM jobs WHERE status='completed'");
  const [c]=await db().query("SELECT COUNT(*) convoys FROM convoys");
  const s=d[0],js=j[0];
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics Company Statistics").addFields(
    {name:"Active Drivers",value:String(s.active_drivers),inline:true},
    {name:"Total Driver Miles",value:Number(s.total_miles).toLocaleString(),inline:true},
    {name:"Monthly Miles",value:Number(s.monthly_miles).toLocaleString(),inline:true},
    {name:"Jobs Completed",value:String(js.jobs||s.jobs_completed),inline:true},
    {name:"Recorded Job Miles",value:Number(js.miles).toLocaleString(),inline:true},
    {name:"Average Safety",value:`${Number(s.safety_score).toFixed(1)}/100`,inline:true},
    {name:"Convoys Created",value:String(c[0].convoys),inline:true},
    {name:"Recorded Income",value:`€${Number(js.income).toLocaleString()}`,inline:true}
  )]});
}

async function audit(actor,action,target,details){await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[actor,action,target,details||null]);}

export async function handleDriverAdmin(i){
  const sub=i.options.getSubcommand();
  const u=i.options.getUser("user",true);
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member does not have a Sterling driver profile yet.",flags:MessageFlags.Ephemeral});
  if(sub==="setrank"){
    const rank=i.options.getString("rank",true).trim();
    const old=d.rank_name;
    await db().execute("UPDATE drivers SET rank_name=? WHERE id=?",[rank,d.id]);
    await db().execute("INSERT INTO promotions(driver_id,old_rank,new_rank,promoted_by) VALUES(?,?,?,?)",[d.id,old,rank,i.user.id]);
    await audit(i.user.id,"driver.rank",u.id,`${old} -> ${rank}`);
    return i.reply({content:`Updated <@${u.id}> from **${old}** to **${rank}**.`});
  }
  if(sub==="setstatus"){
    const status=i.options.getString("status",true);
    await db().execute("UPDATE drivers SET status=?,left_at=IF(?='left',CURRENT_TIMESTAMP,left_at) WHERE id=?",[status,status,d.id]);
    await audit(i.user.id,"driver.status",u.id,status);
    return i.reply({content:`Updated <@${u.id}> status to **${status}**.`});
  }
  if(sub==="addmiles"){
    const miles=i.options.getNumber("miles",true);
    await db().execute("UPDATE drivers SET total_miles=total_miles+?,monthly_miles=monthly_miles+? WHERE id=?",[miles,miles,d.id]);
    await audit(i.user.id,"driver.addmiles",u.id,String(miles));
    return i.reply({content:`Added **${Number(miles).toLocaleString()} miles** to <@${u.id}>.`});
  }
}

export async function handleAchievementGive(i){
  const u=i.options.getUser("user",true);const d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member does not have a Sterling driver profile yet.",flags:MessageFlags.Ephemeral});
  const name=i.options.getString("name",true).trim();const description=i.options.getString("description")?.trim()||null;
  await db().execute("INSERT INTO achievements(driver_id,name,description,awarded_by) VALUES(?,?,?,?)",[d.id,name,description,i.user.id]);
  await audit(i.user.id,"achievement.give",u.id,name);
  return i.reply({content:`🏆 Awarded **${name}** to <@${u.id}>.`});
}

export async function handleAchievements(i){
  const u=i.options.getUser("user")||i.user;const d=await getDriver(u.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const [rows]=await db().execute("SELECT name,description,awarded_at FROM achievements WHERE driver_id=? ORDER BY awarded_at DESC LIMIT 15",[d.id]);
  const text=rows.length?rows.map(r=>`🏆 **${r.name}**${r.description?` — ${r.description}`:""}`).join("\n"):"No achievements recorded yet.";
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Achievements | ${d.sterling_driver_id}`).setDescription(text)]});
}
