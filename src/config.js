const botReq=["DISCORD_BOT_TOKEN","DISCORD_APPLICATION_ID","DISCORD_GUILD_ID","GUEST_ROLE_ID","SUPPORT_CATEGORY_ID","TICKET_STAFF_ROLE_ID","TRANSCRIPTS_CHANNEL_ID","REVIEWS_CHANNEL_ID","DB_HOST","DB_PORT","DB_USER","DB_PASSWORD"];
const trackerReq=["DISCORD_APPLICATION_ID","DISCORD_CLIENT_SECRET","DB_HOST","DB_PORT","DB_USER","DB_PASSWORD"];
const b=v=>["1","true","yes","on"].includes(String(v||"").toLowerCase());
const n=(v,fallback)=>{const x=Number(v);return Number.isFinite(x)?x:fallback;};
const rate=(v,fallback)=>{const x=n(v,fallback);return Math.max(0,Math.min(1,x));};
export function loadConfig(){
  const trackerApiOnly=b(process.env.TRACKER_API_ONLY);
  const req=trackerApiOnly?trackerReq:botReq;
  const missing=req.filter(k=>!process.env[k]?.trim());
  if(missing.length)throw new Error(`Missing env vars: ${missing.join(", ")}`);
  return{
    trackerApiOnly,
    token:process.env.DISCORD_BOT_TOKEN?.trim()||null,
    applicationId:process.env.DISCORD_APPLICATION_ID?.trim()||null,
    discordClientSecret:process.env.DISCORD_CLIENT_SECRET?.trim()||null,
    publicBaseUrl:process.env.PUBLIC_BASE_URL?.trim()?.replace(/\/$/,"")||null,
    guildId:process.env.DISCORD_GUILD_ID?.trim()||null,
    guestRoleId:process.env.GUEST_ROLE_ID?.trim()||null,
    supportCategoryId:process.env.SUPPORT_CATEGORY_ID?.trim()||null,
    ticketStaffRoleId:process.env.TICKET_STAFF_ROLE_ID?.trim()||null,
    transcriptsChannelId:process.env.TRANSCRIPTS_CHANNEL_ID?.trim()||null,
    reviewsChannelId:process.env.REVIEWS_CHANNEL_ID?.trim()||null,
    db:{host:process.env.DB_HOST.trim(),port:n(process.env.DB_PORT,3306),database:process.env.DB_NAME?.trim()||"s248720_sterling_logistics",user:process.env.DB_USER.trim(),password:process.env.DB_PASSWORD},
    port:n(process.env.SERVER_PORT,n(process.env.PORT,8101)),
    enableMessageContentIntent:b(process.env.ENABLE_MESSAGE_CONTENT_INTENT),
    telemetryApiSecret:process.env.TELEMETRY_API_SECRET?.trim()||null,
    truckersMpApiToken:process.env.TRUCKERSMP_API_TOKEN?.trim()||null,
    economy:{driverPayRate:rate(process.env.DRIVER_PAY_RATE,0.55),fuelPricePerLitre:Math.max(0,n(process.env.FUEL_PRICE_PER_LITRE,1.70))}
  };
}
