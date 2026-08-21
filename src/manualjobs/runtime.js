import {Client,Events,EmbedBuilder,MessageFlags,PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
import {loadConfig} from "../config.js";
import {db} from "../database/mysql.js";
import {settleCompletedLoad} from "../economy/service.js";

const admin=PermissionFlagsBits.Administrator;
let schemaReady=false;

async function ensureManualJobSchema(){
  if(schemaReady)return;
  const alters=[
    "ALTER TABLE jobs ADD COLUMN submission_source VARCHAR(30) NOT NULL DEFAULT 'tracker'",
    "ALTER TABLE jobs ADD COLUMN submitted_by VARCHAR(32) NULL",
    "ALTER TABLE jobs ADD COLUMN proof_url TEXT NULL",
    "ALTER TABLE jobs ADD COLUMN reviewed_by VARCHAR(32) NULL",
    "ALTER TABLE jobs ADD COLUMN reviewed_at TIMESTAMP NULL",
    "ALTER TABLE jobs ADD COLUMN review_notes VARCHAR(1000) NULL",
    "ALTER TABLE jobs ADD COLUMN manual_submitted_at TIMESTAMP NULL"
  ];
  for(const q of alters){
    try{await db().query(q);}catch(e){if(e.code!=="ER_DUP_FIELDNAME")throw e;}
  }
  schemaReady=true;
}

async function audit(actor,action,target,details){
  try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[actor,action,target||null,details||null]);}catch{}
}

async function getDriver(discordId){
  const [rows]=await db().execute("SELECT * FROM drivers WHERE discord_id=? LIMIT 1",[discordId]);
  return rows[0]||null;
}

