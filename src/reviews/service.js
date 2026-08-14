import {ActionRowBuilder,ButtonBuilder,ButtonStyle,EmbedBuilder,MessageFlags,ModalBuilder,TextInputBuilder,TextInputStyle} from "discord.js";
import {db} from "../database/mysql.js";

const BRAND=0x5865f2;
const ticketCode=id=>`SL-TKT-${String(id).padStart(4,"0")}`;

export async function sendReviewRequest(client,ticket){
  try{
    const user=await client.users.fetch(ticket.owner_id);
    const row=new ActionRowBuilder().addComponents(
      [1,2,3,4,5].map(n=>new ButtonBuilder().setCustomId(`sterling_review:${ticket.id}:${n}`).setLabel(`${n}★`).setStyle(n>=4?ButtonStyle.Success:n===3?ButtonStyle.Primary:ButtonStyle.Secondary))
    );
    const staff=ticket.claimed_by||ticket.closed_by;
    await user.send({
      embeds:[new EmbedBuilder()
        .setTitle("⭐ How was your Sterling Logistics support?")
        .setDescription(`Your support chat **${ticketCode(ticket.id)}** has now ended.\n\nPlease rate the help you received${staff?` from <@${staff}>`:" from our team"}.\n\nChoose **1–5 stars** below. You can then leave an optional written review.`)
        .setColor(BRAND)
        .setFooter({text:"Sterling Logistics | Driven by Excellence"})],
      components:[row]
    });
  }catch(e){console.warn(`[Reviews] Could not DM review request for ticket ${ticket.id}: ${e.message}`);}
}

export async function handleReviewButton(i){
  const [,ticketIdRaw,ratingRaw]=i.customId.split(":");
  const ticketId=Number(ticketIdRaw),rating=Number(ratingRaw);
  if(!Number.isInteger(ticketId)||rating<1||rating>5)return i.reply({content:"Invalid review.",flags:MessageFlags.Ephemeral});
  const[rows]=await db().execute("SELECT * FROM tickets WHERE id=? LIMIT 1",[ticketId]);
  const t=rows[0];
  if(!t)return i.reply({content:"That ticket could not be found.",flags:MessageFlags.Ephemeral});
  if(i.user.id!==t.owner_id)return i.reply({content:"Only the person who opened this ticket can review it.",flags:MessageFlags.Ephemeral});
  if(t.reviewed_at)return i.reply({content:"You have already reviewed this support chat. Thank you.",flags:MessageFlags.Ephemeral});
  const modal=new ModalBuilder().setCustomId(`sterling_review_modal:${ticketId}:${rating}`).setTitle(`${rating}★ Sterling Logistics Review`);
  const feedback=new TextInputBuilder().setCustomId("feedback").setLabel("Tell us about your experience (optional)").setStyle(TextInputStyle.Paragraph).setRequired(false).setMaxLength(1000).setPlaceholder("What went well, or what could we improve?");
  modal.addComponents(new ActionRowBuilder().addComponents(feedback));
  await i.showModal(modal);
}

export async function handleReviewModal(i,client,c){
  const [,ticketIdRaw,ratingRaw]=i.customId.split(":");
  const ticketId=Number(ticketIdRaw),rating=Number(ratingRaw);
  const feedback=(i.fields.getTextInputValue("feedback")||"").trim();
  const[rows]=await db().execute("SELECT * FROM tickets WHERE id=? LIMIT 1",[ticketId]);
  const t=rows[0];
  if(!t)return i.reply({content:"That ticket could not be found.",flags:MessageFlags.Ephemeral});
  if(i.user.id!==t.owner_id)return i.reply({content:"Only the ticket owner can submit this review.",flags:MessageFlags.Ephemeral});
  if(t.reviewed_at)return i.reply({content:"This ticket has already been reviewed.",flags:MessageFlags.Ephemeral});
  await db().execute("UPDATE tickets SET review_rating=?,reviewed_at=NOW() WHERE id=?",[rating,ticketId]);
  await db().execute("INSERT INTO ticket_reviews(ticket_id,reviewer_discord_id,staff_discord_id,rating,review_text) VALUES(?,?,?,?,?)",[ticketId,i.user.id,t.claimed_by||t.closed_by||null,rating,feedback||null]);
  try{
    const ch=await client.channels.fetch(c.reviewsChannelId);
    if(ch?.isTextBased()){
      const stars="⭐".repeat(rating)+"☆".repeat(5-rating);
      const staff=t.claimed_by||t.closed_by;
      await ch.send({embeds:[new EmbedBuilder()
        .setTitle("⭐ Sterling Logistics Support Review")
        .setColor(rating>=4?0x57f287:rating===3?0xfee75c:0xed4245)
        .addFields(
          {name:"Rating",value:`${stars} (${rating}/5)`,inline:true},
          {name:"Ticket",value:ticketCode(t.id),inline:true},
          {name:"Support Staff",value:staff?`<@${staff}>`:"Sterling Logistics Team",inline:true},
          {name:"Customer",value:`<@${i.user.id}>`,inline:true},
          {name:"Review",value:feedback||"No written comment provided."}
        )
        .setTimestamp()
        .setFooter({text:"Sterling Logistics | Customer Feedback"})]});
    }
  }catch(e){console.warn(`[Reviews] Could not post review ${ticketId}: ${e.message}`);}
  await i.reply({content:`Thank you — your **${rating}/5** review has been submitted.`,flags:MessageFlags.Ephemeral});
}
