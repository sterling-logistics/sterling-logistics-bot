import {ActionRowBuilder,ButtonBuilder,ButtonStyle,ChannelType,EmbedBuilder,MessageFlags,ModalBuilder,PermissionFlagsBits,TextInputBuilder,TextInputStyle} from "discord.js";
import {db} from "../database/mysql.js";
import {createDriver} from "../drivers/service.js";

const REVIEW_CHANNEL_NAME="applications-review";
const STAFF_ROLE_NAMES=["Founder","Executive Management","Senior Management"];
const DRIVER_ROLE_NAMES=["Sterling Driver","Driver"];
const TRACKER_URL="https://github.com/sterling-logistics/sterling-logistics-bot/releases/download/tracker-v3-latest/SterlingTracker-3.0.1-Setup.exe";

const clean=v=>String(v??"").trim();
const answer=(answers,...needles)=>{
  const entries=Object.entries(answers||{});
  for(const needle of needles){const n=needle.toLowerCase();const hit=entries.find(([k])=>k.toLowerCase().includes(n));if(hit)return clean(Array.isArray(hit[1])?hit[1].join(", "):hit[1]);}
  return "";
};

async function ensureSchema(){
  for(const q of [
    "ALTER TABLE applications ADD COLUMN source VARCHAR(30) NULL",
    "ALTER TABLE applications ADD COLUMN external_answers_json JSON NULL",
    "ALTER TABLE applications ADD COLUMN review_channel_id VARCHAR(32) NULL",
    "ALTER TABLE applications ADD COLUMN review_message_id VARCHAR(32) NULL"
  ]){try{await db().query(q);}catch(e){if(e.code!=="ER_DUP_FIELDNAME")throw e;}}
}

async function ensureReviewChannel(guild){
  await guild.channels.fetch();await guild.roles.fetch();
  let ch=guild.channels.cache.find(x=>x.type===ChannelType.GuildText&&x.name===REVIEW_CHANNEL_NAME);
  if(ch)return ch;
  const staff=[...guild.roles.cache.filter(r=>STAFF_ROLE_NAMES.some(n=>r.name.toLowerCase()===n.toLowerCase())).values()];
  const parent=guild.channels.cache.find(x=>x.type===ChannelType.GuildCategory&&x.name.toLowerCase()==="staff hq");
  ch=await guild.channels.create({name:REVIEW_CHANNEL_NAME,type:ChannelType.GuildText,parent:parent?.id,topic:"Google Forms applications awaiting Sterling Logistics staff review.",permissionOverwrites:[{id:guild.roles.everyone.id,deny:[PermissionFlagsBits.ViewChannel]},...staff.map(r=>({id:r.id,allow:[PermissionFlagsBits.ViewChannel,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.SendMessages]}))]});
  return ch;
}

async function resolveDiscordMember(guild,discordId,discordName){
  if(discordId){const m=await guild.members.fetch(discordId).catch(()=>null);if(m)return m;}
  await guild.members.fetch().catch(()=>{});
  const target=clean(discordName).toLowerCase().replace(/^@/,"");
  if(!target)return null;
  return guild.members.cache.find(m=>[m.user.username,m.user.globalName,m.displayName,`${m.user.username}#${m.user.discriminator}`].filter(Boolean).some(v=>String(v).toLowerCase()===target))||null;
}

function reviewButtons(id){return new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`googleapp_accept:${id}`).setLabel("Accept").setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`googleapp_decline:${id}`).setLabel("Decline").setStyle(ButtonStyle.Danger)
);}

