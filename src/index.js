import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {Client,Events,GatewayIntentBits,MessageFlags,EmbedBuilder} from "discord.js";
import {loadConfig} from "./config.js";
import {initDatabase,pingDatabase,ensureSchema} from "./database/mysql.js";
import {registerCommands} from "./commands.js";
import {postVerificationPanel,handleVerify} from "./verification/service.js";
import {postTicketPanel,openTicket,isTicketStaff,handleClaim,handleTicketInfo,handleAddUser,handleRemoveUser,handleRename,handleTranscript,handleCloseTicket,handleTicketCleanup,handleDeleteHiddenTickets,handleManualChannelDelete,reconcileTickets} from "./tickets/service.js";
import {handleReviewButton,handleReviewModal} from "./reviews/service.js";
import {handleProfile} from "./drivers/service.js";
import {openApplicationModal,submitApplication,setApplicationStatus} from "./recruitment/service.js";
import {createHrCase} from "./hr/service.js";
import {createLoa} from "./loa/service.js";
import {recordTraining} from "./training/service.js";
import {createConvoy} from "./convoys/service.js";
import {handleJobs} from "./jobs/service.js";
import {ingestTelemetry,getLiveFleet,issueTrackerKey,authenticateTracker,ingestTrackerTelemetry,handleDrivingStats,markStaleTrackerSessionsOffline} from "./telemetry/service.js";
import {handleLeaderboard,handleCompanyStats,handleDriverAdmin,handleAchievementGive,handleAchievements,handleOwnerStatus,handleOwnerBootstrap,handleDriverCreate,handleDriverList,handleDriverLookup,handleSetDepartment,handleSetTruckersMp,handleSetSteam,handleSetCountry,handleSetTimezone,handleSetSafety,handleSetMiles,handleAddJobs,handleTrackerStatus,handleRevokeTracker,handleIncidentHistory,handleFuelHistory} from "./operations/service.js";
import {handleWallet,handlePayslip,handleFinance,handleWithdraw,handleCompanyLoan,handleCompanyLoans,handleCompanyDeposit,handleWalletCredit,handleWalletDebit} from "./economy/commands.js";
import {ensureEconomySchema,getPendingEts2Payout,completeEts2Payout,failEts2Payout} from "./economy/service.js";
import {ensureDispatchSchema} from "./dispatch/schema.js";
import {handleWorkCreate,handleMyWork,handleWorkInfo,handleWorkList,handleWorkStart,handleWorkCancel,handleWorkReassign,handleDispatchBoard} from "./dispatch/service.js";
import {ensureTrackerChannels,postTrackerEvent,postTrackerPresence} from "./telemetry/events.js";

const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const envResult = dotenv.config({ path: envPath });
if (envResult.error) console.warn(`[Config] Could not load ${envPath}: ${envResult.error.message}`);
else console.log(`[Config] Loaded environment from ${envPath}`);

const c=loadConfig();initDatabase(c.db);const intents=[GatewayIntentBits.Guilds];if(c.enableMessageContentIntent)intents.push(GatewayIntentBits.MessageContent);const client=new Client({intents});
const app=express();let schemaReady=false;app.use(express.json({limit:"512kb"}));
app.get("/",(_q,r)=>r.send("Sterling Logistics Bot API online"));
app.get("/health",async(_q,r)=>{try{const d=await pingDatabase();r.json({ok:true,discord:client.isReady(),database:d.db,schemaReady});}catch(e){r.status(500).json({ok:false,error:String(e.message||e)})}});
app.post("/api/telemetry",async(q,r)=>{try{if(!schemaReady)return r.status(503).json({ok:false,error:"Database schema is still starting"});if(!c.telemetryApiSecret)return r.status(503).json({ok:false,error:"Telemetry API not enabled"});if(q.headers.authorization!==`Bearer ${c.telemetryApiSecret}`)return r.status(401).json({ok:false,error:"Unauthorized"});r.json(await ingestTelemetry(q.body));}catch(e){r.status(400).json({ok:false,error:String(e.message||e)})}});

async function trackerAuth(q){const auth=String(q.headers.authorization||"");const token=auth.startsWith("Bearer ")?auth.slice(7):"";return authenticateTracker(token);}
app.get("/api/tracker/payout",async(q,r)=>{try{if(!schemaReady)return r.status(503).json({ok:false,error:"Database schema is still starting"});const driver=await trackerAuth(q);if(!driver)return r.status(401).json({ok:false,error:"Invalid tracker key"});const payout=await getPendingEts2Payout(driver.driver_id);r.json({ok:true,payout});}catch(e){r.status(400).json({ok:false,error:String(e.message||e)})}});
app.post("/api/tracker/payout/:id/complete",async(q,r)=>{try{if(!schemaReady)return r.status(503).json({ok:false,error:"Database schema is still starting"});const driver=await trackerAuth(q);if(!driver)return r.status(401).json({ok:false,error:"Invalid tracker key"});const ok=await completeEts2Payout(driver.driver_id,Number(q.params.id),q.body?.savePath);r.json({ok});}catch(e){r.status(400).json({ok:false,error:String(e.message||e)})}});
app.post("/api/tracker/payout/:id/fail",async(q,r)=>{try{if(!schemaReady)return r.status(503).json({ok:false,error:"Database schema is still starting"});const driver=await trackerAuth(q);if(!driver)return r.status(401).json({ok:false,error:"Invalid tracker key"});await failEts2Payout(driver.driver_id,Number(q.params.id),q.body?.error);r.json({ok:true});}catch(e){r.status(400).json({ok:false,error:String(e.message||e)})}});

