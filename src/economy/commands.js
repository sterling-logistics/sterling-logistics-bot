import {EmbedBuilder,MessageFlags} from "discord.js";
import {db} from "../database/mysql.js";
import {getDriver} from "../drivers/service.js";
import {getDriverEconomy,getCompanyEconomy,calculateDriveScore,economySettings,requestEts2Withdrawal,addCompanyLoan,repayCompanyLoan,addCompanyDeposit,adjustDriverWallet,getCompanyLoans} from "./service.js";

const money=v=>`£${Number(v||0).toLocaleString("en-GB",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
async function audit(actor,action,target,details){try{await db().execute("INSERT INTO audit_logs(actor_discord_id,action,target_discord_id,details) VALUES(?,?,?,?)",[actor,action,target||null,details||null]);}catch{}}

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

export async function handleWithdraw(i){
  const d=await getDriver(i.user.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  const amount=i.options.getNumber("amount",true);
  try{
    const p=await requestEts2Withdrawal(d.id,amount);
    return i.reply({content:`✅ **${money(p.amount)}** has been reserved from your Sterling wallet for ETS2.\n\nPayout ID: **#${p.id}**\nRemaining Sterling balance: **${money(p.balance)}**\n\nKeep the Sterling Tracker running. The payout will apply automatically when the linked ETS2/TMP save can be safely updated.`,flags:MessageFlags.Ephemeral});
  }catch(e){return i.reply({content:String(e.message||e),flags:MessageFlags.Ephemeral});}
}

export async function handlePayslip(i){
  const u=i.options.getUser("user")||i.user;
  const d=await getDriver(u.id);
  if(!d)return i.reply({content:"No Sterling driver profile found.",flags:MessageFlags.Ephemeral});
  await getDriverEconomy(d.id);
  const [rows]=await db().execute(`SELECT type,amount,category,details_json,created_at FROM economy_transactions WHERE driver_id=? AND category IN ('driver_payment','job_revenue','fuel','fine','ets2_withdrawal','ets2_auto_payout','manual_wallet_credit','manual_wallet_debit') ORDER BY created_at DESC LIMIT 12`,[d.id]);
  const text=rows.length?rows.map(r=>{
    const plus=new Set(['job_revenue','manual_wallet_credit']).has(r.category);const sign=plus?'+':'-';
    const labels={driver_payment:'Driver pay',job_revenue:'Load revenue',fuel:'Fuel',fine:'Fine',ets2_withdrawal:'ETS2 withdrawal',ets2_auto_payout:'Automatic ETS2 payout',manual_wallet_credit:'Manual credit',manual_wallet_debit:'Manual debit'};
    return `**${labels[r.category]||r.category}** — ${sign}${money(r.amount)} — ${r.created_at}`;
  }).join("\n"):"No economy transactions recorded yet.";
  const e=await getDriverEconomy(d.id);
  return i.reply({embeds:[new EmbedBuilder().setTitle(`Payslip | ${d.sterling_driver_id}`).setDescription(text.slice(0,3900)).addFields({name:"Current Driver Balance",value:money(e.balance),inline:true},{name:"Lifetime Load Pay",value:money(e.totalEarned),inline:true},{name:"Applied to ETS2",value:money(e.totalWithdrawn),inline:true})]});
}

export async function handleCompanyLoan(i){
  const sub=i.options.getSubcommand();
  try{
    if(sub==='add'){
      const lender=i.options.getUser('lender',true);const amount=i.options.getNumber('amount',true);const reason=i.options.getString('reason')||'Company funding';const x=await addCompanyLoan(lender.id,amount,reason,i.user.id);await audit(i.user.id,'company.loan.add',lender.id,`Loan #${x.id} ${money(x.amount)} | ${reason}`);return i.reply({content:`🏦 Added company loan **#${x.id}** from <@${lender.id}> for **${money(x.amount)}**.`});
    }
    if(sub==='repay'){
      const loanId=i.options.getInteger('loan',true);const amount=i.options.getNumber('amount',true);const x=await repayCompanyLoan(loanId,amount,i.user.id);await audit(i.user.id,'company.loan.repay',null,`Loan #${loanId} repaid ${money(x.amount)}`);return i.reply({content:`✅ Repaid **${money(x.amount)}** on company loan **#${loanId}**. Outstanding: **${money(x.outstanding)}**.`});
    }
  }catch(e){return i.reply({content:String(e.message||e),flags:MessageFlags.Ephemeral});}
}

