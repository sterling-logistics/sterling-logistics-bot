import {ChannelType,EmbedBuilder,PermissionFlagsBits} from "discord.js";

const PREFERRED_TRACKER_EVENTS_CHANNEL_ID="1537772143683706890";
const STAFF_CATEGORY_NAME="staff hq";
const STATUS_CHANNEL_NAME="driver-status";
const EVENT_CHANNEL_NAME="tracker-events";
const STAFF_ROLE_NAMES=["Founder","Executive Management","Senior Management"];
const TRACKER_EVENTS_VISIBLE=new Set(["job-started","job-delivered","job-cancelled","fuel-stop","fine"]);
const ALL_DRIVER_STATUS_EVENTS=new Set(["job-started","job-delivered","job-cancelled","fuel-stop","fine","rest-stop","crash","toll","ferry","train"]);

let trackerEventsChannelId=PREFERRED_TRACKER_EVENTS_CHANNEL_ID;
let driverStatusChannelId=null;

function roleMatches(guild){return guild.roles.cache.filter(r=>STAFF_ROLE_NAMES.some(n=>r.name.toLowerCase()===n.toLowerCase()));}
async function staffCategory(guild){await guild.channels.fetch();return guild.channels.cache.find(c=>c.type===ChannelType.GuildCategory&&c.name.toLowerCase()===STAFF_CATEGORY_NAME)||null;}
function hiddenOverwrites(guild,roles){return [{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},...roles.map(r=>({id:r.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages]}))];}
async function applyHiddenStaffAccess(ch,guild,roles,parent){if(parent&&ch.parentId!==parent.id)await ch.setParent(parent.id,{lockPermissions:false}).catch(()=>{});for(const o of hiddenOverwrites(guild,roles))await ch.permissionOverwrites.edit(o.id,{ViewChannel:o.deny?false:true,ReadMessageHistory:o.deny?undefined:true,SendMessages:o.deny?undefined:true}).catch(()=>{});}

export async function ensureTrackerChannels(guild){
  await guild.roles.fetch();await guild.channels.fetch();
  const roles=[...roleMatches(guild).values()];const parent=await staffCategory(guild);
  let events=await guild.channels.fetch(PREFERRED_TRACKER_EVENTS_CHANNEL_ID).catch(()=>null);
  if(!events)events=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name===EVENT_CHANNEL_NAME);
  if(!events)events=await guild.channels.create({name:EVENT_CHANNEL_NAME,type:ChannelType.GuildText,parent:parent?.id,topic:"Job starts/completions/cancellations, fuel stops and fines.",permissionOverwrites:hiddenOverwrites(guild,roles)});
  await applyHiddenStaffAccess(events,guild,roles,parent);await events.setTopic("Job starts/completions/cancellations, fuel stops and fines.").catch(()=>{});trackerEventsChannelId=events.id;
  let status=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name===STATUS_CHANNEL_NAME&&(!parent||c.parentId===parent.id));
  if(!status)status=await guild.channels.create({name:STATUS_CHANNEL_NAME,type:ChannelType.GuildText,parent:parent?.id,topic:"Complete hidden Sterling driver activity feed, including online/offline and all tracker events.",permissionOverwrites:hiddenOverwrites(guild,roles)});
  await applyHiddenStaffAccess(status,guild,roles,parent);await status.setTopic("Complete hidden Sterling driver activity feed, including online/offline and all tracker events.").catch(()=>{});driverStatusChannelId=status.id;
  return{events,status,roles};
}
export async function ensureTrackerEventsChannel(guild){return (await ensureTrackerChannels(guild)).events;}

