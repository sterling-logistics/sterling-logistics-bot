import {db} from "../database/mysql.js";

const RESET_KEY="fresh-company-reset-2026-08-22-v1";

async function tableExists(conn,name){
  const[rows]=await conn.execute("SELECT 1 ok FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1",[name]);
  return Boolean(rows[0]);
}

async function clearIfExists(conn,name){
  if(!await tableExists(conn,name))return false;
  await conn.query(`DELETE FROM \`${name}\``);
  return true;
}

export async function runFreshCompanyResetOnce(){
  const pool=db();
  await pool.query(`CREATE TABLE IF NOT EXISTS maintenance_markers(
    marker_key VARCHAR(120) PRIMARY KEY,
    completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    details VARCHAR(500) NULL)`);
  const[done]=await pool.execute("SELECT marker_key FROM maintenance_markers WHERE marker_key=? LIMIT 1",[RESET_KEY]);
  if(done[0]){
    console.log("[VTC Reset] Fresh-company reset already completed; skipping");
    return false;
  }

  const conn=await pool.getConnection();
  try{
    await conn.beginTransaction();

    // Job, approval, tracker and driving history.
    const historyTables=[
      "tracked_job_approvals","jobs","telemetry_events","telemetry_sessions","live_telemetry",
      "driver_metrics","driver_incidents","fuel_stops","ets2_payouts"
    ];
    for(const table of historyTables)await clearIfExists(conn,table);

    // Driver and company economy history/balances.
    for(const table of ["economy_transactions","driver_wallets","company_transactions","company_loans"])
      await clearIfExists(conn,table);

    // Driver progression/history tied to the old company activity.
    for(const table of ["achievements","promotions"])
      await clearIfExists(conn,table);

    // Keep driver identities and Sterling IDs, but make every operational stat fresh.
    if(await tableExists(conn,"drivers")){
      await conn.query(`UPDATE drivers SET
        total_miles=0,
        monthly_miles=0,
        jobs_completed=0,
        total_income=0,
        convoys_attended=0,
        attendance_percent=0,
        safety_score=100`);
    }

    await conn.execute("INSERT INTO maintenance_markers(marker_key,details) VALUES(?,?)",[
      RESET_KEY,
      "Fresh VTC reset: jobs, approvals, telemetry, driving metrics, wallets, company economy and progression history cleared; driver identities preserved"
    ]);
    await conn.commit();
    console.log("[VTC Reset] COMPLETE • company operational history cleared • driver identities preserved");
    return true;
  }catch(e){
    await conn.rollback();
    console.error("[VTC Reset] FAILED — transaction rolled back",e);
    throw e;
  }finally{
    conn.release();
  }
}
