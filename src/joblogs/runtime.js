import {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,Client,EmbedBuilder,Events} from "discord.js";
import {handleJobApprovalButton} from "../telemetry/events.js";
import {db} from "../database/mysql.js";
import {ensureApprovalSchema} from "../approvals/service.js";
import {loadConfig} from "../config.js";

const DEFAULT_JOB_LOGS_CHANNEL_ID="1537243424707710996";
const JOB_LOGS_CHANNEL_NAME="job-logs";
let schemaReady=false;
let resolvedChannelId=null;

async function ensureJobLogSchema(){
  if(schemaReady)return;
  await ensureApprovalSchema();
  for(const q of [
    "ALTER TABLE tracked_job_approvals ADD COLUMN discord_log_message_id VARCHAR(32) NULL",
    "ALTER TABLE tracked_job_approvals ADD COLUMN discord_log_channel_id VARCHAR(32) NULL"
  ]){
    try{await db().query(q);}catch(e){if(e.code!=="ER_DUP_FIELDNAME")throw e;}
  }
  schemaReady=true;
}

function money(v){return `£${Number(v||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;}
function driverLabel(id){
  const m=String(id||"").match(/(\d+)$/);
  if(!m)return "Driver";
  return `Driver ${String(Number(m[1])).padStart(2,"0")}`;
}
function buttons(code){return [new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`sterling_job_approve:${code}`).setLabel("Approve").setEmoji("✅").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`sterling_job_decline:${code}`).setLabel("Reject").setEmoji("❌").setStyle(ButtonStyle.Danger)
)];}

async function resolveJobLogsChannel(guild){
  const configured=String(process.env.JOB_LOGS_CHANNEL_ID||"").trim();
  const ids=[configured,resolvedChannelId,DEFAULT_JOB_LOGS_CHANNEL_ID].filter(Boolean);
  for(const id of [...new Set(ids)]){
    const ch=await guild.channels.fetch(id).catch(()=>null);
    if(ch?.isTextBased()){
      resolvedChannelId=ch.id;
      return ch;
    }
  }

  await guild.channels.fetch().catch(()=>null);
  const byName=guild.channels.cache.find(ch=>ch?.isTextBased?.()&&String(ch.name||"").toLowerCase()===JOB_LOGS_CHANNEL_NAME);
  if(byName){
    resolvedChannelId=byName.id;
    return byName;
  }

  try{
    const created=await guild.channels.create({
      name:JOB_LOGS_CHANNEL_NAME,
      type:ChannelType.GuildText,
      reason:"Sterling Logistics automatic job approval log channel"
    });
    resolvedChannelId=created.id;
    console.log(`[Job Logs] Created replacement #${JOB_LOGS_CHANNEL_NAME} channel ${created.id}`);
    return created;
  }catch(e){
    throw new Error(`Job Logs channel is unavailable and Sterling could not create #${JOB_LOGS_CHANNEL_NAME}: ${String(e.message||e)}`);
  }
}

async function postMissingJobLogs(client){
  if(!client.isReady())return;
  await ensureJobLogSchema();
  const c=loadConfig();
  const guild=await client.guilds.fetch(c.guildId);
  const channel=await resolveJobLogsChannel(guild);

  const[rows]=await db().query(`SELECT a.*,d.discord_id,d.sterling_driver_id,d.discord_username
    FROM tracked_job_approvals a JOIN drivers d ON d.id=a.driver_id
    WHERE a.status='pending' AND (a.discord_log_message_id IS NULL OR a.discord_log_message_id='')
    ORDER BY a.created_at ASC LIMIT 20`);

  for(const a of rows){
    const label=driverLabel(a.sterling_driver_id);
    const embed=new EmbedBuilder()
      .setTitle(`✅ JOB COMPLETE — ${label}`)
      .setDescription(`<@${a.discord_id}> completed a tracked delivery.\n\n**Staff only:** approve or reject this exact job below.`)
      .addFields(
        {name:"Job",value:`**${a.approval_code}**`,inline:true},
        {name:"Driver",value:`${label} • ${a.sterling_driver_id||a.discord_username||"Sterling driver"}`,inline:true},
        {name:"Route",value:`${a.origin_city||"?"} → ${a.destination_city||"?"}`,inline:false},
        {name:"Cargo",value:a.cargo||"Unknown",inline:true},
        {name:"Distance",value:`${Number(a.distance_miles||0).toFixed(1)} mi`,inline:true},
        {name:"Revenue",value:money(a.revenue),inline:true},
        {name:"Driver Pay",value:money(a.driver_payment),inline:true},
        {name:"Damage",value:`${(Number(a.damage||0)*100).toFixed(1)}%`,inline:true},
        {name:"Status",value:"⏳ Awaiting staff decision",inline:false}
      )
      .setTimestamp(new Date(a.created_at))
      .setFooter({text:"Sterling Logistics Job Logs • ✅ approve / ❌ reject"});
    try{
      const msg=await channel.send({embeds:[embed],components:buttons(a.approval_code)});
      await db().execute("UPDATE tracked_job_approvals SET discord_log_message_id=?,discord_log_channel_id=? WHERE id=? AND (discord_log_message_id IS NULL OR discord_log_message_id='')",[msg.id,channel.id,a.id]);
    }catch(e){
      resolvedChannelId=null;
      throw e;
    }
  }
}

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingJobLogsPatched){
  Object.defineProperty(Client.prototype,"__sterlingJobLogsPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingJobLogsRuntime){
      Object.defineProperty(this,"__sterlingJobLogsRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async i=>{
        if(!i.isButton())return;
        try{await handleJobApprovalButton(i);}catch(e){console.error("[Job Logs] interaction",e);}
      });
      this.once(Events.ClientReady,()=>{
        const run=()=>postMissingJobLogs(this).catch(e=>console.error("[Job Logs] posting",e));
        setTimeout(run,8000);
        setInterval(run,10000);
      });
    }
    return originalLogin.apply(this,args);
  };
}
