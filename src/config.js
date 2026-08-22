const req=["DISCORD_BOT_TOKEN","DISCORD_APPLICATION_ID","DISCORD_GUILD_ID","GUEST_ROLE_ID","SUPPORT_CATEGORY_ID","TICKET_STAFF_ROLE_ID","TRANSCRIPTS_CHANNEL_ID","REVIEWS_CHANNEL_ID","DB_HOST","DB_PORT","DB_USER","DB_PASSWORD"];
const b=v=>["1","true","yes","on"].includes(String(v||"").toLowerCase());
const n=(v,fallback)=>{const x=Number(v);return Number.isFinite(x)?x:fallback;};
const rate=(v,fallback)=>{const x=n(v,fallback);return Math.max(0,Math.min(1,x));};
export function loadConfig(){
  const missing=req.filter(k=>!process.env[k]?.trim());
  if(missing.length)throw new Error(`Missing env vars: ${missing.join(", ")}`);
  return{
    token:process.env.DISCORD_BOT_TOKEN.trim(),
    applicationId:process.env.DISCORD_APPLICATION_ID.trim(),
    discordClientSecret:process.env.DISCORD_CLIENT_SECRET?.trim()||null,
    publicBaseUrl:process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/$/,"")||null,
    guildId:process.env.DISCORD_GUILD_ID.trim(),
    guestRoleId:process.env.GUEST_ROLE_ID.trim(),
    supportCategoryId:process.env.SUPPORT_CATEGORY_ID.trim(),
    ticketStaffRoleId:process.env.TICKET_STAFF_ROLE_ID.trim(),
    transcriptsChannelId:process.env.TRANSCRIPTS_CHANNEL_ID.trim(),
    reviewsChannelId:process.env.REVIEWS_CHANNEL_ID.trim(),
    db:{host:process.env.DB_HOST.trim(),port:n(process.env.DB_PORT,3306),database:process.env.DB_NAME?.trim()||"s248720_sterling_logistics",user:process.env.DB_USER.trim(),password:process.env.DB_PASSWORD},
    // Pterodactyl exposes the server's primary allocation as SERVER_PORT.
    // Prefer it over a stale PORT value from .env so the API binds to the
    // same externally assigned port the tracker used before the v3 rebuild.
    port:n(process.env.SERVER_PORT,n(process.env.PORT,8101)),
    enableMessageContentIntent:b(process.env.ENABLE_MESSAGE_CONTENT_INTENT),
    telemetryApiSecret:process.env.TELEMETRY_API_SECRET?.trim()||null,
    truckersMpApiToken:process.env.TRUCKERSMP_API_TOKEN?.trim()||null,
    economy:{driverPayRate:rate(process.env.DRIVER_PAY_RATE,0.35),fuelPricePerLitre:Math.max(0,n(process.env.FUEL_PRICE_PER_LITRE,1.70))}
  };
}
