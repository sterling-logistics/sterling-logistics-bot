import {Client,Events,EmbedBuilder,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {loadConfig} from "../config.js";
import {ensureApprovalSchema,listPendingApprovals,reviewTrackedApproval} from "./service.js";

const admin=PermissionFlagsBits.Administrator;
const money=v=>`£${Number(v||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

function commandData(){return[
  new SlashCommandBuilder().setName("jobapprovals").setDescription("View tracker jobs waiting for payment approval").setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName("jobdecision").setDescription("Approve or decline a completed tracker job").setDefaultMemberPermissions(admin)
    .addStringOption(o=>o.setName("code").setDescription("Approval code, e.g. SL-JA-00001").setRequired(true).setMaxLength(24))
    .addStringOption(o=>o.setName("decision").setDescription("Decision").setRequired(true).addChoices({name:"Approve",value:"approve"},{name:"Decline",value:"decline"}))
    .addStringOption(o=>o.setName("notes").setDescription("Optional review notes").setRequired(false).setMaxLength(1000))
].map(x=>x.toJSON());}

async function register(){
  const c=loadConfig();await ensureApprovalSchema();
  const rest=new REST({version:"10"}).setToken(c.token),route=Routes.applicationGuildCommands(c.applicationId,c.guildId),existing=await rest.get(route);
  for(const body of commandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await rest.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});else await rest.post(route,{body});
  }
  console.log("[Job Approvals] commands registered");
}

async function pending(i){
  const rows=await listPendingApprovals();
  const text=rows.length?rows.map(x=>`**${x.approval_code}** • <@${x.discord_id}> (${x.sterling_driver_id||x.discord_username||"Driver"})\n${x.origin_city||"?"} → ${x.destination_city||"?"} • ${x.cargo||"Unknown cargo"} • **${Number(x.distance_miles||0).toFixed(1)} mi**\nRevenue ${money(x.revenue)} • Driver payment **${money(x.driver_payment)}** • Damage ${(Number(x.damage||0)*100).toFixed(1)}%`).join("\n\n"):"✅ No completed tracker jobs are waiting for approval.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Job Approval Queue").setDescription(text.slice(0,3900)).setFooter({text:"No driver payment is released until management approves the delivery."})],flags:MessageFlags.Ephemeral});
}

async function decide(i){
  const code=i.options.getString("code",true).trim().toUpperCase(),decision=i.options.getString("decision",true),notes=i.options.getString("notes")?.trim()||null;
  try{
    const a=await reviewTrackedApproval(code,decision,i.user.id,notes);
    const approved=decision==="approve";
    return i.reply({embeds:[new EmbedBuilder().setTitle(`${approved?"✅ Job Approved":"❌ Job Declined"} | ${code}`).setDescription(`<@${a.discord_id}> • ${a.sterling_driver_id||"Sterling driver"}`).addFields(
      {name:"Route",value:`${a.origin_city||"?"} → ${a.destination_city||"?"}`},
      {name:"Cargo",value:a.cargo||"Unknown",inline:true},
      {name:"Revenue",value:money(a.revenue),inline:true},
      {name:"Driver Payment",value:approved?`Released **${money(a.driver_payment)}** to the Sterling wallet.`:"**No payment released.**",inline:false},
      {name:"Notes",value:notes||"None"}
    )]});
  }catch(e){return i.reply({content:String(e.message||e),flags:MessageFlags.Ephemeral});}
}

async function handle(i){if(!i.isChatInputCommand())return;if(i.commandName==="jobapprovals")return pending(i);if(i.commandName==="jobdecision")return decide(i);}

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingJobApprovalPatched){
  Object.defineProperty(Client.prototype,"__sterlingJobApprovalPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingJobApprovalRuntime){
      Object.defineProperty(this,"__sterlingJobApprovalRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async i=>{try{await handle(i);}catch(e){console.error("[Job Approvals] interaction",e);}});
      this.once(Events.ClientReady,()=>{const run=()=>register().catch(e=>console.error("[Job Approvals] registration",e));setTimeout(run,9000);setTimeout(run,27000);});
    }
    return originalLogin.apply(this,args);
  };
}