function f(v,d=1){return Number(v||0).toFixed(d)}
function route(d){return `${d.sourceCity||"Unknown"} → ${d.destinationCity||"Unknown"}`;}
function who(driver){return `${driver.sterling_driver_id||driver.discord_username||"Driver"}${driver.discord_id?` — <@${driver.discord_id}>`:""}`;}
function buildActivityEmbed(driver,event,footer="Sterling Logistics Tracker"){
  const d=event.data||{};let title="🚛 Tracker Event",description=`**${who(driver)}** triggered a tracker event.`,fields=[];
  switch(event.type){
    case "job-started": title="🟢 Job Started";description=`**${who(driver)}** started an ETS2 job.`;fields=[{name:"Cargo",value:d.cargo||"Unknown",inline:true},{name:"Route",value:route(d),inline:false},{name:"Truck",value:d.truck||"Unknown",inline:true}];break;
    case "job-delivered": title="✅ Job Completed";description=`**${who(driver)}** completed a delivery.`;fields=[{name:"Cargo",value:d.cargo||"Unknown",inline:true},{name:"Route",value:route(d),inline:false},{name:"Distance",value:`${f((Number(d.distanceKm)||0)*0.621371)} mi`,inline:true},{name:"Revenue",value:`€${Math.round(Number(d.revenue)||0).toLocaleString()}`,inline:true},{name:"Damage",value:`${f(Math.max(Number(d.truckDamage)||0,Number(d.trailerDamage)||0,Number(d.cargoDamage)||0)*100)}%`,inline:true}];break;
    case "job-cancelled": title="🟠 Job Cancelled";description=`**${who(driver)}** cancelled an ETS2 job.`;fields=[{name:"Cargo",value:d.cargo||"Unknown",inline:true},{name:"Route",value:route(d),inline:false}];break;
    case "fuel-stop": title="⛽ Fuel Stop";description=`**${who(driver)}** refuelled.`;fields=[{name:"Fuel Added",value:`${f(event.fuelAdded)} L`,inline:true},{name:"Fuel Level",value:`${f(d.fuelLiters)} L`,inline:true},{name:"Truck",value:d.truck||"Unknown",inline:true}];break;
    case "fine": title="🚨 Fine Issued";description=`**${who(driver)}** received an in-game fine.`;fields=[{name:"Offence",value:d.fineOffence||"Unknown",inline:true},{name:"Amount",value:`€${Math.round(Number(d.fineAmount)||0).toLocaleString()}`,inline:true},{name:"Speed",value:`${f((Number(d.speedMps)||0)*2.2369362921)} mph`,inline:true}];break;
    case "rest-stop": title="🛏️ Rest Stop";description=`**${who(driver)}** took an ETS2 rest stop.`;fields=[{name:"Truck",value:d.truck||"Unknown",inline:true},{name:"Game Time Jump",value:`${Math.round(Number(d.gameTimeJump)||0)} game min`,inline:true}];break;
    case "crash": title="💥 Crash / Damage";description=`**${who(driver)}** had a new damage event.`;fields=[{name:"Speed",value:`${f(event.speedMph)} mph`,inline:true},{name:"Truck Damage",value:`${f((Number(d.truckDamage)||0)*100)}%`,inline:true}];break;
    case "toll": title="🛣️ Toll Gate";description=`**${who(driver)}** passed a toll gate.`;break;
    case "ferry": title="⛴️ Ferry Used";description=`**${who(driver)}** used a ferry.`;break;
    case "train": title="🚆 Train Used";description=`**${who(driver)}** used train transport.`;break;
    default:return null;
  }
  const e=new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp().setFooter({text:footer});if(fields.length)e.addFields(fields);return e;
}

export async function postTrackerPresence(client,guildId,driver,event){
  if(!event||!["driver-online","driver-offline"].includes(event.type))return;
  try{
    const guild=await client.guilds.fetch(guildId);const setup=await ensureTrackerChannels(guild);const ch=driverStatusChannelId?await guild.channels.fetch(driverStatusChannelId).catch(()=>null):setup.status;
    const d=event.data||{};const online=event.type==="driver-online";const title=online?"🟢 Driver Loaded ETS2":"🔴 Driver Left ETS2";const description=online?`**${who(driver)}** is now connected to the Sterling Tracker.`:`**${who(driver)}** is no longer connected to the Sterling Tracker.`;const fields=[];
    if(d.truck)fields.push({name:"Truck",value:String(d.truck),inline:true});if(d.cargo)fields.push({name:"Cargo",value:String(d.cargo),inline:true});if(d.sourceCity||d.destinationCity)fields.push({name:"Route",value:route(d),inline:false});if(!online&&event.lastSeenAt)fields.push({name:"Last Seen",value:`<t:${Math.floor(new Date(event.lastSeenAt).getTime()/1000)}:R>`,inline:true});
    const e=new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp().setFooter({text:"Sterling Logistics Staff Tracker"});if(fields.length)e.addFields(fields);
    const roleIds=setup.roles.map(r=>r.id);const ping=roleIds.map(id=>`<@&${id}>`).join(" ");await ch.send({content:ping||undefined,embeds:[e],allowedMentions:{roles:roleIds}});
  }catch(err){console.error("[Tracker Presence]",err);}
}

export async function postTrackerEvent(client,guildId,driver,event){
  if(!event||!ALL_DRIVER_STATUS_EVENTS.has(event.type))return;
  try{
    const guild=await client.guilds.fetch(guildId);const setup=await ensureTrackerChannels(guild);
    const statusCh=driverStatusChannelId?await guild.channels.fetch(driverStatusChannelId).catch(()=>null):setup.status;
    const statusEmbed=buildActivityEmbed(driver,event,"Sterling Logistics Complete Driver Log");if(statusEmbed)await statusCh.send({embeds:[statusEmbed]});
    if(TRACKER_EVENTS_VISIBLE.has(event.type)){
      const eventCh=trackerEventsChannelId?await guild.channels.fetch(trackerEventsChannelId).catch(()=>null):setup.events;
      const eventEmbed=buildActivityEmbed(driver,event,"Sterling Logistics Tracker Events");if(eventEmbed)await eventCh.send({embeds:[eventEmbed]});
    }
  }catch(err){console.error("[Tracker Events]",err);}
}
