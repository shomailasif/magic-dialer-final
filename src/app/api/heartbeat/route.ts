import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/credential-crypto";

const hash=(v:string)=>createHash("sha256").update(v).digest("hex");

/* The engine heartbeats every few seconds, for the whole length of a live call.
 *
 * This route used to have no error handling at all around its database work, so a
 * transient database blip produced an unhandled 500 - an HTML error page from
 * the platform - and the engine logged "heartbeat rejected (status 500)" in the
 * middle of a call it was actively making. Worse, the lease had already been
 * renewed by the time the failure happened, so the device and the server
 * disagreed about whether the call was allowed to continue.
 *
 * It also joined user -> subscription -> agentConfig -> dialerConfig on every
 * single heartbeat, which is a four-table read every three seconds for data
 * that cannot change while a call is running. That is the pressure that makes
 * the connection pool the first thing to fail. The config is now cached briefly
 * and the keepalive path only touches two narrow columns.
 */
const CONFIG_CACHE_MS=30_000;
const configCache=new Map<string,{at:number;config:any}>();

function cachedConfig(deviceId:string){const c=configCache.get(deviceId);if(c&&Date.now()-c.at<CONFIG_CACHE_MS)return c.config;return null}
function cacheConfig(deviceId:string,config:any){configCache.set(deviceId,{at:Date.now(),config});if(configCache.size>64){const oldest=[...configCache.entries()].sort((a,b)=>a[1].at-b[1].at)[0];if(oldest)configCache.delete(oldest[0])}}
export function invalidateConfigCache(deviceId?:string){if(deviceId)configCache.delete(deviceId);else configCache.clear()}

