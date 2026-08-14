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
  }catch(e){
    if(e.code==="ER_DUP_ENTRY")return {inserted:false,amount:value};
    throw e;
  }
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

export async function recordFuelExpense(driverId,liters,sessionId,fuelStopId){
  const l=Math.max(0,num(liters));
  const amount=Math.round(l*FUEL_PRICE_PER_LITRE*100)/100;
  return addLedger(driverId,"expense",amount,"fuel",`fuel:${fuelStopId||`${sessionId}:${Date.now()}`}`,{liters:l,pricePerLitre:FUEL_PRICE_PER_LITRE});
}

export async function recordFineExpense(driverId,data,sessionId){
  const amount=Math.max(0,num(data.fineAmount||data.fine_amount||data.amount));
  if(!amount)return {inserted:false,amount:0};
  const key=`fine:${sessionId}:${String(data.fineOffence||data.offence||"unknown").slice(0,80)}:${Math.round(amount)}:${String(data.gameTime||data.gameTimeMinutes||"")}`;
  return addLedger(driverId,"expense",amount,"fine",key,{offence:data.fineOffence||data.offence||"Unknown"});
}

export async function calculateDriveScore(driverId){
  const[[crashRow],[eventRows]] = await Promise.all([
    db().execute("SELECT COUNT(*) crashes FROM driver_incidents WHERE driver_id=? AND occurred_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)",[driverId]),
    db().execute(`SELECT SUM(event_type='fine') fines,SUM(event_type='job-cancelled') cancellations,SUM(event_type='job-delivered') deliveries FROM telemetry_events WHERE driver_id=? AND occurred_at>=DATE_SUB(NOW(),INTERVAL 30 DAY)`,[driverId])
  ]);
  const crashes=num(crashRow[0]?.crashes),fines=num(eventRows[0]?.fines),cancellations=num(eventRows[0]?.cancellations),deliveries=num(eventRows[0]?.deliveries);
  const score=clamp(100-(crashes*8)-(fines*3)-(cancellations*2),0,100);
  return {score,crashes,fines,cancellations,deliveries};
}

export async function getDriverEconomy(driverId){
  await ensureEconomySchema();
  const[[walletRows],[ledgerRows]]=await Promise.all([
    db().execute("SELECT balance,total_earned,total_withdrawn,paid_jobs FROM driver_wallets WHERE driver_id=? LIMIT 1",[driverId]),
    db().execute(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expenses FROM economy_transactions WHERE driver_id=?`,[driverId])
  ]);
  const w=walletRows[0]||{};const l=ledgerRows[0]||{};
  return {balance:num(w.balance),totalEarned:num(w.total_earned),totalWithdrawn:num(w.total_withdrawn),paidJobs:num(w.paid_jobs),income:num(l.income),expenses:num(l.expenses),net:num(l.income)-num(l.expenses)};
}

export async function getCompanyEconomy(){
  await ensureEconomySchema();
  const[r]=await db().query(`SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount ELSE 0 END),0) income,COALESCE(SUM(CASE WHEN type='expense' THEN amount ELSE 0 END),0) expenses,COALESCE(SUM(CASE WHEN category='driver_payment' THEN amount ELSE 0 END),0) driver_payments,COALESCE(SUM(CASE WHEN category='fuel' THEN amount ELSE 0 END),0) fuel,COALESCE(SUM(CASE WHEN category='fine' THEN amount ELSE 0 END),0) fines FROM economy_transactions`);
  const x=r[0]||{};return {income:num(x.income),expenses:num(x.expenses),net:num(x.income)-num(x.expenses),driverPayments:num(x.driver_payments),fuel:num(x.fuel),fines:num(x.fines)};
}

export const economySettings={driverPayRate:DRIVER_PAY_RATE,fuelPricePerLitre:FUEL_PRICE_PER_LITRE};
