import {ChannelType,EmbedBuilder} from "discord.js";

const PREFERRED_TRACKER_EVENTS_CHANNEL_ID="1537772143683706890";
let trackerEventsChannelId=PREFERRED_TRACKER_EVENTS_CHANNEL_ID;

export async function ensureTrackerEventsChannel(guild){
  await guild.channels.fetch();
  let ch=await guild.channels.fetch(PREFERRED_TRACKER_EVENTS_CHANNEL_ID).catch(()=>null);
  if(!ch)ch=guild.channels.cache.find(c=>c.type===ChannelType.GuildText&&c.name==="tracker-events");
  if(!ch){
    ch=await guild.channels.create({name:"tracker-events",type:ChannelType.GuildText,topic:"Sterling staff tracker presence: driver game online/offline notifications."});
  }else if(ch.topic!=="Sterling staff tracker presence: driver game online/offline notifications."){
    await ch.setTopic("Sterling staff tracker presence: driver game online/offline notifications.").catch(()=>{});
  }
  trackerEventsChannelId=ch.id;
  return ch;
}

export async function postTrackerEvent(client,guildId,driver,event){
  if(!event||!["driver-online","driver-offline"].includes(event.type))return;
  try{
    const guild=await client.guilds.fetch(guildId);
    let ch=trackerEventsChannelId?await guild.channels.fetch(trackerEventsChannelId).catch(()=>null):null;
    if(!ch)ch=await ensureTrackerEventsChannel(guild);
    const d=event.data||{};
    const who=`${driver.sterling_driver_id||driver.discord_username||"Driver"}${driver.discord_id?` — <@${driver.discord_id}>`:""}`;
    const online=event.type==="driver-online";
    const title=online?"🟢 Driver Loaded ETS2":"🔴 Driver Left ETS2";
    const description=online?`**${who}** is now connected to the Sterling Tracker.`:`**${who}** is no longer connected to the Sterling Tracker.`;
    const fields=[];
    if(d.truck)fields.push({name:"Truck",value:String(d.truck),inline:true});
    if(d.cargo)fields.push({name:"Cargo",value:String(d.cargo),inline:true});
    if(d.sourceCity||d.destinationCity)fields.push({name:"Route",value:`${d.sourceCity||"Unknown"} → ${d.destinationCity||"Unknown"}`,inline:false});
    if(!online&&event.lastSeenAt)fields.push({name:"Last Seen",value:`<t:${Math.floor(new Date(event.lastSeenAt).getTime()/1000)}:R>`,inline:true});
    const e=new EmbedBuilder().setTitle(title).setDescription(description).setTimestamp().setFooter({text:"Sterling Logistics Staff Tracker"});
    if(fields.length)e.addFields(fields);
    await ch.send({embeds:[e]});
  }catch(err){console.error("[Tracker Presence]",err);}
}
