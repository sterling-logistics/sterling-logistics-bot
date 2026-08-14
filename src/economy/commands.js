import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";
import {getDriver} from "../drivers/service.js";
import {getDriverEconomy,getCompanyEconomy,calculateDriveScore,economySettings} from "./service.js";

const money=v=>`£${Number(v||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;

export async function handleWallet(i){
  const u=i.options.getUser("user")||i.user;
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const [e,s]=await Promise.all([getDriverEconomy(d.id),calculateDriveScore(d.id)]);
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Sterling Driver Wallet | ${d.sterling_driver_id}`).setDescription(`<@${d.discord_id}>`).addFields(
    {name:"Available Balance",value:money(e.balance),inline:true},
    {name:"Total Load Pay",value:money(e.totalEarned),inline:true},
    {name:"Paid Loads",value:String(e.paidJobs),inline:true},
    {name:"Driver Pay Rate",value:`${(economySettings.driverPayRate*100).toFixed(0)}%`,inline:true},
    {name:"DriveScore",value:`${s.score.toFixed(0)}/100`,inline:true},
    {name:"Company Revenue Generated",value:money(e.income),inline:true}
  )]});
}

export async function handlePayslip(i){
  const u=i.options.getUser("user")||i.user;
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  await getDriverEconomy(d.id);
  const [rows]=await db().execute(`SELECT type,amount,category,details_json,created_at FROM economy_transactions WHERE driver_id=? AND category IN ('driver_payment','job_revenue','fuel','fine') ORDER BY created_at DESC LIMIT 12`,[d.id]);
  const text=rows.length?rows.map(r=>{
    const sign=r.category==='job_revenue'?'+':'-';
    const labels={driver_payment:'Driver pay',job_revenue:'Load revenue',fuel:'Fuel',fine:'Fine'};
    return `**${labels[r.category]||r.category}** — ${sign}${money(r.amount)} — ${r.created_at}`;
  }).join("\n"):"No economy transactions recorded yet.";
  const e=await getDriverEconomy(d.id);
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Payslip | ${d.sterling_driver_id}`).setDescription(text.slice(0,3900)).addFields({name:"Current Driver Balance",value:money(e.balance),inline:true},{name:"Lifetime Load Pay",value:money(e.totalEarned),inline:true})]});
}

export async function handleFinance(i){
  const e=await getCompanyEconomy();
  const retained=e.income-e.driverPayments;
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics | Company Finance").addFields(
    {name:"Gross Load Revenue",value:money(e.income),inline:true},
    {name:"Driver Payments",value:money(e.driverPayments),inline:true},
    {name:"Retained After Driver Pay",value:money(retained),inline:true},
    {name:"Fuel Costs",value:money(e.fuel),inline:true},
    {name:"Fines",value:money(e.fines),inline:true},
    {name:"Total Expenses",value:money(e.expenses),inline:true},
    {name:"Net Company Position",value:money(e.net),inline:false},
    {name:"Standard Driver Share",value:`${(economySettings.driverPayRate*100).toFixed(0)}% of completed tracked load revenue`,inline:false}
  )]});
}