app.post("/api/tracker/telemetry",async(q,r)=>{try{if(!schemaReady)return r.status(503).json({ok:false,error:"Database schema is still starting"});const driver=await trackerAuth(q);if(!driver)return r.status(401).json({ok:false,error:"Invalid tracker key"});const body=q.body||{};const data=body.data||{};const eventType=String(body.eventType||"heartbeat");const out=await ingestTrackerTelemetry(driver.driver_id,body);if(out.sessionBecameOnline)postTrackerPresence(client,c.guildId,driver,{type:"driver-online",data}).catch(e=>console.error("[Tracker Presence]",e));let event=null;if(["job-started","job-delivered","job-cancelled","fine","rest-stop","toll","ferry","train"].includes(eventType))event={type:eventType,data};else if(out.metrics?.crashDetected)event={type:"crash",data,speedMph:Number(data.speedMps||0)*2.2369362921,damageDelta:out.metrics.damageDelta||0};else if(Number(out.metrics?.fuelAdded||0)>0)event={type:"fuel-stop",data,fuelAdded:out.metrics.fuelAdded};if(event)postTrackerEvent(client,c.guildId,driver,event).catch(e=>console.error("[Tracker Events]",e));r.json({...out,driver:driver.sterling_driver_id});}catch(e){console.error("[Tracker API]",e);r.status(400).json({ok:false,error:String(e.message||e)})}});
app.listen(c.port,"0.0.0.0",()=>console.log(`[API] Listening on ${c.port}`));
client.once(Events.ClientReady,async me=>{console.log(`[Discord] Logged in as ${me.user.tag}`);try{const d=await pingDatabase();console.log(`[DB] Connected to ${d.db} as ${d.username}`);await ensureSchema();await ensureDispatchSchema();await ensureEconomySchema();schemaReady=true;console.log("[DB] MySQL schema ready");const g=await client.guilds.fetch(c.guildId);await ensureTrackerChannels(g);const x=await reconcileTickets(g);console.log(`[Tickets] Startup repair: ${x.valid} valid, ${x.stale} stale, ${x.duplicates} duplicate repaired`);await registerCommands(c);console.log("[Sterling] Bot ready");}catch(e){schemaReady=false;console.error("[Startup]",e);}});client.on(Events.ChannelDelete,handleManualChannelDelete);

setInterval(async()=>{if(!schemaReady||!client.isReady())return;try{const offline=await markStaleTrackerSessionsOffline(90);for(const d of offline)await postTrackerPresence(client,c.guildId,d,{type:"driver-offline",data:d.data,lastSeenAt:d.last_seen_at});}catch(e){console.error("[Tracker Presence Sweep]",e);}},30000);

