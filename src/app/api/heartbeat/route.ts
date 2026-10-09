import { NextResponse } from "next/server";
import { createHash } from "crypto";
import { prisma } from "@/lib/db";
import { decryptSecret, encryptSecret, isEncryptedSecret } from "@/lib/credential-crypto";
import { invalidateEngineDeviceAuthCache } from "@/lib/engine-device-auth";

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
/* Revoke-device and release-lease clear this. The AI gateway holds device auth
 * for three seconds so the engine stops paying a database round trip per request
 * mid-call, and it is dropped here too - otherwise a revoked device or a
 * released lease would keep reaching the AI gateway for the rest of that
 * window. */
export function invalidateConfigCache(deviceId?:string){try{invalidateEngineDeviceAuthCache(deviceId)}catch{}if(deviceId)configCache.delete(deviceId);else configCache.clear()}

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
/* Measured on the deployed gateway: an authorized heartbeat was taking
     * 1883ms, and this route makes four serialized round trips to a remote
     * Postgres on the happy path - read the device, stamp last-seen, claim the
     * lease, stamp the lease. The claim and the lease stamp are independent
     * writes to different rows and nothing between them needs the result of the
     * other, so they go as one batch instead of two round trips.
     *
     * Writing our own device row's leaseUntil when we did NOT win the claim is
     * inert: device leaseUntil is only ever read alongside the user's
     * activeEngineMachineId, and a row that failed the claim has already failed
     * that check, so it is still denied. */
    const [renewed] = await prisma.$transaction([
     prisma.user.updateMany({ where: claim, data: { activeEngineMachineId: d.machineId, engineLeaseUntil: leaseUntil } }),
     prisma.engineDevice.update({ where: { id: d.id }, data: { leaseUntil } }),
    ]);
    leaseHeld = renewed.count === 1;
   if (!leaseHeld) {
    // Read the holder fresh, and match the takeover on that exact value. The
    // first version looked up the holding *device row* and then updated on
    // `holder.machineId ?? "__none__"` - so when the account pointed at a machine
    // that had no device row (deleted PC, or a value left by an earlier account)
    // the takeover matched nothing and the account stayed locked out. Matching
    // on what is actually stored in the user row cannot miss.
    const owner = await prisma.user.findUnique({
     where: { id: d.userId },
     select: { activeEngineMachineId: true, engineLeaseUntil: true },
    });
    const holderMachineId = owner?.activeEngineMachineId ?? null;
    const holderDevice = holderMachineId
     ? await prisma.engineDevice.findFirst({
       where: { userId: d.userId, machineId: holderMachineId },
       select: { lastSeenAt: true, revokedAt: true },
      })
     : null;
    const lastSeen = holderDevice?.lastSeenAt ? new Date(holderDevice.lastSeenAt).getTime() : 0;
    const revoked = Boolean(holderDevice?.revokedAt);
    const stale = revoked || !holderMachineId || !lastSeen || Date.now() - lastSeen > STALE_HOLDER_MS;
    console.error(`heartbeat lease held by machine=${holderMachineId || "none"} holderDevice=${holderDevice ? "present" : "MISSING"} lastSeen=${holderDevice?.lastSeenAt || "never"} stale=${stale}`);
    if (stale) {
     const takeover = await prisma.user.updateMany({
      where: { id: d.userId, activeEngineMachineId: holderMachineId },
      data: { activeEngineMachineId: d.machineId, engineLeaseUntil: leaseUntil },
     });
     leaseHeld = takeover.count === 1;
     console.error(`heartbeat lease takeover: ${leaseHeld ? "granted" : "refused"}`);
    }
   }
   /* The lease stamp already went out with the claim above, in one batch. */
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
    /* Queue commands, so the website can run the customer's dialer.
     *
     * The campaign button on the website cannot place a sales call itself: the AI
     * agent, the customer's own VOIP line and the live media all live on their PC.
     * What the website can do is tell that PC what to do, and the PC already
     * phones home every few seconds. So the button sets a command here, this
     * heartbeat carries it down, and the PC starts or stops its own queue.
     * That is what makes it one click for the customer instead of a support
     * ticket, and it is the only path that reaches the leads at all. */
    const q = full.user.agentConfig as any;
    const command = q?.queueCommand || null;
    const queueState = q?.queueState || null;
    /* A command is handed over exactly once. Repeating it every three seconds
     * would restart the queue over and over, so it is cleared as it is sent. */
    if (q && command) {
      await prisma.aIAgentConfig.update({ where: { id: q.id }, data: { queueCommand: null } as any }).catch(() => undefined);    }
    return NextResponse.json({ok:true,disabled,config,queue:{command,state:queueState}});
 }catch(e){
  // Never an unhandled 500: this route is load-bearing for a live call. A clean
  // 503 with a diagnostic the agent can log beats an HTML error page that reads
  // as "the portal is gone".
  console.error("heartbeat failed",e);
  return NextResponse.json({error:"Heartbeat temporarily unavailable",stage:"heartbeat",code:"DB_UNAVAILABLE",status:503},{status:503});
 }
}
