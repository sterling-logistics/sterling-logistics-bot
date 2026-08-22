import {MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {db} from "../database/mysql.js";

const admin=PermissionFlagsBits.Administrator;

export function driverAdminCommandData(){return[
  new SlashCommandBuilder()
    .setName("driverdelete")
    .setDescription("Permanently delete a Sterling driver and their tracker data")
    .setDefaultMemberPermissions(admin)
    .addUserOption(o=>o.setName("user").setDescription("Driver to delete").setRequired(true))
    .addStringOption(o=>o.setName("confirm").setDescription("Type DELETE to confirm").setRequired(true)),
  new SlashCommandBuilder()
    .setName("driversetmiles")
    .setDescription("Correct a driver's Sterling mileage total")
    .setDefaultMemberPermissions(admin)
    .addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true))
    .addNumberOption(o=>o.setName("miles").setDescription("Correct lifetime miles").setRequired(true).setMinValue(0))
].map(x=>x.toJSON());}

export async function registerDriverAdminCommands(c){
  const r=new REST({version:"10"}).setToken(c.token);
  const route=Routes.applicationGuildCommands(c.applicationId,c.guildId);
  const existing=await r.get(route);
  for(const body of driverAdminCommandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await r.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
    else await r.post(route,{body});
  }
}

async function getDriver(discordId){
  const [rows]=await db().execute("SELECT id,discord_id,discord_username,sterling_driver_id,total_miles,jobs_completed FROM drivers WHERE discord_id=? LIMIT 1",[discordId]);
  return rows[0]||null;
}

async function safeDelete(conn,table,column,driverId){
  try{await conn.execute(`DELETE FROM ${table} WHERE ${column}=?`,[driverId]);}
  catch(e){
    if(!["ER_NO_SUCH_TABLE","ER_BAD_FIELD_ERROR"].includes(e.code))throw e;
  }
}

async function deleteDriver(i){
  const u=i.options.getUser("user",true);
  const confirm=i.options.getString("confirm",true).trim().toUpperCase();
  if(confirm!=="DELETE")return i.reply({content:"Deletion cancelled. Type **DELETE** in the confirm field to permanently remove the driver.",flags:MessageFlags.Ephemeral});
  if(u.id===i.user.id)return i.reply({content:"You cannot delete your own driver profile with this command.",flags:MessageFlags.Ephemeral});
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member does not have a Sterling driver profile.",flags:MessageFlags.Ephemeral});

  await i.deferReply({flags:MessageFlags.Ephemeral});
  const conn=await db().getConnection();
  try{
    await conn.beginTransaction();
    const related=[
      ["desktop_sessions","driver_id"],
      ["telemetry_events","driver_id"],
      ["telemetry_sessions","driver_id"],
      ["live_telemetry","driver_id"],
      ["tracked_job_approvals","driver_id"],
      ["driver_wallets","driver_id"],
      ["economy_transactions","driver_id"],
      ["driver_warnings","driver_id"],
      ["convoy_attendance","driver_id"],
      ["jobs","driver_id"]
    ];
    for(const [table,column] of related)await safeDelete(conn,table,column,d.id);
    await conn.execute("DELETE FROM drivers WHERE id=?",[d.id]);
    try{await conn.execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[i.user.id,"driver.delete",u.id,`Deleted ${d.sterling_driver_id||"driver"} and associated tracker data`]);}catch{}
    await conn.commit();
    return i.editReply({content:`✅ **${d.sterling_driver_id||u.username}** has been permanently deleted from Sterling, including tracker sessions, jobs, approvals and wallet data.`});
  }catch(e){
    await conn.rollback();
    console.error("[Driver Delete]",e);
    return i.editReply({content:`❌ Driver deletion failed: ${String(e.message||e).slice(0,700)}`});
  }finally{conn.release();}
}

async function setMiles(i){
  const u=i.options.getUser("user",true);
  const miles=Math.round(i.options.getNumber("miles",true)*100)/100;
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"That member does not have a Sterling driver profile.",flags:MessageFlags.Ephemeral});
  await db().execute("UPDATE drivers SET total_miles=?,monthly_miles=LEAST(monthly_miles,?) WHERE id=?",[miles,miles,d.id]);
  try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[i.user.id,"driver.miles.correct",u.id,`${Number(d.total_miles||0).toFixed(2)} -> ${miles.toFixed(2)} miles`]);}catch{}
  return i.reply({content:`✅ <@${u.id}> mileage corrected from **${Number(d.total_miles||0).toLocaleString("en-GB",{maximumFractionDigits:2})} mi** to **${miles.toLocaleString("en-GB",{maximumFractionDigits:2})} mi**.`,flags:MessageFlags.Ephemeral});
}

export async function handleDriverAdminInteraction(i){
  if(!i.isChatInputCommand())return false;
  if(i.commandName==="driverdelete"){await deleteDriver(i);return true;}
  if(i.commandName==="driversetmiles"){await setMiles(i);return true;}
  return false;
}