export async function handleCompanyLoans(i){
  const rows=await getCompanyLoans();
  const text=rows.length?rows.map(r=>`**#${r.id}** — <@${r.lender_discord_id}> — ${money(r.outstanding)} outstanding / ${money(r.original_amount)} original — **${r.status}**${r.reason?` — ${r.reason}`:''}`).join('\n'):'No company loans recorded.';
  return i.reply({embeds:[new EmbedBuilder().setTitle('Sterling Logistics | Company Loans').setDescription(text.slice(0,4000))]});
}

export async function handleCompanyDeposit(i){
  try{const amount=i.options.getNumber('amount',true);const reason=i.options.getString('reason')||'Company capital';const x=await addCompanyDeposit(amount,reason,i.user.id);await audit(i.user.id,'company.deposit',null,`${money(x.amount)} | ${reason}`);return i.reply({content:`💷 Added **${money(x.amount)}** to Sterling as non-repayable company capital.\nReason: ${reason}`});}catch(e){return i.reply({content:String(e.message||e),flags:MessageFlags.Ephemeral});}
}

async function walletAdjust(i,direction){
  try{
    const u=i.options.getUser('user',true);
    const d=await getDriver(u.id);
    if(!d)return i.reply({content:'That member does not have a Sterling driver profile.',flags:MessageFlags.Ephemeral});
    const amount=i.options.getNumber('amount',true);
    const reason=i.options.getString('reason',true);
    const x=await adjustDriverWallet(d.id,amount,direction,reason,i.user.id);
    await audit(i.user.id,`wallet.${direction}`,u.id,`${money(x.amount)} | ${reason}`);

    if(direction==='credit'){
      try{
        const p=await requestEts2Withdrawal(d.id,x.amount);
        return i.reply({content:`✅ Credited **${money(x.amount)}** to <@${u.id}> and automatically queued it for their linked ETS2/TMP profile.\nPayout ID: **#${p.id}**\nSterling wallet balance: **${money(p.balance)}**.\nReason: ${reason}`});
      }catch(e){
        return i.reply({content:`✅ Credited **${money(x.amount)}** to <@${u.id}>. The credit is safe in their Sterling wallet, but automatic ETS2 payout could not be queued: **${String(e.message||e)}**\nReason: ${reason}`});
      }
    }

    return i.reply({content:`✅ Debited **${money(x.amount)}** from <@${u.id}>. New wallet balance: **${money(x.balance)}**.\nReason: ${reason}`});
  }catch(e){return i.reply({content:String(e.message||e),flags:MessageFlags.Ephemeral});}
}
export const handleWalletCredit=i=>walletAdjust(i,'credit');
export const handleWalletDebit=i=>walletAdjust(i,'debit');

export async function handleFinance(i){
  const e=await getCompanyEconomy();
  const retained=e.income-e.driverPayments;
  return i.reply({embeds:[new EmbedBuilder().setTitle("Sterling Logistics | Company Finance").addFields(
    {name:"Company Cash",value:money(e.cash),inline:true},
    {name:"Gross Load Revenue",value:money(e.income),inline:true},
    {name:"Operating Profit",value:money(e.operatingProfit),inline:true},
    {name:"Driver Payments",value:money(e.driverPayments),inline:true},
    {name:"Fuel Costs",value:money(e.fuel),inline:true},
    {name:"Fines",value:money(e.fines),inline:true},
    {name:"Capital Deposits",value:money(e.capital),inline:true},
    {name:"Loans Received",value:money(e.loansReceived),inline:true},
    {name:"Loan Repayments",value:money(e.loanRepayments),inline:true},
    {name:"Outstanding Loans",value:money(e.outstandingLoans),inline:true},
    {name:"Manual Wallet Credits",value:money(e.walletCredits),inline:true},
    {name:"Retained After Driver Pay",value:money(retained),inline:true},
    {name:"Standard Driver Share",value:`${(economySettings.driverPayRate*100).toFixed(0)}% of completed tracked load revenue`,inline:false}
  )]});
}
