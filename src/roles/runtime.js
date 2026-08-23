import {Client,Events,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {loadConfig} from "../config.js";

const CORE_HIGH_TO_LOW=[
  "Founder",
  "Executive Management",
  "Senior Management",
  "Management",
  "Staff"
];

function driverNumber(name){
  const m=/^Driver\s+(\d+)$/i.exec(String(name||"").trim());
  return m?Number(m[1]):null;
}

function desiredRoles(guild,botTopPosition){
  const editable=[...guild.roles.cache.values()].filter(r=>
    r.id!==guild.roles.everyone.id && !r.managed && r.position<botTopPosition
  );
  const byName=new Map(editable.map(r=>[r.name.toLowerCase(),r]));
  const ordered=[];
  for(const name of CORE_HIGH_TO_LOW){
    const role=byName.get(name.toLowerCase());
    if(role)ordered.push(role);
  }
  const drivers=editable
    .map(r=>({role:r,n:driverNumber(r.name)}))
    .filter(x=>x.n!==null)
    .sort((a,b)=>a.n-b.n)
    .map(x=>x.role);
  for(const role of drivers)if(!ordered.some(x=>x.id===role.id))ordered.push(role);
  const guest=byName.get("guest");
  if(guest&&!ordered.some(x=>x.id===guest.id))ordered.push(guest);
  return ordered;
}

async function buildPlan(guild){
  await guild.roles.fetch();
  const me=await guild.members.fetchMe();
  const botTop=me.roles.highest;
  const ordered=desiredRoles(guild,botTop.position);
  if(!ordered.length)return {botTop,ordered,positions:[]};

  // Put the recognised Sterling hierarchy directly below the bot's highest role.
  // Discord positions count upward from @everyone, so high-to-low names receive
  // descending numeric positions.
  let next=Math.max(1,botTop.position-1);
  const positions=[];
  for(const role of ordered){
    positions.push({role,position:next});
    next=Math.max(1,next-1);
  }
  return {botTop,ordered,positions};
}

async function applyHierarchy(guild){
  const plan=await buildPlan(guild);
  if(!plan.ordered.length)return {changed:false,plan,message:"No recognised Sterling hierarchy roles were found below the bot role."};
  await guild.roles.setPositions(plan.positions.map(x=>({role:x.role.id,position:x.position})));
  return {changed:true,plan};
}

function renderPlan(plan){
  if(!plan.ordered.length)return "No recognised Sterling hierarchy roles found below the bot role.";
  return [
    `Bot ceiling: **${plan.botTop.name}**`,
    "",
    "**Highest → Lowest**",
    ...plan.ordered.map((r,i)=>`${i+1}. ${r.name}`),
    "",
    "Only roles below the bot's highest role can be moved. Managed/integration roles are ignored."
  ].join("\n");
}

function commandData(){
  return new SlashCommandBuilder()
    .setName("rolehierarchy")
    .setDescription("Preview or apply the Sterling Discord role hierarchy")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o=>o.setName("action").setDescription("Preview or apply").setRequired(true)
      .addChoices({name:"Preview",value:"preview"},{name:"Apply",value:"apply"}))
    .toJSON();
}

async function register(){
  const c=loadConfig();
  const rest=new REST({version:"10"}).setToken(c.token);
  const route=Routes.applicationGuildCommands(c.applicationId,c.guildId);
  const existing=await rest.get(route);
  const body=commandData();
  const old=existing.find(x=>x.name===body.name);
  if(old)await rest.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
  else await rest.post(route,{body});
  console.log("[Role Hierarchy] command registered");
}

async function handle(i){
  if(!i.isChatInputCommand()||i.commandName!=="rolehierarchy")return false;
  if(!i.memberPermissions?.has(PermissionFlagsBits.Administrator)){
    await i.reply({content:"Administrator permission is required to manage the Sterling role hierarchy.",flags:MessageFlags.Ephemeral});
    return true;
  }
  try{
    const action=i.options.getString("action",true);
    if(action==="preview"){
      const plan=await buildPlan(i.guild);
      await i.reply({content:renderPlan(plan),flags:MessageFlags.Ephemeral});
      return true;
    }
    const result=await applyHierarchy(i.guild);
    await i.reply({content:`✅ Sterling role hierarchy applied.\n\n${renderPlan(result.plan)}`,flags:MessageFlags.Ephemeral});
  }catch(e){
    await i.reply({content:`Could not apply the hierarchy: ${String(e.message||e)}\n\nMake sure the Sterling bot role is above every role you want it to move and that it has **Manage Roles**.`,flags:MessageFlags.Ephemeral}).catch(()=>{});
  }
  return true;
}

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingRoleHierarchyPatched){
  Object.defineProperty(Client.prototype,"__sterlingRoleHierarchyPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingRoleHierarchyRuntime){
      Object.defineProperty(this,"__sterlingRoleHierarchyRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async i=>{try{await handle(i);}catch(e){console.error("[Role Hierarchy] interaction",e);}});
      this.once(Events.ClientReady,()=>{
        const run=()=>register().catch(e=>console.error("[Role Hierarchy] registration",e));
        setTimeout(run,11000);setTimeout(run,29000);
        if(["1","true","yes","on"].includes(String(process.env.AUTO_ROLE_HIERARCHY||"").toLowerCase())){
          setTimeout(async()=>{
            try{const c=loadConfig();const guild=await this.guilds.fetch(c.guildId);await applyHierarchy(guild);console.log("[Role Hierarchy] automatic hierarchy applied");}
            catch(e){console.error("[Role Hierarchy] automatic apply",e);}
          },16000);
        }
      });
    }
    return originalLogin.apply(this,args);
  };
}
