import {Client,Events} from "discord.js";
import {loadConfig} from "../config.js";
import {handleManagementInteraction,registerManagementCommands} from "./module.js";

const originalLogin=Client.prototype.login;

if(!Client.prototype.__sterlingManagementPatched){
  Object.defineProperty(Client.prototype,"__sterlingManagementPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingManagementRuntime){
      Object.defineProperty(this,"__sterlingManagementRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async interaction=>{
        try{await handleManagementInteraction(interaction);}catch(e){console.error("[Management Runtime] interaction",e);}
      });
      this.once(Events.ClientReady,()=>{
        const register=async()=>{
          try{
            const c=loadConfig();
            await registerManagementCommands(c);
            console.log("[Management] VTC management commands registered");
          }catch(e){console.error("[Management] registration failed",e);}
        };
        setTimeout(register,5000);
        setTimeout(register,20000);
      });
    }
    return originalLogin.apply(this,args);
  };
}
