import {runFreshCompanyResetOnce} from "./reset-vtc-once.js";

// One-off migration hook. It is safe to leave in place because the database marker
// makes subsequent starts a no-op.
setTimeout(async()=>{
  try{
    await runFreshCompanyResetOnce();
  }catch(e){
    console.error("[VTC Reset] Startup hook failed",e);
  }
},8000).unref?.();
