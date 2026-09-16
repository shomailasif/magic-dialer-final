/*
 * Cloud call gateway - trunk layer.
 *
 * All outbound dialing happens HERE, in the cloud, over ordinary HTTPS(443).
 * Customer PCs never open SIP ports; their agent only talks to a portal over
 * 443 (heartbeat / future WSS media channel). This is what lets the product
 * work on any ISP / hotel Wi-Fi / office firewall.
 *
 * Trunk drivers are selected by the customer's voip.provider string:
 *   - "ringcentral" : RingOut (REST) from the portal over 443
 *   - "sim"         : simulated lifecycle for dry-runs + automated tests
 *   - anything else : currently routed to a stub until the cloud SIP
 *                     registration bridge lands.
 */
const crypto = require("node:crypto");
const tls = require("node:tls");
const net = require("node:net");
const { sipCallOnce, sipCallBridge } = require("./softphone");
const audio = require("./audio");
const learning = require("./learning");
const { updateCustomer } = require("./db");
const { HOSTED_VOIP_SERVERS, voipComplete } = require("../shared/protocol");

const CALL_SESSIONS = new Map();
function sessionKey(portalId, id) { return portalId + ":" + id; }
function killSessionsFor(portalId) { for (const key of Array.from(CALL_SESSIONS.keys())) if (key.startsWith(portalId + ":")) CALL_SESSIONS.delete(key); }
function getSession(portalId, id) { return CALL_SESSIONS.get(sessionKey(portalId, id)) || null; }
function getSessionsFor(portalId) { const out=[]; for (const [key,s] of CALL_SESSIONS.entries()) if(key.startsWith(portalId+":")) out.push(s); return out; }
function failSession(s,message){s.status="error";s.error=message;s.endedAt=Date.now();return s;}
const SIP_TRUNK_PROVIDERS=(provider)=>provider&&!HOSTED_VOIP_SERVERS[provider]?true:false;

async function dialViaSim(ctx,session){session.status="ringing";session.providerLabel="Simulator (dry-run)";setTimeout(()=>{if(session.status==="ringing"){session.status="in_call";session.answeredAt=Date.now();session.sim={notes:"Simulated call. The WSS media channel is the next milestone - until then this line is audio-silent."};}},400);return session;}
function encode(obj){return Object.entries(obj).map(([k,v])=>encodeURIComponent(k)+"="+encodeURIComponent(v)).join("&");}
function normalizeNumber(n){let s=String(n||"").replace(/[^+\d]/g,"");if(s&&!s.startsWith("+"))s="+"+s;return s;}
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));

