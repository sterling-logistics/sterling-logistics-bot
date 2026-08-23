import "./env-force.js";

const trackerApiOnly=["1","true","yes","on"].includes(String(process.env.TRACKER_API_ONLY||"").toLowerCase());

if(trackerApiOnly){
  await import("./tracker-api-only.js");
}else{
  await import("./management/runtime.js");
  await import("./manualjobs/runtime.js");
  await import("./approvals/runtime.js");
  await import("./joblogs/runtime.js");
  await import("./index-oauth.js");
  await import("./maintenance/reset-vtc-once-startup.js");
}