function embedFor(code,member,answers){
  const fields=[];const add=(name,val,inline=false)=>{if(clean(val))fields.push({name,value:clean(val).slice(0,1024),inline});};
  add("Applicant",member?`<@${member.id}> (${member.user.username})`:answer(answers,"discord username"));
  add("Age",answer(answers,"age"),true);add("Country / Time zone",answer(answers,"country / time zone","country"),true);
  add("TruckersMP",answer(answers,"truckersmp"));add("Steam",answer(answers,"steam profile"));
  add("ETS2 experience",answer(answers,"how long have you played","driving hours"));
  add("Previous VTC",answer(answers,"previously been part of a vtc"));add("Recent bans",answer(answers,"bans in the last 12 months"));
  add("Why Sterling?",answer(answers,"why do you want to join"));add("Availability",answer(answers,"how often do you expect to drive"));
  add("Tracker agreement",answer(answers,"install and use the official sterling tracker"),true);add("55% income understood",answer(answers,"55% of recorded job revenue"),true);
  add("Why they would be a good driver",answer(answers,"what would make you a good sterling"));
  return new EmbedBuilder().setTitle(`📋 Sterling Driver Application • ${code}`).setDescription("Submitted through the Sterling Logistics Google application form.").addFields(fields.slice(0,25)).setTimestamp().setFooter({text:"Staff review • Accept or Decline below"});
}

export function registerGoogleApplicationRoutes(app,client,c){
  app.post("/api/recruitment/google-form",async(req,res)=>{
    try{
      const secret=clean(process.env.GOOGLE_FORM_WEBHOOK_SECRET);if(!secret)return res.status(503).json({ok:false,error:"Google Forms webhook is not configured"});
      if(clean(req.headers["x-sterling-form-secret"])!==secret)return res.status(401).json({ok:false,error:"Unauthorized"});
      await ensureSchema();
      const answers=req.body?.answers||req.body||{};const guild=await client.guilds.fetch(c.guildId);
      const discordId=answer(answers,"discord user id","discord id");const discordName=answer(answers,"discord username");const member=await resolveDiscordMember(guild,discordId,discordName);
      if(!member)return res.status(400).json({ok:false,error:"Applicant could not be matched to a Discord member. Add a Discord User ID question to the form for reliable matching."});
      const[old]=await db().execute("SELECT id,application_code,status FROM applications WHERE discord_id=? AND status IN ('pending','interview','hold') LIMIT 1",[member.id]);
      if(old[0])return res.status(409).json({ok:false,error:`Active application already exists: ${old[0].application_code||old[0].id}`});
      const country=answer(answers,"country / time zone","country");const tmp=answer(answers,"truckersmp");const exp=[answer(answers,"how long have you played"),answer(answers,"driving hours"),answer(answers,"driving style")].filter(Boolean).join(" • ");const availability=answer(answers,"how often do you expect to drive");const motivation=answer(answers,"why do you want to join");
      const[r]=await db().execute("INSERT INTO applications(discord_id,country,timezone,ets2_experience,truckersmp_id,availability,motivation,agreed_rules,source,external_answers_json) VALUES(?,?,?,?,?,?,?,?,?,?)",[member.id,country||null,country||null,exp||null,tmp||null,availability||null,motivation||null,1,"google_forms",JSON.stringify(answers)]);
      const code=`SL-APP-${String(r.insertId).padStart(4,"0")}`;await db().execute("UPDATE applications SET application_code=? WHERE id=?",[code,r.insertId]);
      const ch=await ensureReviewChannel(guild);const msg=await ch.send({embeds:[embedFor(code,member,answers)],components:[reviewButtons(r.insertId)]});
      await db().execute("UPDATE applications SET review_channel_id=?,review_message_id=? WHERE id=?",[ch.id,msg.id,r.insertId]);
      res.json({ok:true,applicationId:r.insertId,applicationCode:code});
    }catch(e){console.error("[Google Application]",e);res.status(500).json({ok:false,error:String(e.message||e)});}
  });
}

