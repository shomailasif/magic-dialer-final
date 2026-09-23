import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
export async function POST(req:Request){
 let b:any; try{b=await req.json()}catch{return NextResponse.json({error:"Invalid body"},{status:400})}
 const ticket=String(b.ticket||""), machineId=String(b.machineId||"");
 if(!ticket||!machineId) return NextResponse.json({error:"ticket and machineId required"},{status:400});
 const now=new Date(), ticketHash=hash(ticket), leaseUntil=new Date(now.getTime()+2*60*1000);
 try {
  const deviceToken=await prisma.$transaction(async(tx)=>{
   const row=await tx.engineEnrollmentTicket.findUnique({where:{tokenHash:ticketHash}});
   if(!row||row.consumedAt||row.expiresAt<=now) throw new Error("TICKET");
   const consumed=await tx.engineEnrollmentTicket.updateMany({where:{id:row.id,consumedAt:null,expiresAt:{gt:now}},data:{consumedAt:now}});
   if(consumed.count!==1) throw new Error("TICKET");
    // The ticket was minted from this customer's authenticated dashboard click,
    // so this PC always wins — customers may switch machines at any time.
    const claimed=await tx.user.updateMany({
     where:{id:row.userId},
     data:{activeEngineMachineId:machineId,engineLeaseUntil:leaseUntil}
    });
    if(claimed.count!==1) throw new Error("ENROLL");
   const token=randomBytes(32).toString("base64url");
   await tx.engineDevice.updateMany({where:{userId:row.userId,machineId:{not:machineId}},data:{revokedAt:now,leaseUntil:null}});
   await tx.engineDevice.upsert({where:{userId_machineId:{userId:row.userId,machineId}},create:{userId:row.userId,machineId,tokenHash:hash(token),leaseUntil},update:{tokenHash:hash(token),revokedAt:null,leaseUntil}});
   return token;
  });
  return NextResponse.json({ok:true,deviceToken});
 } catch(e){
  const m=e instanceof Error?e.message:"";
   if(m==="ENROLL") return NextResponse.json({error:"Customer account unavailable"},{status:409});
  if(m==="TICKET") return NextResponse.json({error:"Invalid or expired enrollment ticket"},{status:401});
  throw e;
 }
}
