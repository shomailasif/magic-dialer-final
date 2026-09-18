import { NextResponse } from "next/server";
import { randomBytes, createHash } from "crypto";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/db";
const hash=(v:string)=>createHash("sha256").update(v).digest("hex");
export async function POST(){
 const user=await getCurrentUser(); if(!user) return NextResponse.json({error:"Unauthorized"},{status:401});
 const ticket=randomBytes(32).toString("base64url");
 await prisma.engineEnrollmentTicket.create({data:{userId:user.id,tokenHash:hash(ticket),expiresAt:new Date(Date.now()+5*60*1000)}});
 return NextResponse.json({ticket,portalUrl:new URL(process.env.PUBLIC_APP_URL||"http://localhost:3000").origin});
}