async function dialViaTwilio(ctx,session,settings){
  const fet=ctx.fetch||fetch,sid=String(settings.appClientId||"").trim(),tok=String(settings.appClientSecret||"").trim(),base=String(ctx.baseUrl||("https://"+(ctx.env.PUBLIC_BASE_URL||"portal.local"))).replace(/\/+$/,"");
  if(!sid||!tok)return failSession(session,"Twilio Account SID / Auth Token missing - set them once on the customer's VOIP settings.");
  if(!settings.number)return failSession(session,"Twilio caller-id number missing - set it once on the customer's VOIP settings.");
  let resp;try{resp=await fet(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`,{method:"POST",headers:{Authorization:"Basic "+Buffer.from(sid+":"+tok).toString("base64"),"Content-Type":"application/x-www-form-urlencoded"},body:encode({To:session.destination,From:normalizeNumber(settings.number),Url:`${base}/twiml/${session.id}`,Timeout:"30",StatusCallback:`${base}/api/twilio-status`,StatusCallbackEvent:"initiated ringing answered completed"})});}catch(e){return failSession(session,"Twilio call request failed: "+e.message);}
  if(!resp.ok){let detail="";try{detail=(await resp.text()).slice(0,300);}catch{}return failSession(session,"Twilio rejected call (HTTP "+resp.status+"): "+detail);}
  const j=await resp.json();session.status="dialing";session.providerRef=String(j.sid||"");session.twilioSid=String(j.sid||"");session.providerLabel="Twilio (REST Voice)";return session;
}
function twilioWebhook(portalId,sid,status){let s=null;for(const c of CALL_SESSIONS.values())if(c.portalId===portalId&&(c.providerRef===sid||c.twilioSid===sid)){s=c;break;}if(!s)return null;const st=String(status||"").toLowerCase();if(st==="ringing"||st==="dialing"||st==="initiated")s.status="dialing";else if(st==="answered"){s.status="in_call";s.answeredAt=s.answeredAt||Date.now();}else if(st==="completed"){s.status="connected";s.endedAt=Date.now();s.error=null;s.twilioOutcome=status;}else{s.status="error";s.error="Twilio: "+(status||"ended")+(st==="no-answer"?" (no answer)":st==="busy"?" (busy)":"");s.endedAt=Date.now();s.twilioOutcome=status;}return s;}

async function rcToken(ctx,settings){
  const fet=ctx.fetch||fetch,cust=settings||{},clientId=String(cust.appClientId||ctx.env.RC_CLIENT_ID||"").trim(),clientSecret=String(cust.appClientSecret||ctx.env.RC_CLIENT_SECRET||"").trim();
  if(!clientId||!clientSecret)throw new Error("RingCentral driver needs the account's Developer-app Client ID/Secret. Enter them on the customer's VOIP settings (or set RC_CLIENT_ID / RC_CLIENT_SECRET on the portal) first.");
  const assert=String(cust.appJwt||ctx.env.RC_JWT||"").trim(),basic="Basic "+Buffer.from(clientId+":"+clientSecret).toString("base64");
  if(assert){const tok=await fet("https://platform.ringcentral.com/restapi/oauth/token",{method:"POST",headers:{Authorization:basic,"Content-Type":"application/x-www-form-urlencoded"},body:encode({grant_type:"urn:ietf:params:oauth:grant-type:jwt-bearer",assertion:assert})});if(!tok.ok)throw new Error("RingCentral JWT token rejected (HTTP "+tok.status+") - check RC_JWT / RC_CLIENT_ID / RC_CLIENT_SECRET.");return(await tok.json()).access_token;}
  const tok=await fet("https://platform.ringcentral.com/restapi/v1.0/oauth/token",{method:"POST",headers:{Authorization:basic,"Content-Type":"application/x-www-form-urlencoded"},body:encode({grant_type:"password",username:normalizeNumber(settings.number),password:settings.sipPassword,extension:settings.extension||"101"})});if(!tok.ok)throw new Error("RingCentral password token rejected (HTTP "+tok.status+") - check the customer's number/password.");return(await tok.json()).access_token;
}

async function dialViaRingCentral(ctx,session,settings){
  const user=String(settings.username||"").trim(),sipPass=String(settings.sipPassword||"").trim();
  if(user&&sipPass){
    session.status="dialing";session.providerLabel="RingCentral SIP (TLS+SRTP)";session.provider="ringcentral-sip";
    const opts={user,pass:sipPass,authId:String(settings.authId||settings.authorizationId||user).trim(),domain:String(settings.domain||"sip.ringcentral.com"),proxy:String(settings.host||settings.server||"sip40.ringcentral.com"),port:Number(settings.port||5096),number:session.destination,callerId:normalizeNumber(settings.number)||normalizeNumber(user),codec:settings.codec==="opus"?"opus":"pcmu"};
    (async()=>{
      for(let attempt=1;attempt<=6;attempt++){
        if(session.status==="error")return;
        const r=await sipCallBridge(opts);
        if(r.ok){
          session.status="connected";session.answeredAt=Date.now();session.sip={steps:r.steps,remoteIp:(r.media||{}).remoteIp,remotePort:(r.media||{}).remotePort,srtp:!!(r.media||{}).remoteKey};session._sipCallSession=r.callSession;session._sipCleanup=r.cleanup;
          const cs=r.callSession;
          cs.on("audioPacket",rtpPacket=>{try{if(session.media&&!session.media.ended)session.media.send(rtpPacket.payload,true);}catch{}session.mediaBytesIn=(session.mediaBytesIn||0)+rtpPacket.payload.length;});
          session.agentAudioHandler=(audioBuffer)=>{
            if(cs.disposed||!audioBuffer||!audioBuffer.length)return;
            try{
              // IMPORTANT: use the RingCentral SDK's own Streamer. It owns RTP
              // sequencing, timestamps, SRTP encryption and 20ms pacing. Never
              // construct/encrypt RTP packets here again; that was the silent-call bug.
              const streamer=cs.streamAudio(Buffer.from(audioBuffer));
              session._activeStreamer=streamer;
              streamer.once("finished",()=>{if(session._activeStreamer===streamer)session._activeStreamer=null;});
              session.mediaBytesOut=(session.mediaBytesOut||0)+audioBuffer.length;
            }catch(e){session.audioError=(e&&e.message)||String(e);}
          };
          cs.once("disposed",()=>{session.status="completed";session.endedAt=Date.now();});
          return;
        }
        session.sip=session.sip||{attempts:0,errors:[]};session.sip.outcome=r.last||"failed";session.sip.attempts++;(session.sip.errors||(session.sip.errors=[])).push(r.last||"unknown");if(attempt<6)await delay(3000);
      }
      failSession(session,"RingCentral SIP call failed after "+(session.sip||{}).attempts+" attempt(s)");
    })();return session;
  }
  const fet=ctx.fetch||fetch,number=normalizeNumber(settings.number),destination=session.destination;let token;try{token=await rcToken(ctx,settings);}catch(e){return failSession(session,"RingCentral token fetch failed: "+e.message);}
  try{const ringout=await fet("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({to:{phoneNumber:destination},from:{phoneNumber:number},callerId:{phoneNumber:number},playPrompt:false})});if(!ringout.ok)return failSession(session,"RingOut rejected (HTTP "+ringout.status+") - check the number or account rights.");const j=await ringout.json(),ringoutId=j.id||(j.session&&j.session.id)||"";session.status="ringing";session.providerRef=ringoutId?String(ringoutId):"";session.providerLabel="RingCentral (RingOut/443)";if(session.providerRef)pollRingOut(ctx,session,token,session.providerRef);attachMediaStream(ctx,session,token).catch(()=>{});return session;}catch(e){return failSession(session,"RingOut request failed: "+e.message);}
}

async function attachMediaStream(ctx,session,token){
  const fet=ctx.fetch||fetch,WS=require("ws"),log=msg=>console.log("[media-bridge] "+msg);log("Starting immediate media bridge attachment for destination="+session.destination);
  for(let attempt=1;attempt<=20;attempt++){await delay(2000);if(session.status==="error"||session.status==="completed")return;try{const r=await fet("https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/telephony/sessions",{headers:{Authorization:"Bearer "+token}});if(!r.ok)continue;const data=await r.json(),records=data.records||[];const active=records.find(x=>JSON.stringify(x).includes(String(session.destination).replace(/\D/g,"")));if(!active)continue;const sid=active.id||active.telephonySessionId;if(!sid)continue;const br=await fet(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/telephony/sessions/${sid}/media-bridge`,{method:"PUT",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({audio:{codec:"PCMU",sampleRate:8000,channels:1}})});if(!br.ok)continue;const bj=await br.json(),url=bj.uri||bj.url||bj.webSocketUri;if(!url)continue;const ws=new WS(url,{headers:{Authorization:"Bearer "+token}});session._mediaWs=ws;ws.on("message",d=>{const b=Buffer.isBuffer(d)?d:Buffer.from(d);try{if(session.media&&!session.media.ended)session.media.send(b,true);}catch{}session.mediaBytesIn=(session.mediaBytesIn||0)+b.length;});session.agentAudioHandler=b=>{if(ws.readyState===WS.OPEN){ws.send(b);session.mediaBytesOut=(session.mediaBytesOut||0)+b.length;}};return;}catch{}}
}

