import fs from "node:fs";

const read=p=>fs.readFileSync(new URL(`../${p}`,import.meta.url),"utf8");
const telemetry=read("src/telemetry/service.js");
const persistence=read("src/jobs/persistence.js");
const approvals=read("src/approvals/service.js");
const runtime=read("src/approvals/runtime.js");
const manual=read("src/manualjobs/runtime.js");
const index=read("src/index.js");

const checks=[
  [telemetry.includes("queueTrackedJobForApproval"),"tracker delivery is queued for approval"],
  [!telemetry.includes("settleCompletedLoad"),"tracker telemetry does not pay immediately"],
  [persistence.includes('"pending_review"'),"tracked job persistence holds delivered jobs pending review"],
  [approvals.includes("UPDATE drivers SET total_miles=total_miles+?"),"approval releases official driver stats"],
  [approvals.includes("INSERT INTO driver_wallets"),"approval releases driver wallet pay"],
  [approvals.includes("UPDATE jobs SET status='completed'"),"approval marks the matching job completed"],
  [approvals.includes("UPDATE jobs SET status='rejected'"),"decline marks the matching job rejected"],
  [approvals.includes("processDriverProgression"),"approval runs driver progression"],
  [runtime.includes('setName("jobapprovals")')&&runtime.includes('setName("jobdecision")'),"management approval commands are registered"],
  [manual.includes("pending_review")&&manual.includes("settleCompletedLoad"),"manual fallback also requires approval before pay"],
  [index.includes('import "./approvals/runtime.js"'),"approval runtime loads on bot startup"]
];

let failed=false;
for(const[ok,label]of checks){console.log(`${ok?"PASS":"FAIL"} ${label}`);if(!ok)failed=true;}
if(failed)process.exit(1);
console.log("Sterling approval-flow guard passed.");
