import {db} from "../database/mysql.js";

const num=v=>Number(v)||0;
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const DRIVER_PAY_RATE=0.35;
const FUEL_PRICE_PER_LITRE=1.70;
let schemaPromise=null;

export async function ensureEconomySchema(){
  if(schemaPromise)return schemaPromise;
  schemaPromise=(async()=>{
    await db().query(`CREATE TABLE IF NOT EXISTS driver_wallets(
      driver_id BIGINT UNSIGNED PRIMARY KEY,
      balance DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_earned DECIMAL(16,2) NOT NULL DEFAULT 0,
      total_withdrawn DECIMAL(16,2) NOT NULL DEFAULT 0,
      paid_jobs INT UNSIGNED NOT NULL DEFAULT 0,
      last_updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)`);
    await db().query(`CREATE TABLE IF NOT EXISTS economy_transactions(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      driver_id BIGINT UNSIGNED,
      type VARCHAR(30) NOT NULL,
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      category VARCHAR(60) NOT NULL,
      reference_key VARCHAR(255) NOT NULL UNIQUE,
      details_json JSON,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX(driver_id,created_at),INDEX(type,category,created_at))`);
    await db().query(`CREATE TABLE IF NOT EXISTS ets2_payouts(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      driver_id BIGINT UNSIGNED NOT NULL,
      amount DECIMAL(16,2) NOT NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'pending',
      requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      applied_at TIMESTAMP NULL,
      save_path VARCHAR(500),
      error_text VARCHAR(1000),
      INDEX(driver_id,status,requested_at))`);
    await db().query(`CREATE TABLE IF NOT EXISTS company_transactions(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      type VARCHAR(30) NOT NULL,
      category VARCHAR(60) NOT NULL,
      amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      actor_discord_id VARCHAR(32),
      reference_key VARCHAR(255) NOT NULL UNIQUE,
      details_json JSON,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      INDEX(type,category,created_at))`);
    await db().query(`CREATE TABLE IF NOT EXISTS company_loans(
      id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
      lender_discord_id VARCHAR(32) NOT NULL,
      original_amount DECIMAL(16,2) NOT NULL,
      repaid_amount DECIMAL(16,2) NOT NULL DEFAULT 0,
      reason VARCHAR(500),
      created_by VARCHAR(32) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_repaid_at TIMESTAMP NULL,
      status VARCHAR(30) NOT NULL DEFAULT 'outstanding',
      INDEX(status,created_at),INDEX(lender_discord_id,status))`);
  })();
  try{await schemaPromise;}catch(e){schemaPromise=null;throw e;}
}

async function addLedger(driverId,type,amount,category,referenceKey,details={}){
  await ensureEconomySchema();
  const value=Math.max(0,num(amount));
  if(value<=0)return {inserted:false,amount:0};
  try{
    await db().execute("INSERT INTO economy_transactions(driver_id,type,amount,category,reference_key,details_json) VALUES(?,?,?,?,?,?)",[driverId,type,value,category,referenceKey,JSON.stringify(details)]);
    return {inserted:true,amount:value};
  }catch(e){if(e.code==="ER_DUP_ENTRY")return {inserted:false,amount:value};throw e;}
}

async function addCompanyLedger(conn,type,amount,category,referenceKey,actorDiscordId,details={}){
  const value=Math.round(Math.max(0,num(amount))*100)/100;
  if(value<=0)throw new Error("Amount must be greater than zero.");
  await conn.execute("INSERT INTO company_transactions(type,category,amount,actor_discord_id,reference_key,details_json) VALUES(?,?,?,?,?,?)",[type,category,value,actorDiscordId||null,referenceKey,JSON.stringify(details)]);
  return value;
}

