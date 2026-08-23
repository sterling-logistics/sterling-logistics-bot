import {Client,Events,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {loadConfig} from "../config.js";

const STAFF=["Founder","Executive Management","Senior Management","Management","Staff"];
const DRIVER=/^Driver\s+\d+$/i;
const NEVER_TOUCH=new Set(["Founder"]);

function template(role){
  if(NEVER_TOUCH.has(role.name))return null;
  if(role.name==="Executive Management")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ModerateMembers,PermissionFlagsBits.KickMembers];
  if(role.name==="Senior Management")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames,PermissionFlagsBits.ModerateMembers];
  if(role.name==="Management")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages,PermissionFlagsBits.ManageNicknames];
  if(role.name==="Staff")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.ManageMessages];
  if(DRIVER.test(role.name))return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.Connect,PermissionFlagsBits.Speak];
  if(role.name==="Guest")return [PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory];
  return null;
}
function flags(list){return list.reduce((a,b)=>a|b,0n);}
async function plan(guild){await guild.roles.fetch();const me=await guild.members.fetchMe();return [...guild.roles.cache.values()].filter(r=>!r.managed&&r.id!==guild.roles.everyone.id&&r.position<me.roles.highest.position&&template(r)).map(r=>({role:r,wanted:flags(template(r)),current:r.permissions.bitfield}));}
function render(p){return p.length?p.map(x=>`${x.current===x.wanted?"✅":"🔧"} **${x.role.name}**${NEVER_TOUCH.has(x.role.name)?" (protected)":""}`).join("\n"):"No recognised editable Sterling roles found.";}
async function apply(guild){const p=await plan(guild);for(const x of p){if(NEVER_TOUCH.has(x.role.name)||x.current===x.wanted)continue;await x.role.setPermissions(x.wanted,"Sterling guarded permission template");}return p;}
function command(){return new SlashCommandBuilder().setName("discordcontrol").setDescription("Preview or apply guarded Sterling Discord role permissions").setDefaultMemberPermissions(PermissionFlagsBits.Administrator).addStringOption(o=>o.setName("action").setDescription("Action").setRequired(true).addChoices({name:"Audit",value:"audit"},{name:"Apply safe permissions",value:"apply"})).toJSON();}
async function register(){const c=loadConfig(),rest=new REST({version:"10"}).setToken(c.token),route=Routes.applicationGuildCommands(c.applicationId,c.guildId),all=await rest.get(route),body=command(),old=all.find(x=>x.name===body.name);if(old)await rest.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});else await rest.post(route,{body});console.log("[Discord Control] command registered");}
async function handle(i){if(!i.isChatInputCommand()||i.commandName!=="discordcontrol")return false;if(!i.memberPermissions?.has(PermissionFlagsBits.Administrator)){await i.reply({content:"Administrator permission required.",flags:MessageFlags.Ephemeral});return true;}try{const action=i.options.getString("action",true);const p=action==="apply"?await apply(i.guild):await plan(i.guild);await i.reply({content:`${action==="apply"?"✅ Safe Sterling role permission template applied.":"🔎 Sterling permission audit:"}\n\n${render(p)}\n\nFounder is protected. Administrator, Manage Roles, Manage Server, Manage Channels, webhooks and integrations are never granted by this template.`,flags:MessageFlags.Ephemeral});}catch(e){await i.reply({content:`Discord control failed: ${String(e.message||e)}\nEnsure the bot has Manage Roles and sits above managed Sterling roles.`,flags:MessageFlags.Ephemeral}).catch(()=>{});}return true;}
const original=Client.prototype.login;if(!Client.prototype.__sterlingDiscordControl){Object.defineProperty(Client.prototype,"__sterlingDiscordControl",{value:true});Client.prototype.login=function(...args){if(!this.__sterlingDiscordControlRuntime){Object.defineProperty(this,"__sterlingDiscordControlRuntime",{value:true});this.on(Events.InteractionCreate,i=>handle(i).catch(e=>console.error("[Discord Control]",e)));this.once(Events.ClientReady,()=>{setTimeout(()=>register().catch(e=>console.error("[Discord Control] registration",e)),13000);});}return original.apply(this,args);};}
