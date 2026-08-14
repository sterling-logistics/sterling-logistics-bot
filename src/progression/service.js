import {db} from "../database/mysql.js";
import {calculateDriveScore} from "../economy/service.js";

const RANKS=[
  {name:"Trainee Driver",miles:0,jobs:0,score:0},
  {name:"Driver",miles:500,jobs:5,score:70},
  {name:"Senior Driver",miles:2500,jobs:25,score:80},
  {name:"Elite Driver",miles:7500,jobs:75,score:88},
  {name:"Veteran Driver",miles:15000,jobs:150,score:92}
];

function rankFor(miles,jobs,score){let rank=RANKS[0];for(const r of RANKS){if(miles>=r.miles&&jobs>=r.jobs&&score>=r.score)rank=r;}return rank;}

async function awardOnce(driverId,name,description){
  const[r]=await db().execute("SELECT id FROM achievements WHERE driver_id=? AND name=? LIMIT 1",[driverId,name]);
  if(r[0])return false;
  await db().execute("INSERT INTO achievements(driver_id,name,description,awarded_by) VALUES(?,?,?,'SYSTEM')",[driverId,name,description]);
  return true;
}

export async function processDriverProgression(driverId){
  const[d]=await db().execute("SELECT id,rank_name,total_miles,jobs_completed,status FROM drivers WHERE id=? LIMIT 1",[driverId]);
  const x=d[0];if(!x||x.status!=='active')return null;
  if(['Owner','Founder','Executive Management','Senior Management'].includes(x.rank_name))return null;
  const score=await calculateDriveScore(driverId);
  const earned=rankFor(Number(x.total_miles||0),Number(x.jobs_completed||0),score.score);
  const storedIndex=RANKS.findIndex(r=>r.name===x.rank_name);
  const earnedIndex=RANKS.findIndex(r=>r.name===earned.name);
  let promoted=false,newRank=x.rank_name;
  if(earnedIndex>storedIndex){
    newRank=earned.name;
    await db().execute("UPDATE drivers SET rank_name=?,safety_score=? WHERE id=?",[newRank,score.score,driverId]);
    await db().execute("INSERT INTO promotions(driver_id,old_rank,new_rank,promoted_by) VALUES(?,?,?,'SYSTEM')",[driverId,x.rank_name,newRank]);
    promoted=true;
  }else await db().execute("UPDATE drivers SET safety_score=? WHERE id=?",[score.score,driverId]);

  const miles=Number(x.total_miles||0),jobs=Number(x.jobs_completed||0);
  const awards=[];
  if(miles>=1000&&await awardOnce(driverId,"1,000 Mile Club","Completed 1,000 tracked Sterling miles."))awards.push("1,000 Mile Club");
  if(miles>=5000&&await awardOnce(driverId,"5,000 Mile Club","Completed 5,000 tracked Sterling miles."))awards.push("5,000 Mile Club");
  if(jobs>=25&&await awardOnce(driverId,"25 Deliveries","Completed 25 tracked Sterling deliveries."))awards.push("25 Deliveries");
  if(jobs>=100&&await awardOnce(driverId,"Century Hauler","Completed 100 tracked Sterling deliveries."))awards.push("Century Hauler");
  if(score.score>=98&&jobs>=10&&await awardOnce(driverId,"Safety First","Maintained a DriveScore of 98+ with at least 10 deliveries."))awards.push("Safety First");
  return{rank:newRank,promoted,oldRank:x.rank_name,driveScore:score.score,awards};
}

export async function getProgression(driverId){
  const[d]=await db().execute("SELECT rank_name,total_miles,jobs_completed FROM drivers WHERE id=? LIMIT 1",[driverId]);const x=d[0];if(!x)return null;
  const score=await calculateDriveScore(driverId);const earned=rankFor(Number(x.total_miles||0),Number(x.jobs_completed||0),score.score);const storedIdx=RANKS.findIndex(r=>r.name===x.rank_name);const next=storedIdx>=0?RANKS[storedIdx+1]||null:RANKS[1];
  return{earned:earned.name,current:x.rank_name,miles:Number(x.total_miles||0),jobs:Number(x.jobs_completed||0),score:score.score,next};
}

export const progressionRanks=RANKS;