client.on(Events.InteractionCreate,async i=>{try{
if(i.isModalSubmit()){if(i.customId==="sterling_application_modal")return submitApplication(i);if(i.customId.startsWith("sterling_review_modal:"))return handleReviewModal(i,client,c);}
if(i.isButton()){if(i.customId==="sterling_verify")return handleVerify(i,c);if(i.customId==="sterling_open_ticket")return openTicket(i,client,c);if(i.customId.startsWith("sterling_review:"))return handleReviewButton(i);return;}
if(!i.isChatInputCommand())return;
if(i.commandName==="setupverify")return postVerificationPanel(i);
if(i.commandName==="setuptickets")return postTicketPanel(i);
if(i.commandName==="ticketcleanup")return handleTicketCleanup(i);
if(i.commandName==="deletehiddentickets")return handleDeleteHiddenTickets(i,c);
if(i.commandName==="profile")return handleProfile(i);
if(i.commandName==="jobs")return handleJobs(i);
if(i.commandName==="trackerkey")return issueTrackerKey(i);
if(i.commandName==="drivingstats")return handleDrivingStats(i);
if(i.commandName==="wallet")return handleWallet(i);
if(i.commandName==="payslip")return handlePayslip(i);
if(i.commandName==="finance")return handleFinance(i);
if(i.commandName==="withdraw")return handleWithdraw(i);
if(i.commandName==="companyloan")return handleCompanyLoan(i);
if(i.commandName==="companyloans")return handleCompanyLoans(i);
if(i.commandName==="companydeposit")return handleCompanyDeposit(i);
if(i.commandName==="walletcredit")return handleWalletCredit(i);
if(i.commandName==="walletdebit")return handleWalletDebit(i);
if(i.commandName==="leaderboard")return handleLeaderboard(i);
if(i.commandName==="companystats")return handleCompanyStats(i);
if(i.commandName==="driveradmin")return handleDriverAdmin(i);
if(i.commandName==="achievementgive")return handleAchievementGive(i);
if(i.commandName==="achievements")return handleAchievements(i);
if(i.commandName==="ownerstatus")return handleOwnerStatus(i);
if(i.commandName==="ownerbootstrap")return handleOwnerBootstrap(i);
if(i.commandName==="drivercreate")return handleDriverCreate(i);
if(i.commandName==="driverlist")return handleDriverList(i);
if(i.commandName==="driverlookup")return handleDriverLookup(i);
if(i.commandName==="setdepartment")return handleSetDepartment(i);
if(i.commandName==="settruckersmp")return handleSetTruckersMp(i);
if(i.commandName==="setsteam")return handleSetSteam(i);
if(i.commandName==="setcountry")return handleSetCountry(i);
if(i.commandName==="settimezone")return handleSetTimezone(i);
if(i.commandName==="setsafety")return handleSetSafety(i);
if(i.commandName==="setmiles")return handleSetMiles(i);
if(i.commandName==="addjobs")return handleAddJobs(i);
if(i.commandName==="trackerstatus")return handleTrackerStatus(i);
if(i.commandName==="revoketracker")return handleRevokeTracker(i);
if(i.commandName==="incidenthistory")return handleIncidentHistory(i);
if(i.commandName==="fuelhistory")return handleFuelHistory(i);
if(i.commandName==="workcreate")return handleWorkCreate(i);
if(i.commandName==="mywork")return handleMyWork(i);
if(i.commandName==="workinfo")return handleWorkInfo(i);
if(i.commandName==="worklist")return handleWorkList(i);
if(i.commandName==="workstart")return handleWorkStart(i);
if(i.commandName==="workcancel")return handleWorkCancel(i);
if(i.commandName==="workreassign")return handleWorkReassign(i);
if(i.commandName==="dispatchboard")return handleDispatchBoard(i);
if(i.commandName==="apply")return openApplicationModal(i);
if(i.commandName==="application"){const m={accept:"accepted",reject:"rejected",interview:"interview",hold:"hold"};return setApplicationStatus(i,m[i.options.getSubcommand()]);}
if(i.commandName==="hrcase")return createHrCase(i);
if(i.commandName==="loa")return createLoa(i);
if(i.commandName==="trainingpass")return recordTraining(i,"pass");
if(i.commandName==="trainingfail")return recordTraining(i,"fail");
if(i.commandName==="convoycreate")return createConvoy(i);
if(i.commandName==="companylive"){const f=await getLiveFleet();const d=f.length?f.map(x=>`**${x.sterling_driver_id||x.discord_username||x.driver_id}** — ${x.truck||"Truck"} — ${Number(x.speed_mph||0).toFixed(0)} mph${x.cargo?` — ${x.cargo}`:""}${x.source_city||x.destination_city?` — ${x.source_city||"?"} → ${x.destination_city||"?"}`:""} — ${(Number(x.driving_seconds||0)/3600).toFixed(1)}h — ${x.crashes||0} crashes — ${x.fuel_stops||0} fuel stops`).join("\n"):"No Sterling Tracker sessions are currently online.";return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics Live Operations").setDescription(d)]});}
const staff=new Set(["claim","ticketinfo","adduser","removeuser","rename","transcript","closeticket"]);if(staff.has(i.commandName)&&!isTicketStaff(i,c))return i.reply({content:"Only authorised Sterling Logistics staff can use this command.",flags:MessageFlags.Ephemeral});switch(i.commandName){case"claim":return handleClaim(i);case"ticketinfo":return handleTicketInfo(i);case"adduser":return handleAddUser(i);case"removeuser":return handleRemoveUser(i);case"rename":return handleRename(i);case"transcript":return handleTranscript(i,client,c);case"closeticket":return handleCloseTicket(i,client,c);}
}catch(e){console.error("[Interaction]",e);const m=`Sterling Logistics Bot error\n\n${String(e.message||e).slice(0,1000)}`;try{if(i.deferred)await i.editReply(m);else if(i.replied)await i.followUp({content:m,flags:MessageFlags.Ephemeral});else await i.reply({content:m,flags:MessageFlags.Ephemeral});}catch{}}});client.on(Events.Error,e=>console.error("[Discord]",e));process.on("unhandledRejection",e=>console.error("[Node]",e));process.on("uncaughtException",e=>console.error("[Node]",e));client.login(c.token).catch(e=>{console.error("[Discord] Login failed",e);process.exit(1);});