async function pollRingOut(ctx,session,token,id){const fet=ctx.fetch||fetch;for(let i=0;i<30;i++){await delay(2000);if(session.status==="error"||session.status==="completed")return;try{const r=await fet(`https://platform.ringcentral.com/restapi/v1.0/account/~/extension/~/ring-out/${id}`,{headers:{Authorization:"Bearer "+token}});if(!r.ok)continue;const j=await r.json(),st=String(j.status&&j.status.callStatus||j.status||"").toLowerCase();if(st.includes("success")||st.includes("answered")||st.includes("connected")){session.status="connected";session.answeredAt=session.answeredAt||Date.now();return;}if(st.includes("busy")||st.includes("noanswer")||st.includes("failed")){failSession(session,"RingOut: "+st);return;}}catch{}}}

async function dial(ctx,customer,destination){
  const settings=(customer.settings&&customer.settings.voip)||{},id=crypto.randomUUID(),session={id,portalId:ctx.portalId,customerToken:customer.token,destination:normalizeNumber(destination),status:"created",createdAt:Date.now(),provider:settings.provider||"",media:null,mediaBytesIn:0,mediaBytesOut:0};CALL_SESSIONS.set(sessionKey(ctx.portalId,id),session);
  if(settings.provider==="sim")return dialViaSim(ctx,session);
  if(settings.provider==="ringcentral")return dialViaRingCentral(ctx,session,settings);
  if(settings.provider==="twilio")return dialViaTwilio(ctx,session,settings);
  return failSession(session,"Unsupported VOIP provider: "+(settings.provider||"not configured"));
}
function hangup(portalId,id){const s=getSession(portalId,id);if(!s)return null;try{if(s._activeStreamer)s._activeStreamer.stop();}catch{}try{if(s._sipCleanup)s._sipCleanup();}catch{}try{if(s._mediaWs)s._mediaWs.close();}catch{}s.status="completed";s.endedAt=Date.now();return s;}
function attachMedia(portalId,id,media){const s=getSession(portalId,id);if(!s)return null;s.media=media;return s;}
function sendAgentAudio(portalId,id,b){const s=getSession(portalId,id);if(!s||typeof s.agentAudioHandler!=="function")return false;s.agentAudioHandler(Buffer.isBuffer(b)?b:Buffer.from(b));return true;}
module.exports={dial,hangup,getSession,getSessionsFor,killSessionsFor,attachMedia,sendAgentAudio,twilioWebhook,rcToken,dialViaRingCentral,dialViaTwilio,SIP_TRUNK_PROVIDERS,voipComplete};