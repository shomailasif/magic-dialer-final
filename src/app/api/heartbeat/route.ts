import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
export async function POST(req:Request){
 let b:any; try{b=await req.json()}catch{return NextResponse.json({error:"Invalid body"},{status:400})}
 const token=String(b.deviceToken||b.token||""); if(!token) return NextResponse.json({error:"Unauthorized"},{status:401});
 const d=await prisma.engineDevice.findUnique({where:{tokenHash:hash(token)},include:{user:{include:{subscription:true,agentConfig:true,dialerConfig:true}}}});
 if(!d||d.revokedAt) return NextResponse.json({error:"Unauthorized"},{status:401});
 const now=new Date(), leaseUntil=new Date(Date.now()+2*60*1000);
 const renewed=await prisma.user.updateMany({
  where:{id:d.userId,OR:[{activeEngineMachineId:d.machineId},{activeEngineMachineId:null},{engineLeaseUntil:null},{engineLeaseUntil:{lte:now}}]},
  data:{activeEngineMachineId:d.machineId,engineLeaseUntil:leaseUntil}
 });
 if(renewed.count!==1) return NextResponse.json({error:"Account active on another PC"},{status:409});
 await prisma.engineDevice.update({where:{id:d.id},data:{lastSeenAt:now,leaseUntil}});
 const disabled=d.user.subscription?.status==="SUSPENDED"||d.user.subscription?.status==="DEACTIVATED";
 return NextResponse.json({ok:true,disabled,config:{companyName:d.user.companyName||"",product:d.user.agentConfig?.productName||"",persona:"Atlas",lang:d.user.agentConfig?.defaultLanguage||"en"}});
}
