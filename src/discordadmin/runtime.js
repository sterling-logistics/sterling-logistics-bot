import {Client,Events,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {loadConfig} from "../config.js";

const NEVER_TOUCH_KEYS=new Set(["founder"]);

function cleanName(name){
  return String(name||"")
    .toLowerCase()
    .replace(/[|•·»›→★☆✦✧◆◇▶►▬━—–_\-]+/g," ")
    .replace(/[^a-z0-9 ]+/g," ")
    .replace(/\s+/g," ")
    .trim();
}
function roleKey(role){
  const n=cleanName(role.name);
  if(/\bfounder\b/.test(n))return "founder";
  if(/\bexecutive\b.*\bmanagement\b|\bexecutive management\b/.test(n))return "executive";
  if(/\bsenior\b.*\bmanagement\b|\bsenior management\b/.test(n))return "senior";
  if(/\bmanagement\b/.test(n))return "management";
  if(/\bstaff\b/.test(n))return "staff";
  if(/\bguest\b/.test(n))return "guest";
  if(/\bdriver\s*0*(\d+)\b/.test(n))return "driver";
  return null;
}
function templateForKey(key){
  if(key==="founder")return null;
  if(key==="executive")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ModerateMembers,PermissionFlagsBits.KickMembers];
  if(key==="senior")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ModerateMembers];
  if(key==="management")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames];
  if(key==="staff")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages];
  if(key==="driver")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak];
  if(key==="guest")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];
  return null;
}
function flags(list){return list.reduce((a,b)=>a|b,0n);}

async function inspect(guild){
  await guild.roles.fetch();
  const me=await guild.members.fetchMe();
  const all=[...guild.roles.cache.values()].filter(r=>r.id!==guild.roles.everyone.id).sort((a,b)=>b.position-a.position);
  const recognised=[];const blocked=[];const unknown=[];
  for(const role of all){
    const key=roleKey(role);
    if(!key){unknown.push(role);continue;}
    if(role.managed||role.position>=me.roles.highest.position){blocked.push({role,key,reason:role.managed?"Discord-managed role":`above/equal to bot role (${me.roles.highest.name})`});continue;}
    const template=templateForKey(key);
    recognised.push({role,key,wanted:template?flags(template):role.permissions.bitfield,current:role.permissions.bitfield,protected:NEVER_TOUCH_KEYS.has(key)});
  }
  return {me,recognised,blocked,unknown};
}
async function apply(guild){
  const report=await inspect(guild);
  for(const x of report.recognised){
    if(x.protected||x.current===x.wanted)continue;
    await x.role.setPermissions(x.wanted,"Sterling guarded permission template");
  }
  return inspect(guild);
}
function render(report){
  const lines=[`Bot highest role: **${report.me.roles.highest.name}** (position ${report.me.roles.highest.position})`];
  lines.push("","**Recognised + editable**");
  if(report.recognised.length)for(const x of report.recognised)lines.push(`${x.protected?"🛡️":x.current===x.wanted?"✅":"🔧"} **${x.role.name}** → ${x.key}${x.protected?" (protected)":""}`);else lines.push("None");
  lines.push("","**Recognised but blocked by Discord hierarchy**");
  if(report.blocked.length)for(const x of report.blocked)lines.push(`⛔ **${x.role.name}** — ${x.reason}`);else lines.push("None");
  lines.push("","Role names can include emojis, separators and prefixes/suffixes. Matching now uses keywords such as Founder, Executive Management, Senior Management, Management, Staff, Driver 01/02/03+, and Guest.");
  return lines.join("\n").slice(0,3900);
}
function command(){return new SlashCommandBuilder().setName("discordcontrol").setDescription("Audit or apply guarded Sterling Discord role permissions").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o=>o.setName("action").setDescription("Action").setRequired(true).addChoices({name:"Audit",value:"audit"},{name:"Apply safe permissions",value:"apply"})).toJSON();}
async function register(){const c=loadConfig(),rest=new REST({version:"10"}).setToken(c.token),route=Routes.applicationGuildCommands(c.applicationId,c.guildId),all=await rest.get(route),body=command(),old=all.find(x=>x.name===body.name);if(old)await rest.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});else await rest.post(route,{body});console.log("[Discord Control] command registered");}
async function handle(i){
  if(!i.isChatInputCommand()||i.commandName!=="discordcontrol")return false;
  if(!i.memberPermissions?.has(PermissionFlagsBits.Administrator)){await i.reply({content:"Administrator permission required.",flags:MessageFlags.Ephemeral});return true;}
  try{
    const action=i.options.getString("action",true);const report=action==="apply"?await apply(i.guild):await inspect(i.guild);
    await i.reply({content:`${action==="apply"?"✅ Safe Sterling role permission template applied where Discord allowed it.":"🔎 Sterling permission audit:"}\n\n${render(report)}\n\nFounder remains protected. This command never grants Administrator, Manage Roles, Manage Server, Manage Channels, webhook or integration management.`,flags:MessageFlags.Ephemeral});
  }catch(e){await i.reply({content:`Discord control failed: ${String(e.message||e)}\n\nMake sure the Sterling bot has **Manage Roles** and its bot role is above every role you want it to manage.`,flags:MessageFlags.Ephemeral}).catch(()=>{});}return true;
}
const original=Client.prototype.login;if(!Client.prototype.__sterlingDiscordControl){Object.defineProperty(Client.prototype,"__sterlingDiscordControl",{value:true});Client.prototype.login=function(...args){if(!this.__sterlingDiscordControlRuntime){Object.defineProperty(this,"__sterlingDiscordControlRuntime",{value:true});this.on(Events.InteractionCreate,i=>handle(i).catch(e=>console.error("[Discord Control]",e)));this.once(Events.ClientReady,()=>{setTimeout(()=>register().catch(e=>console.error("[Discord Control] registration",e)),13000);});}return original.apply(this,args);};}