export async function POST(req:Request){
 let b:any; try{b=await req.json()}catch{return NextResponse.json({error:"Invalid body"},{status:400})}
 const token=String(b.deviceToken||b.token||""); if(!token) return NextResponse.json({error:"Unauthorized"},{status:401});
 const now=new Date();
 try{
  // 1. Liveness and last-seen only. Two columns, no joins. If this is slow or
  //    fails, the call keeps running: the engine is explicitly told to continue.
  const d=await prisma.engineDevice.findUnique({where:{tokenHash:hash(token)},select:{id:true,userId:true,machineId:true,revokedAt:true}});
  if(!d||d.revokedAt) return NextResponse.json({error:"Unauthorized"},{status:401});
  await prisma.engineDevice.update({where:{id:d.id},data:{lastSeenAt:now}});

  // 2. Lease claim, best effort. A rejected lease is a real answer (409) and is
  //    reported as such - unless the machine holding it is gone.
  //
  //    A lease that cannot be taken over locks the account out forever. The
  //    lease lasts two minutes, so a PC that has stopped should release it
  //    automatically - but only if nothing renews it. This account was refused
  //    with 409 continuously, with no agent running anywhere on this machine and
  //    the two-minute window elapsed many times over, so a device row exists
  //    whose lease is being kept alive by something that is not a live call.
  //
  //    So: if the holder is a registered device that has not been seen for
  //    STALE_HOLDER_MS, it is dead and this PC takes over. A genuinely live
  //    second PC is seen every few seconds, so this can never steal from one.
  const STALE_HOLDER_MS = 5 * 60 * 1000;
  let leaseHeld = true;
  try {
   const leaseUntil = new Date(Date.now() + 2 * 60 * 1000);
   const claim = { id: d.userId, OR: [{ activeEngineMachineId: d.machineId }, { activeEngineMachineId: null }, { engineLeaseUntil: null }, { engineLeaseUntil: { lte: now } }] };
   const renewed = await prisma.user.updateMany({ where: claim, data: { activeEngineMachineId: d.machineId, engineLeaseUntil: leaseUntil } });
   leaseHeld = renewed.count === 1;
   if (!leaseHeld) {
    const holder = await prisma.engineDevice.findFirst({
     where: { userId: d.userId, machineId: { not: d.machineId } },
     orderBy: { lastSeenAt: "desc" },
     select: { machineId: true, lastSeenAt: true, leaseUntil: true },
    });
    const lastSeen = holder?.lastSeenAt ? new Date(holder.lastSeenAt).getTime() : 0;
    const stale = !holder || !lastSeen || Date.now() - lastSeen > STALE_HOLDER_MS;
    console.error(`heartbeat lease held by machine=${holder?.machineId || "unknown"} lastSeen=${holder?.lastSeenAt || "never"} stale=${stale}`);
    if (stale) {
     const takeover = await prisma.user.updateMany({
      where: { id: d.userId, activeEngineMachineId: holder?.machineId ?? "__none__" },
      data: { activeEngineMachineId: d.machineId, engineLeaseUntil: leaseUntil },
     });
     leaseHeld = takeover.count === 1;
     console.error(`heartbeat lease takeover by stale holder: ${leaseHeld ? "granted" : "refused"}`);
    }
   }
   if (leaseHeld) await prisma.engineDevice.update({ where: { id: d.id }, data: { leaseUntil } });
  } catch (e) {
   // The lease table is unavailable. Last-seen was already recorded, so the
   // device is still known-good; do not tear down a live call over a lease
   // bookkeeping write. Report it, do not fail the heartbeat.
   console.error("heartbeat lease renewal failed", e);
  }
  if(!leaseHeld) return NextResponse.json({error:"Account active on another PC"},{status:409});

  // 3. Configuration, cached briefly. A SIP password is decrypted once per
  //    window rather than on every three-second beat.
  const hit=cachedConfig(d.id);
  if(hit) return NextResponse.json({ok:true,disabled:hit.disabled,config:hit.config});

  const full=await prisma.engineDevice.findUnique({where:{tokenHash:hash(token)},include:{user:{include:{subscription:true,agentConfig:true,dialerConfig:true}}}});
  if(!full) return NextResponse.json({error:"Unauthorized"},{status:401});
  const disabled=full.user.subscription?.status==="SUSPENDED"||full.user.subscription?.status==="DEACTIVATED";
  const dc=full.user.dialerConfig;
  let sipPassword="";
  if(dc?.sipPassword){ try{sipPassword=decryptSecret(dc.sipPassword)}catch{return NextResponse.json({error:"Dialer credential unavailable"},{status:503})} }
  if(dc?.sipPassword && !isEncryptedSecret(dc.sipPassword)){
   await prisma.dialerConfig.update({where:{id:dc.id},data:{sipPassword:encryptSecret(sipPassword)}}).catch(()=>{});
  }
  const voip=dc?.validated&&dc.sipUsername&&sipPassword&&dc.outboundNumber?{
   provider:String(dc.provider||"").toLowerCase(),
   number:dc.outboundNumber,
   username:dc.sipUsername,
   sipPassword,
   authId:dc.sipAuthId||dc.sipUsername,
   domain:dc.sipDomain||"sip.ringcentral.com",
   server:dc.sipProxy||"sip40.ringcentral.com",
   port:dc.sipPort||"5096",
   ready:true
  }:undefined;
  const config={companyName:full.user.companyName||"",product:full.user.agentConfig?.productName||"",persona:"Atlas",lang:full.user.agentConfig?.defaultLanguage||"en",...(voip?{voip}:{})};
  cacheConfig(d.id,{disabled,config});
  return NextResponse.json({ok:true,disabled,config});
 }catch(e){
  // Never an unhandled 500: this route is load-bearing for a live call. A clean
  // 503 with a diagnostic the agent can log beats an HTML error page that reads
  // as "the portal is gone".
  console.error("heartbeat failed",e);
  return NextResponse.json({error:"Heartbeat temporarily unavailable",stage:"heartbeat",code:"DB_UNAVAILABLE",status:503},{status:503});
 }
}