export async function settleCompletedLoad(driverId,data,sessionId){
  await ensureEconomySchema();
  const revenue=Math.max(0,num(data.revenue||data.jobDeliveredRevenue));
  if(!revenue)return {credited:false,payment:0,revenue:0};
  const keyBase=`job:${sessionId}:${String(data.sourceCity||"").slice(0,80)}:${String(data.destinationCity||"").slice(0,80)}:${String(data.cargo||"").slice(0,80)}:${Math.round(revenue)}`;
  const income=await addLedger(driverId,"income",revenue,"job_revenue",`${keyBase}:income`,{cargo:data.cargo,sourceCity:data.sourceCity,destinationCity:data.destinationCity});
  if(!income.inserted)return {credited:false,payment:0,revenue};
  const payment=Math.round(revenue*DRIVER_PAY_RATE*100)/100;
  await addLedger(driverId,"expense",payment,"driver_payment",`${keyBase}:pay`,{rate:DRIVER_PAY_RATE});
  await db().execute(`INSERT INTO driver_wallets(driver_id,balance,total_earned,paid_jobs) VALUES(?,?,?,1)
    ON DUPLICATE KEY UPDATE balance=balance+VALUES(balance),total_earned=total_earned+VALUES(total_earned),paid_jobs=paid_jobs+1`,[driverId,payment,payment]);
  return {credited:true,payment,revenue,rate:DRIVER_PAY_RATE};
}

