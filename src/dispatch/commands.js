import {PermissionFlagsBits,REST,Routes,SlashCommandBuilder} from "discord.js";
const admin=PermissionFlagsBits.Administrator;

export function dispatchCommandData(){return[
new SlashCommandBuilder().setName("workcreate").setDescription("Assign ETS2 work to a Sterling driver").setDefaultMemberPermissions(admin)
.addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true))
.addStringOption(o=>o.setName("cargo").setDescription("Cargo to transport").setRequired(true))
.addStringOption(o=>o.setName("origin").setDescription("Origin city").setRequired(true))
.addStringOption(o=>o.setName("destination").setDescription("Destination city").setRequired(true))
.addStringOption(o=>o.setName("deadline").setDescription("Optional deadline, e.g. 2026-08-17 20:00").setRequired(false))
.addNumberOption(o=>o.setName("minmiles").setDescription("Optional minimum route miles").setRequired(false).setMinValue(0))
.addStringOption(o=>o.setName("notes").setDescription("Dispatch notes").setRequired(false)),
new SlashCommandBuilder().setName("mywork").setDescription("View your active Sterling work assignments"),
new SlashCommandBuilder().setName("workinfo").setDescription("View a Sterling work assignment").addStringOption(o=>o.setName("code").setDescription("Work code, e.g. SLW-00001").setRequired(true)),
new SlashCommandBuilder().setName("worklist").setDescription("List Sterling work assignments").setDefaultMemberPermissions(admin).addStringOption(o=>o.setName("status").setDescription("Filter by status").setRequired(false).addChoices({name:"Assigned",value:"assigned"},{name:"In Progress",value:"in_progress"},{name:"Completed",value:"completed"},{name:"Cancelled",value:"cancelled"})),
new SlashCommandBuilder().setName("workstart").setDescription("Manually mark one of your assignments in progress").addStringOption(o=>o.setName("code").setDescription("Work code").setRequired(true)),
new SlashCommandBuilder().setName("workcancel").setDescription("Cancel a Sterling work assignment").setDefaultMemberPermissions(admin).addStringOption(o=>o.setName("code").setDescription("Work code").setRequired(true)).addStringOption(o=>o.setName("reason").setDescription("Cancellation reason").setRequired(false)),
new SlashCommandBuilder().setName("workreassign").setDescription("Reassign work to another driver").setDefaultMemberPermissions(admin).addStringOption(o=>o.setName("code").setDescription("Work code").setRequired(true)).addUserOption(o=>o.setName("user").setDescription("New driver").setRequired(true)),
new SlashCommandBuilder().setName("dispatchboard").setDescription("Show active Sterling dispatch work").setDefaultMemberPermissions(admin),
new SlashCommandBuilder().setName("withdraw").setDescription("Transfer money from your Sterling wallet into your ETS2 save").addNumberOption(o=>o.setName("amount").setDescription("Amount to transfer into ETS2").setRequired(true).setMinValue(1)),
new SlashCommandBuilder().setName("companyloan").setDescription("Manage Sterling company loans").setDefaultMemberPermissions(admin)
.addSubcommand(s=>s.setName("add").setDescription("Lend money to Sterling").addUserOption(o=>o.setName("lender").setDescription("Person lending the money").setRequired(true)).addNumberOption(o=>o.setName("amount").setDescription("Loan amount").setRequired(true).setMinValue(1)).addStringOption(o=>o.setName("reason").setDescription("Reason or notes").setRequired(false)))
.addSubcommand(s=>s.setName("repay").setDescription("Repay part or all of a company loan").addIntegerOption(o=>o.setName("loan").setDescription("Loan ID").setRequired(true).setMinValue(1)).addNumberOption(o=>o.setName("amount").setDescription("Repayment amount").setRequired(true).setMinValue(1))),
new SlashCommandBuilder().setName("companyloans").setDescription("Show Sterling company loans and outstanding balances").setDefaultMemberPermissions(admin),
new SlashCommandBuilder().setName("companydeposit").setDescription("Add non-repayable capital to Sterling").setDefaultMemberPermissions(admin).addNumberOption(o=>o.setName("amount").setDescription("Amount to deposit").setRequired(true).setMinValue(1)).addStringOption(o=>o.setName("reason").setDescription("Reason or source of capital").setRequired(false)),
new SlashCommandBuilder().setName("walletcredit").setDescription("Manually credit a Sterling driver wallet").setDefaultMemberPermissions(admin).addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true)).addNumberOption(o=>o.setName("amount").setDescription("Amount to credit").setRequired(true).setMinValue(1)).addStringOption(o=>o.setName("reason").setDescription("Required audit reason").setRequired(true)),
new SlashCommandBuilder().setName("walletdebit").setDescription("Manually debit a Sterling driver wallet").setDefaultMemberPermissions(admin).addUserOption(o=>o.setName("user").setDescription("Driver").setRequired(true)).addNumberOption(o=>o.setName("amount").setDescription("Amount to debit").setRequired(true).setMinValue(1)).addStringOption(o=>o.setName("reason").setDescription("Required audit reason").setRequired(true))
].map(x=>x.toJSON());}

export async function registerDispatchCommands(c){
  const r=new REST({version:"10"}).setToken(c.token);
  const route=Routes.applicationGuildCommands(c.applicationId,c.guildId);
  const existing=await r.get(route);
  for(const body of dispatchCommandData()){
    const old=existing.find(x=>x.name===body.name);
    if(old)await r.patch(Routes.applicationGuildCommand(c.applicationId,c.guildId,old.id),{body});
    else await r.post(route,{body});
  }
}