function isStaff(i){return i.memberPermissions?.has(PermissionFlagsBits.ManageGuild)||i.member?.roles?.cache?.some(r=>STAFF_ROLE_NAMES.some(n=>r.name.toLowerCase()===n.toLowerCase()));}
async function updateReviewMessage(i,a,status,note){
  try{const ch=await i.guild.channels.fetch(a.review_channel_id);const m=await ch.messages.fetch(a.review_message_id);const e=EmbedBuilder.from(m.embeds[0]).setFooter({text:`${status.toUpperCase()} by ${i.user.username}${note?` • ${note}`:""}`});await m.edit({embeds:[e],components:[]});}catch{}
}

export async function handleGoogleApplicationButton(i){
  if(!i.customId.startsWith("googleapp_"))return false;if(!isStaff(i)){await i.reply({content:"Only Sterling management can review applications.",flags:MessageFlags.Ephemeral});return true;}
  const [action,idText]=i.customId.split(":");const id=Number(idText);const[rows]=await db().execute("SELECT * FROM applications WHERE id=? LIMIT 1",[id]);const a=rows[0];if(!a){await i.reply({content:"Application not found.",flags:MessageFlags.Ephemeral});return true;}if(a.status!=="pending"){await i.reply({content:`Application is already ${a.status}.`,flags:MessageFlags.Ephemeral});return true;}
  if(action==="googleapp_decline"){
    const modal=new ModalBuilder().setCustomId(`googleapp_decline_modal:${id}`).setTitle("Decline Sterling Application");modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("reason").setLabel("Reason for decline").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(900)));await i.showModal(modal);return true;
  }
  if(action==="googleapp_accept"){
    await i.deferReply({flags:MessageFlags.Ephemeral});const member=await i.guild.members.fetch(a.discord_id);const d=await createDriver(a.discord_id,member.user.username,a.truckersmp_id);
    await db().execute("UPDATE applications SET status='accepted',reviewer_id=?,decision_reason='Accepted via Discord review',decided_at=NOW() WHERE id=?",[i.user.id,id]);
    const role=i.guild.roles.cache.find(r=>DRIVER_ROLE_NAMES.some(n=>r.name.toLowerCase()===n.toLowerCase()));if(role)await member.roles.add(role).catch(()=>{});
    try{await member.send(`✅ Your Sterling Logistics application **${a.application_code}** has been accepted.\n\nSterling Driver ID: **${d.sterling_driver_id}**\nTracker: ${TRACKER_URL}\nApproved jobs currently pay **55% of recorded job revenue** to the driver.\n\nWelcome to Sterling Logistics.`);}catch{}
    await updateReviewMessage(i,a,"accepted");await i.editReply(`✅ ${a.application_code} accepted • Driver ID **${d.sterling_driver_id}**`);return true;
  }
  return false;
}

export async function handleGoogleApplicationDeclineModal(i){
  if(!i.customId.startsWith("googleapp_decline_modal:"))return false;if(!isStaff(i)){await i.reply({content:"Only Sterling management can review applications.",flags:MessageFlags.Ephemeral});return true;}
  const id=Number(i.customId.split(":")[1]);const reason=clean(i.fields.getTextInputValue("reason"));const[rows]=await db().execute("SELECT * FROM applications WHERE id=? LIMIT 1",[id]);const a=rows[0];if(!a){await i.reply({content:"Application not found.",flags:MessageFlags.Ephemeral});return true;}if(a.status!=="pending"){await i.reply({content:`Application is already ${a.status}.`,flags:MessageFlags.Ephemeral});return true;}
  await db().execute("UPDATE applications SET status='rejected',reviewer_id=?,decision_reason=?,decided_at=NOW() WHERE id=?",[i.user.id,reason,id]);
  const member=await i.guild.members.fetch(a.discord_id).catch(()=>null);if(member){try{await member.send(`❌ Your Sterling Logistics application **${a.application_code}** was declined.\n\nReason: ${reason}\n\nYou may contact a member of staff if you need clarification.`);}catch{}}
  await updateReviewMessage(i,a,"declined",reason);await i.reply({content:`❌ ${a.application_code} declined.`,flags:MessageFlags.Ephemeral});return true;
}