function money(v){return `£${Number(v||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;}

function commandData(){return[
  new SlashCommandBuilder().setName("joblog").setDescription("Submit a completed ETS2 job manually for staff approval")
    .addStringOption(o=>o.setName("origin").setDescription("Origin city").setRequired(true).setMaxLength(150))
    .addStringOption(o=>o.setName("destination").setDescription("Destination city").setRequired(true).setMaxLength(150))
    .addStringOption(o=>o.setName("cargo").setDescription("Cargo delivered").setRequired(true).setMaxLength(150))
    .addNumberOption(o=>o.setName("miles").setDescription("Distance completed in miles").setRequired(true).setMinValue(0.1).setMaxValue(10000))
    .addNumberOption(o=>o.setName("income").setDescription("ETS2 job income").setRequired(false).setMinValue(0).setMaxValue(1000000000))
    .addStringOption(o=>o.setName("truck").setDescription("Truck used").setRequired(false).setMaxLength(150))
    .addStringOption(o=>o.setName("trailer").setDescription("Trailer used").setRequired(false).setMaxLength(150))
    .addNumberOption(o=>o.setName("weight").setDescription("Cargo weight in kg").setRequired(false).setMinValue(0).setMaxValue(200000))
    .addNumberOption(o=>o.setName("damage").setDescription("Cargo damage percentage, 0-100").setRequired(false).setMinValue(0).setMaxValue(100))
    .addAttachmentOption(o=>o.setName("proof").setDescription("Optional delivery screenshot/proof").setRequired(false)),
  new SlashCommandBuilder().setName("jobpending").setDescription("View pending manual job submissions").setDefaultMemberPermissions(admin),
  new SlashCommandBuilder().setName("jobreview").setDescription("Approve or reject a manual job submission").setDefaultMemberPermissions(admin)
    .addStringOption(o=>o.setName("code").setDescription("Manual job code, e.g. MAN-00001").setRequired(true).setMaxLength(30))
    .addStringOption(o=>o.setName("decision").setDescription("Review decision").setRequired(true).addChoices({name:"Approve",value:"approve"},{name:"Reject",value:"reject"}))
    .addStringOption(o=>o.setName("notes").setDescription("Review notes or rejection reason").setRequired(false).setMaxLength(1000))
].map(x=>x.toJSON());}

async function registerCommands(){
  const c=loadConfig();
  const r=new REST({version:"10"}).setToken(c.token);
  const route=Routes.applicationGuildCommands(c.applicationId,c.guildId);
  const existing=await r.get(route);
  for(const body of commandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await r.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
    else await r.post(route,{body});
  }
  await ensureManualJobSchema();
  console.log("[Manual Jobs] commands registered");
}

async function submitManualJob(i){
  await ensureManualJobSchema();
  const d=await getDriver(i.user.id);
  if(!d)return i.reply({content:"You need an active Sterling driver profile before you can submit a job.",flags:MessageFlags.Ephemeral});
  if(d.status!=="active"&&d.status!=="loa")return i.reply({content:`Your Sterling driver status is **${d.status}**. Manual jobs cannot be submitted from this status.`,flags:MessageFlags.Ephemeral});

  const origin=i.options.getString("origin",true).trim();
  const destination=i.options.getString("destination",true).trim();
  const cargo=i.options.getString("cargo",true).trim();
  const miles=i.options.getNumber("miles",true);
  const income=i.options.getNumber("income")||0;
  const truck=i.options.getString("truck")?.trim()||null;
  const trailer=i.options.getString("trailer")?.trim()||null;
  const weight=i.options.getNumber("weight")||null;
  const damagePct=i.options.getNumber("damage")||0;
  const proof=i.options.getAttachment("proof");

  const [r]=await db().execute(`INSERT INTO jobs(driver_id,truck_model,trailer,cargo,cargo_weight_kg,origin_city,destination_city,distance_miles,income,cargo_damage,status,started_at,completed_at,submission_source,submitted_by,proof_url,manual_submitted_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,'pending_review',NOW(),NOW(),'manual',?,?,NOW())`,
    [d.id,truck,trailer,cargo,weight,origin,destination,miles,income,damagePct/100,i.user.id,proof?.url||null]);
  const code=`MAN-${String(r.insertId).padStart(5,"0")}`;
  await db().execute("UPDATE jobs SET job_code=? WHERE id=?",[code,r.insertId]);
  await audit(i.user.id,"job.manual.submit",i.user.id,`${code} | ${origin} -> ${destination} | ${miles} mi | ${cargo}`);

  const embed=new EmbedBuilder().setTitle(`Manual Job Submitted | ${code}`).setDescription("Your job has been saved and is **pending staff approval**. It will not count toward your official Sterling statistics and **no wallet balance will be credited** until staff approve it.").addFields(
    {name:"Route",value:`${origin} → ${destination}`},
    {name:"Cargo",value:cargo,inline:true},
    {name:"Distance",value:`${Number(miles).toFixed(1)} mi`,inline:true},
    {name:"Income",value:money(income),inline:true},
    {name:"Proof",value:proof?"Attached":"Not supplied",inline:true}
  ).setFooter({text:"Sterling Logistics • Manual Job Verification"});
  if(proof?.contentType?.startsWith("image/"))embed.setImage(proof.url);
  return i.reply({embeds:[embed],flags:MessageFlags.Ephemeral});
}

async function pendingJobs(i){
  await ensureManualJobSchema();
  const [rows]=await db().execute(`SELECT j.job_code,j.origin_city,j.destination_city,j.cargo,j.distance_miles,j.income,j.proof_url,j.manual_submitted_at,d.discord_id,d.sterling_driver_id
    FROM jobs j JOIN drivers d ON d.id=j.driver_id
    WHERE j.submission_source='manual' AND j.status='pending_review'
    ORDER BY j.manual_submitted_at ASC,j.id ASC LIMIT 25`);
  const text=rows.length?rows.map(x=>`**${x.job_code}** • <@${x.discord_id}> (${x.sterling_driver_id||"No ID"})\n${x.origin_city} → ${x.destination_city} • **${Number(x.distance_miles||0).toFixed(1)} mi** • ${x.cargo}${x.proof_url?` • [proof](${x.proof_url})`:""}`).join("\n\n"):"✅ There are no manual jobs waiting for review.";
  return i.reply({embeds:[new EmbedBuilder().setTitle("Pending Manual Jobs").setDescription(text.slice(0,3900)).setFooter({text:`${rows.length} submission${rows.length===1?"":"s"} shown`})],flags:MessageFlags.Ephemeral});
}

async function reviewJob(i){
  await ensureManualJobSchema();
  const code=i.options.getString("code",true).trim().toUpperCase();
  const decision=i.options.getString("decision",true);
  const notes=i.options.getString("notes")?.trim()||null;
  const pool=db();
  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();
    const [rows]=await conn.execute(`SELECT j.*,d.discord_id,d.sterling_driver_id FROM jobs j JOIN drivers d ON d.id=j.driver_id WHERE j.job_code=? AND j.submission_source='manual' LIMIT 1 FOR UPDATE`,[code]);
    const j=rows[0];
    if(!j){await conn.rollback();return i.reply({content:"Manual job code not found.",flags:MessageFlags.Ephemeral});}
    if(j.status!=="pending_review"){await conn.rollback();return i.reply({content:`**${code}** has already been reviewed. Current status: **${j.status}**.`,flags:MessageFlags.Ephemeral});}

    if(decision==="approve"){
      await conn.execute("UPDATE jobs SET status='completed',reviewed_by=?,reviewed_at=NOW(),review_notes=?,completed_at=COALESCE(completed_at,NOW()) WHERE id=?",[i.user.id,notes,j.id]);
      await conn.execute("UPDATE drivers SET total_miles=total_miles+?,monthly_miles=monthly_miles+?,jobs_completed=jobs_completed+1 WHERE id=?",[Number(j.distance_miles||0),Number(j.distance_miles||0),j.driver_id]);
    }else{
      await conn.execute("UPDATE jobs SET status='rejected',reviewed_by=?,reviewed_at=NOW(),review_notes=? WHERE id=?",[i.user.id,notes||"Rejected by staff",j.id]);
    }
    await conn.commit();

    let settlement={credited:false,payment:0,revenue:Number(j.income||0)};
    if(decision==="approve"){
      settlement=await settleCompletedLoad(j.driver_id,{
        revenue:Number(j.income||0),
        sourceCity:j.origin_city,
        destinationCity:j.destination_city,
        cargo:j.cargo
      },`manual:${j.id}`);
    }

    await audit(i.user.id,`job.manual.${decision}`,j.discord_id,`${code} | ${j.origin_city} -> ${j.destination_city} | ${Number(j.distance_miles||0)} mi${decision==="approve"?` | wallet credit ${money(settlement.payment||0)}`:""}${notes?` | ${notes}`:""}`);

    const approved=decision==="approve";
    return i.reply({embeds:[new EmbedBuilder().setTitle(`${approved?"✅ Approved":"❌ Rejected"} | ${code}`).setDescription(`<@${j.discord_id}> • ${j.sterling_driver_id||"Sterling driver"}`).addFields(
      {name:"Route",value:`${j.origin_city||"?"} → ${j.destination_city||"?"}`},
      {name:"Cargo",value:j.cargo||"Unknown",inline:true},
      {name:"Distance",value:`${Number(j.distance_miles||0).toFixed(1)} mi`,inline:true},
      {name:"Decision",value:approved?"Approved and added to official driver statistics":"Rejected and excluded from driver statistics"},
      {name:"Driver Wallet",value:approved?(Number(j.income||0)>0?(settlement.credited?`Credited **${money(settlement.payment)}** after approval.`:"No duplicate credit was made."):"No income was supplied, so no balance was credited."):"No balance credited."},
      {name:"Review Notes",value:notes||"None"}
    )]});
  }catch(e){
    try{await conn.rollback();}catch{}
    throw e;
  }finally{conn.release();}
}

async function handleInteraction(i){
  if(!i.isChatInputCommand())return;
  if(i.commandName==="joblog")return submitManualJob(i);
  if(i.commandName==="jobpending")return pendingJobs(i);
  if(i.commandName==="jobreview")return reviewJob(i);
}

const originalLogin=Client.prototype.login;
if(!Client.prototype.__sterlingManualJobsPatched){
  Object.defineProperty(Client.prototype,"__sterlingManualJobsPatched",{value:true,configurable:false});
  Client.prototype.login=function(...args){
    if(!this.__sterlingManualJobsRuntime){
      Object.defineProperty(this,"__sterlingManualJobsRuntime",{value:true,configurable:false});
      this.on(Events.InteractionCreate,async i=>{try{await handleInteraction(i);}catch(e){console.error("[Manual Jobs] interaction",e);try{if(!i.replied&&!i.deferred)await i.reply({content:"Sterling could not process that manual job request.",flags:MessageFlags.Ephemeral});}catch{}}});
      this.once(Events.ClientReady,()=>{
        const run=()=>registerCommands().catch(e=>console.error("[Manual Jobs] registration",e));
        setTimeout(run,7000);
        setTimeout(run,25000);
      });
    }
    return originalLogin.apply(this,args);
  };
}