export async function requestEts2Withdrawal(driverId,amount){
  await ensureEconomySchema();
  const value=Math.round(Math.max(0,num(amount))*100)/100;
  if(value<=0)throw new Error("Withdrawal amount must be greater than zero.");
  const conn=await db().getConnection();
  try{
    await conn.beginTransaction();
    const[w]=await conn.execute("SELECT balance FROM driver_wallets WHERE driver_id=? FOR UPDATE",[driverId]);
    const balance=num(w[0]?.balance);
    if(balance<value)throw new Error(`Insufficient Sterling wallet balance. Available: £${balance.toFixed(2)}`);
    await conn.execute("UPDATE driver_wallets SET balance=balance-? WHERE driver_id=?",[value,driverId]);
    const[r]=await conn.execute("INSERT INTO ets2_payouts(driver_id,amount,status) VALUES(?,?,'pending')",[driverId,value]);
    await conn.execute("INSERT INTO economy_transactions(driver_id,type,amount,category,reference_key,details_json) VALUES(?,?,?,?,?,?)",[driverId,"transfer",value,"ets2_withdrawal",`ets2-withdrawal:${r.insertId}`,JSON.stringify({payoutId:r.insertId})]);
    await conn.commit();
    return{id:r.insertId,amount:value,balance:balance-value};
  }catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

export async function getPendingEts2Payout(driverId){await ensureEconomySchema();const[r]=await db().execute("SELECT id,amount,requested_at FROM ets2_payouts WHERE driver_id=? AND status='pending' ORDER BY requested_at ASC LIMIT 1",[driverId]);return r[0]||null;}
export async function completeEts2Payout(driverId,payoutId,savePath){await ensureEconomySchema();const[r]=await db().execute("UPDATE ets2_payouts SET status='applied',applied_at=NOW(),save_path=?,error_text=NULL WHERE id=? AND driver_id=? AND status='pending'",[String(savePath||'').slice(0,500),payoutId,driverId]);if(r.affectedRows){await db().execute("UPDATE driver_wallets SET total_withdrawn=total_withdrawn+(SELECT amount FROM ets2_payouts WHERE id=?) WHERE driver_id=?",[payoutId,driverId]);}return r.affectedRows>0;}
export async function failEts2Payout(driverId,payoutId,errorText){await ensureEconomySchema();await db().execute("UPDATE ets2_payouts SET error_text=? WHERE id=? AND driver_id=? AND status='pending'",[String(errorText||'Unknown error').slice(0,1000),payoutId,driverId]);}

export async function addCompanyLoan(lenderDiscordId,amount,reason,actorDiscordId){
  await ensureEconomySchema();const value=Math.round(Math.max(0,num(amount))*100)/100;if(value<=0)throw new Error("Loan amount must be greater than zero.");
  const conn=await db().getConnection();
  try{await conn.beginTransaction();const[r]=await conn.execute("INSERT INTO company_loans(lender_discord_id,original_amount,reason,created_by) VALUES(?,?,?,?)",[lenderDiscordId,value,String(reason||'').slice(0,500)||null,actorDiscordId]);await addCompanyLedger(conn,"inflow",value,"loan_received",`loan:${r.insertId}:received`,actorDiscordId,{loanId:r.insertId,lenderDiscordId,reason});await conn.commit();return{id:r.insertId,amount:value};}catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

export async function repayCompanyLoan(loanId,amount,actorDiscordId){
  await ensureEconomySchema();const value=Math.round(Math.max(0,num(amount))*100)/100;if(value<=0)throw new Error("Repayment amount must be greater than zero.");
  const conn=await db().getConnection();
  try{await conn.beginTransaction();const[r]=await conn.execute("SELECT * FROM company_loans WHERE id=? FOR UPDATE",[loanId]);const loan=r[0];if(!loan)throw new Error("Company loan not found.");const outstanding=num(loan.original_amount)-num(loan.repaid_amount);if(outstanding<=0)throw new Error("That loan has already been fully repaid.");if(value>outstanding)throw new Error(`Maximum repayment is £${outstanding.toFixed(2)}.`);const next=num(loan.repaid_amount)+value;await conn.execute("UPDATE company_loans SET repaid_amount=?,last_repaid_at=NOW(),status=? WHERE id=?",[next,next>=num(loan.original_amount)?'repaid':'outstanding',loanId]);await addCompanyLedger(conn,"outflow",value,"loan_repayment",`loan:${loanId}:repay:${Date.now()}`,actorDiscordId,{loanId,lenderDiscordId:loan.lender_discord_id});await conn.commit();return{loanId,amount:value,outstanding:outstanding-value};}catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

export async function addCompanyDeposit(amount,reason,actorDiscordId){
  await ensureEconomySchema();const value=Math.round(Math.max(0,num(amount))*100)/100;if(value<=0)throw new Error("Deposit amount must be greater than zero.");const conn=await db().getConnection();try{await conn.beginTransaction();await addCompanyLedger(conn,"inflow",value,"capital_deposit",`capital:${Date.now()}:${actorDiscordId}`,actorDiscordId,{reason:String(reason||'').slice(0,500)});await conn.commit();return{amount:value};}catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

export async function adjustDriverWallet(driverId,amount,direction,reason,actorDiscordId){
  await ensureEconomySchema();const value=Math.round(Math.max(0,num(amount))*100)/100;if(value<=0)throw new Error("Amount must be greater than zero.");if(!['credit','debit'].includes(direction))throw new Error("Invalid wallet adjustment.");
  const conn=await db().getConnection();
  try{await conn.beginTransaction();await conn.execute("INSERT INTO driver_wallets(driver_id,balance,total_earned,paid_jobs) VALUES(?,0,0,0) ON DUPLICATE KEY UPDATE driver_id=driver_id",[driverId]);const[w]=await conn.execute("SELECT balance FROM driver_wallets WHERE driver_id=? FOR UPDATE",[driverId]);const balance=num(w[0]?.balance);if(direction==='debit'&&balance<value)throw new Error(`Driver wallet only has £${balance.toFixed(2)} available.`);const delta=direction==='credit'?value:-value;await conn.execute("UPDATE driver_wallets SET balance=balance+? WHERE driver_id=?",[delta,driverId]);await conn.execute("INSERT INTO economy_transactions(driver_id,type,amount,category,reference_key,details_json) VALUES(?,?,?,?,?,?)",[driverId,direction==='credit'?'income':'expense',value,direction==='credit'?'manual_wallet_credit':'manual_wallet_debit',`wallet:${direction}:${Date.now()}:${driverId}`,JSON.stringify({reason,actorDiscordId})]);await addCompanyLedger(conn,direction==='credit'?'outflow':'inflow',value,direction==='credit'?'wallet_credit':'wallet_debit',`company-wallet:${direction}:${Date.now()}:${driverId}`,actorDiscordId,{driverId,reason});await conn.commit();return{amount:value,balance:balance+delta};}catch(e){await conn.rollback();throw e;}finally{conn.release();}
}

export async function getCompanyLoans(){await ensureEconomySchema();const[r]=await db().query("SELECT id,lender_discord_id,original_amount,repaid_amount,(original_amount-repaid_amount) outstanding,reason,created_at,status FROM company_loans ORDER BY status='outstanding' DESC,created_at DESC LIMIT 30");return r;}

export async function recordFuelExpense(driverId,liters,sessionId,fuelStopId){const l=Math.max(0,num(liters));const amount=Math.round(l*FUEL_PRICE_PER_LITRE*100)/100;return addLedger(driverId,"expense",amount,"fuel",`fuel:${fuelStopId||`${sessionId}:${Date.now()}`}`,{liters:l,pricePerLitre:FUEL_PRICE_PER_LITRE});}
export async function recordFineExpense(driverId,data,sessionId){const amount=Math.max(0,num(data.fineAmount||data.fine_amount||data.amount));if(!amount)return {inserted:false,amount:0};const key=`fine:${sessionId}:${String(data.fineOffence||data.offence||"unknown").slice(0,80)}:${Math.round(amount)}:${String(data.gameTime||data.gameTimeMinutes||"")}`;return addLedger(driverId,"expense",amount,"fine",key,{offence:data.fineOffence||data.offence||"Unknown"});}

export async function calculateDriveScore(driverId){const[[crashRow],[eventRows]]=await Promise.all([db().execute("SELECT COUNT(*) crashes FROM driver_incidents WHERE driver_id=? AND occurred_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)",[driverId]),db().execute(`SELECT SUM(event_type='fine') fines,SUM(event_type='job-cancelled') cancellations,SUM(event_type='job-delivered') deliveries FROM telemetry_events WHERE driver_id=? AND occurred_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)`,[driverId])]);const crashes=num(crashRow[0]?.crashes),fines=num(eventRows[0]?.fines),cancellations=num(eventRows[0]?.cancellations),deliveries=num(eventRows[0]?.deliveries);const score=clamp(100-(crashes*8)-(fines*3)-(cancellations*2),0,100);return {score,crashes,fines,cancellations,deliveries};}
export async function getDriverEconomy(driverId){await ensureEconomySchema();const[[walletRows],[ledgerRows]]=await Promise.all([db().execute("SELECT balance,total_earned,total_withdrawn,paid_jobs FROM driver_wallets WHERE driver_id=? LIMIT 1",[driverId]),db().execute(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expenses FROM economy_transactions WHERE driver_id=?`,[driverId])]);const w=walletRows[0]||{},l=ledgerRows[0]||{};return {balance:num(w.balance),totalEarned:num(w.total_earned),totalWithdrawn:num(w.total_withdrawn),paidJobs:num(w.paid_jobs),income:num(l.income),expenses:num(l.expenses),net:num(l.income)-num(l.expenses)};}
export async function getCompanyEconomy(){
  await ensureEconomySchema();
  const[[ops],[manual],[loanRows]]=await Promise.all([
    db().query(`SELECT COALESCE(SUM(CASE WHEN category='job_revenue' THEN amount ELSE 0 END),0) revenue,COALESCE(SUM(CASE WHEN category='driver_payment' THEN amount ELSE 0 END),0) driver_payments,COALESCE(SUM(CASE WHEN category='fuel' THEN amount ELSE 0 END),0) fuel,COALESCE(SUM(CASE WHEN category='fine' THEN amount ELSE 0 END),0) fines FROM economy_transactions`),
    db().query(`SELECT COALESCE(SUM(CASE WHEN type='inflow' THEN amount ELSE 0 END),0) inflows,COALESCE(SUM(CASE WHEN type='outflow' THEN amount ELSE 0 END),0) outflows,COALESCE(SUM(CASE WHEN category='capital_deposit' THEN amount ELSE 0 END),0) capital,COALESCE(SUM(CASE WHEN category='loan_received' THEN amount ELSE 0 END),0) loans_received,COALESCE(SUM(CASE WHEN category='loan_repayment' THEN amount ELSE 0 END),0) loan_repayments,COALESCE(SUM(CASE WHEN category='wallet_credit' THEN amount ELSE 0 END),0) wallet_credits,COALESCE(SUM(CASE WHEN category='wallet_debit' THEN amount ELSE 0 END),0) wallet_debits FROM company_transactions`),
    db().query(`SELECT COALESCE(SUM(original_amount-repaid_amount),0) outstanding_loans FROM company_loans WHERE status='outstanding'`)
  ]);
  const o=ops[0]||{},m=manual[0]||{},l=loanRows[0]||{};const revenue=num(o.revenue),driverPayments=num(o.driver_payments),fuel=num(o.fuel),fines=num(o.fines),operatingExpenses=driverPayments+fuel+fines;const operatingProfit=revenue-operatingExpenses;const cash=revenue-operatingExpenses+num(m.inflows)-num(m.outflows);
  return{income:revenue,expenses:operatingExpenses,net:operatingProfit,operatingProfit,cash,driverPayments,fuel,fines,capital:num(m.capital),loansReceived:num(m.loans_received),loanRepayments:num(m.loan_repayments),walletCredits:num(m.wallet_credits),walletDebits:num(m.wallet_debits),outstandingLoans:num(l.outstanding_loans)};
}
export const economySettings={driverPayRate:DRIVER_PAY_RATE,fuelPricePerLitre:FUEL_PRICE_PER_LITRE};
