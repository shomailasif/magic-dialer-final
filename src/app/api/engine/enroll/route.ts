import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
export async function POST(req:Request){
 let b:any; try{b=await req.json()}catch{return NextResponse.json({error:"Invalid body"},{status:400})}
 const ticket=String(b.ticket||""), machineId=String(b.machineId||"");
 if(!ticket||!machineId) return NextResponse.json({error:"ticket and machineId required"},{status:400});
 const row=await prisma.engineEnrollmentTicket.findUnique({where:{tokenHash:hash(ticket)}});
 if(!row||row.consumedAt||row.expiresAt<=new Date()) return NextResponse.json({error:"Invalid or expired enrollment ticket"},{status:401});
 const now=new Date();
 const activeOther=await prisma.engineDevice.findFirst({where:{userId:row.userId,machineId:{not:machineId},revokedAt:null,leaseUntil:{gt:now}}});
 if(activeOther) return NextResponse.json({error:"This account is already active on another PC."},{status:409});
 const deviceToken=randomBytes(32).toString("base64url");
 const leaseUntil=new Date(Date.now()+2*60*1000);
 await prisma.$transaction([
  prisma.engineDevice.updateMany({where:{userId:row.userId,machineId:{not:machineId}},data:{revokedAt:now,leaseUntil:null}}),
  prisma.engineEnrollmentTicket.update({where:{id:row.id},data:{consumedAt:new Date()}}),
  prisma.engineDevice.upsert({where:{userId_machineId:{userId:row.userId,machineId}},create:{userId:row.userId,machineId,tokenHash:hash(deviceToken),leaseUntil},update:{tokenHash:hash(deviceToken),revokedAt:null,leaseUntil}})
 ]);
 return NextResponse.json({ok:true,deviceToken});
}