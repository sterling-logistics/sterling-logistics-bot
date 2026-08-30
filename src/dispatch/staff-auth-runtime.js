import {Client,Events} from "discord.js";

function mergeDispatchAllowId(discordId){
  const ids=new Set(String(process.env.DISPATCH_STAFF_DISCORD_IDS||"")
    .split(",").map(x=>x.trim()).filter(Boolean));
  ids.add(String(discordId));
  process.env.DISPATCH_STAFF_DISCORD_IDS=[...ids].join(",");
}

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingDispatchOwnerAuthPatched){
  Object.defineProperty(Client.prototype,"__sterlingDispatchOwnerAuthPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingDispatchOwnerAuthRuntime){
      Object.defineProperty(this,"__sterlingDispatchOwnerAuthRuntime",{value:true,configurable:false});
      this.once(Events.ClientReady,async()=>{
        try{
          const guildId=String(process.env.DISCORD_GUILD_ID||"").trim();
          if(!guildId)return;
          const guild=await this.guilds.fetch(guildId);
          if(!guild?.ownerId)return;
          mergeDispatchAllowId(guild.ownerId);
          console.log("[Dispatch Auth] Discord server owner authorised for full Staff Edition access");
        }catch(e){
          console.error("[Dispatch Auth] Could not resolve Discord server owner",e);
        }
      });
    }
    return originalLogin.apply(this,args);
  };
}
