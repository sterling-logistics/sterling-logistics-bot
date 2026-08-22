import dotenv from "dotenv";

// Sparked/Pterodactyl keeps the server environment file at /home/container/.env.
// Load it explicitly before the standalone Tracker API module starts.
const result=dotenv.config({path:"/home/container/.env",override:false});
if(result.error){
  console.error("[Tracker API v2] Could not load /home/container/.env:",result.error.message);
}else{
  console.log(`[Tracker API v2] Loaded ${Object.keys(result.parsed||{}).length} environment values from /home/container/.env`);
}

await import("./src/server.js");
