import {ChannelType,EmbedBuilder} from "discord.js";

const PREFERRED_TRACKER_EVENTS_CHANNEL_ID="1537772143683706890";
let trackerEventsChannelId=PREFERRED_TRACKER_EVENTS_CHANNEL_ID;

export async function ensureTrackerEventsChannel(guild){
  await guild.channels.fetch();
  let ch=await guild.channels.fetch(PREFERRED_TRACKER_EVENTS_CHANNEL_ID).catch(()=>null);
  if(!ch)ch=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name==="tracker-events");
  if(!ch){
    ch=await guild.channels.create({name:"tracker-events",type:ChannelType.GuildText,topic:"Automatic Sterling Tracker events: jobs, fuel, rest stops and incidents."});
  }
  trackerEventsChannelId=ch.id;
  return ch;
}

function f(v,d=1){return Number(v||0).toFixed(d)}
function route(data){const a=data.sourceCity||"Unknown";const b=data.destinationCity||"Unknown";return `${a} → ${b}`;}

export async function postTrackerEvent(client,guildId,driver,event){
  if(!event)return;
  try{
    const guild=await client.guilds.fetch(guildId);
    let ch=trackerEventsChannelId?await guild.channels.fetch(trackerEventsChannelId).catch(()=>null):null;
    if(!ch)ch=await ensureTrackerEventsChannel(guild);
    const d=event.data||{};
    const who=`${driver.sterling_driver_id||driver.discord_username||"Driver"}${driver.discord_id?` — <@${driver.discord_id}>`:""}`;
    let title="🚛 Tracker Event",description="Sterling Tracker detected an event.",fields=[];
    switch(event.type){
      case "job-started":
        title="🟢 Job Started";description=`**${who}** started an ETS2 job.`;fields=[{name:"Cargo",value:d.cargo||"Unknown",inline:true},{name:"Route",value:route(d),inline:false},{name:"Truck",value:d.truck||"Unknown",inline:true}];break;
      case "job-delivered":
        title="✅ Job Completed";description=`**${who}** completed a delivery.`;fields=[{name:"Cargo",value:d.cargo||"Unknown",inline:true},{name:"Route",value:route(d),inline:false},{name:"Distance",value:`${f((Number(d.distanceKm)||0)*0.621371)} mi`,inline:true},{name:"Revenue",value:`€${Math.round(Number(d.revenue)||0).toLocaleString()}`,inline:true},{name:"Damage",value:`${f(Math.max(Number(d.truckDamage)||0,Number(d.trailerDamage)||0,Number(d.cargoDamage)||0)*100)}%`,inline:true}];break;
      case "fuel-stop":
        title="⛽ Fuel Stop";description=`**${who}** refuelled.`;fields=[{name:"Fuel Added",value:`${f(event.fuelAdded)} L`,inline:true},{name:"Fuel Level",value:`${f(d.fuelLiters)} L`,inline:true},{name:"Truck",value:d.truck||"Unknown",inline:true}];break;
      case "rest-stop":
        title="🛏️ Rest Stop";description=`**${who}** took a rest/sleep stop in ETS2.`;fields=[{name:"Truck",value:d.truck||"Unknown",inline:true},{name:"Game Time Jump",value:`${Math.round(Number(d.gameTimeJump)||0)} game min`,inline:true}];break;
      case "crash":
        title="💥 Crash / Damage Detected";description=`**${who}** had a new damage event.`;fields=[{name:"Speed",value:`${f(event.speedMph)} mph`,inline:true},{name:"Truck Damage",value:`${f((Number(d.truckDamage)||0)*100)}%`,inline:true}];break;
      default:return;
    }
    const e=new EmbedBuilder().setTitle(title).setDescription(description).addFields(fields).setTimestamp().setFooter({text:"Sterling Logistics Automatic Tracker"});
    await ch.send({embeds:[e]});
  }catch(err){console.error("[Tracker Events]",err);}
}
