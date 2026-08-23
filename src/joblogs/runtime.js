import {Client,Events} from "discord.js";
import {handleJobApprovalButton} from "../telemetry/events.js";

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingJobLogsPatched){
  Object.defineProperty(Client.prototype,"__sterlingJobLogsPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingJobLogsRuntime){
      Object.defineProperty(this,"__sterlingJobLogsRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async i=>{
        if(!i.isButton())return;
        try{await handleJobApprovalButton(i);}catch(e){console.error("[Job Logs] interaction",e);}
      });
    }
    return originalLogin.apply(this,args);
  };
}
