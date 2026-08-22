import {Client,Events} from "discord.js";
import {loadConfig} from "../config.js";
import {handleManagementInteraction,registerManagementCommands} from "./module.js";
import {handleAnalyticsInteraction,registerAnalyticsCommands} from "./analytics.js";
import {handleDriverAdminInteraction,registerDriverAdminCommands} from "./driver-admin.js";

const originalLogin=Client.prototype.login;

if(!Client.prototype.__sterlingManagementPatched){
  Object.defineProperty(Client.prototype,"__sterlingManagementPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingManagementRuntime){
      Object.defineProperty(this,"__sterlingManagementRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async interaction=>{
        try{
          if(await handleDriverAdminInteraction(interaction))return;
          if(await handleManagementInteraction(interaction))return;
          await handleAnalyticsInteraction(interaction);
        }catch(e){console.error("[Management Runtime] interaction",e);}
      });
      this.once(Events.ClientReady,()=>{
        const register=async()=>{
          const c=loadConfig();
          try{
            await registerDriverAdminCommands(c);
            console.log("[Driver Admin] /driverdelete + /driversetmiles registered");
          }catch(e){console.error("[Driver Admin] registration failed",e);}
          try{
            await registerManagementCommands(c);
          }catch(e){console.error("[Management] registration failed",e);}
          try{
            await registerAnalyticsCommands(c);
          }catch(e){console.error("[Analytics] registration failed",e);}
        };
        setTimeout(register,3000);
        setTimeout(register,15000);
      });
    }
    return originalLogin.apply(this,args);
  };
}
