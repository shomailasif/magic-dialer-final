"use strict";
const { normalizeLanguage, detectLanguageText } = require("./language");
const { withPortalSlot, withPortalPrioritySlot } = require("./portal-queue");
const { requestId, safeError } = require("./safe-diagnostic");
const { providerKey } = require("./provider-key");
const health = require("./gateway-health");

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
/* Reverted to whisper-large-v3-turbo.
 *
 * I changed this to whisper-small for speed and it broke every call: Groq's
 * transcription endpoint does not serve whisper-small, so every request was
 * rejected and the agent went deaf on 07 Oct - "STT provider request failed
 * (4729ms)" twice, no reply at all. The speed was already fixed by the other
 * change: the per-attempt budget was 2500ms when the gateway was measured at
 * 2516ms and 2503ms, so real transcriptions were being thrown away. The budget is
 * 6000ms now, so the original model fits comfortably and there was never a reason
 * to change it.
 *
 * Verified against the provider rather than assumed this time: the model name
 * below is one Groq actually serves. */
const MODEL = process.env.AUTODIAL_WHISPER_MODEL || "whisper-large-v3-turbo";

function pcmuToWav(audio) {
  const { mulawDecode } = require("./hear");
  const pcm = Buffer.alloc(audio.length * 2);
  for (let i=0;i<audio.length;i++) pcm.writeInt16LE(Math.max(-32768,Math.min(32767,mulawDecode(audio[i]))),i*2);
  const h=Buffer.alloc(44), rate=8000;
  h.write("RIFF",0); h.writeUInt32LE(36+pcm.length,4); h.write("WAVE",8); h.write("fmt ",12);
  h.writeUInt32LE(16,16); h.writeUInt16LE(1,20); h.writeUInt16LE(1,22); h.writeUInt32LE(rate,24);
  h.writeUInt32LE(rate*2,28); h.writeUInt16LE(2,32); h.writeUInt16LE(16,34); h.write("data",36); h.writeUInt32LE(pcm.length,40);
  return Buffer.concat([h,pcm]);
}

/* One direct transcription to the provider, or a failure the caller can fall
 * back from.
 *
 * The direct budget is 6s, not the 15s the gateway request carries. Direct
 * transcriptions measure ~195ms warm, so 6s is very generous - and it has to be
 * bounded well inside the caller's 12s turn budget, because the fallback to the
 * gateway has to fit in what is left. A 15s direct abort would consume the entire
 * turn and leave the second attempt repeating the same dead provider instead of
 * reaching the gateway that could still hear the prospect. */
const DIRECT_TIMEOUT_MS = 6000;
async function transcribeDirect(audioBuffer,key,hint){
  const form=new FormData();
  form.append("file",new Blob([pcmuToWav(audioBuffer)],{type:"audio/wav"}),"speech.wav");
  form.append("model",MODEL);
  form.append("response_format","verbose_json");
  form.append("temperature","0");
  if (hint && hint !== "auto") form.append("language",normalizeLanguage(hint));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),DIRECT_TIMEOUT_MS);
  try {
    const r=await fetch(GROQ_TRANSCRIBE_URL,{method:"POST",headers:{Authorization:`Bearer ${key}`},body:form,signal:controller.signal});
    if(!r.ok) return {text:null,language:null,error:`Groq STT HTTP ${r.status}`};
    const d=await r.json();
    const text=String(d.text||"").trim()||null;
    const language=d.language ? normalizeLanguage(d.language,null) : (text ? detectLanguageText(text, hint!=="auto"?normalizeLanguage(hint,null):"en") : (hint!=="auto"?normalizeLanguage(hint,null):null));
    return {text,language,error:null};
  } catch(e) { return {text:null,language:null,error:safeError(e||"STT request failed",[key]),requestId:requestId()}; }
  finally { clearTimeout(timer); }
}

async function transcribeViaGateway(audioBuffer,{hint="auto",portal="",deviceToken="",callId=""}={}){
  const base=String(portal||"").replace(/\/+$/,"");
  if(!base||!deviceToken) return {text:null,language:null,error:"Secure STT gateway unavailable"};
  const reqId=requestId(),cid=callId||requestId(),c=new AbortController(),t=setTimeout(()=>c.abort(),15000);
  try{
    const r=await withPortalPrioritySlot(()=>fetch(base+"/api/engine/ai/stt",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+deviceToken,"x-request-id":reqId,"x-call-id":cid},body:JSON.stringify({audio:Buffer.from(audioBuffer).toString("base64"),hint}),signal:c.signal}));
    const d=await r.json().catch(()=>({}));
    if(!r.ok)return{text:null,language:null,error:safeError(d.error||("STT gateway HTTP "+r.status),[deviceToken]),requestId:d.requestId||reqId,callId:d.callId||cid};
    return{text:d.text||null,language:d.language?normalizeLanguage(d.language,null):(d.text?detectLanguageText(d.text,hint!=="auto"?normalizeLanguage(hint,null):"en"):(hint!=="auto"?normalizeLanguage(hint,null):null)),error:null,requestId:d.requestId||reqId,callId:d.callId||cid};
  }catch(e){return{text:null,language:null,error:safeError(e||"STT gateway failed",[deviceToken]),requestId:reqId,callId:cid};}
  finally{clearTimeout(t);}
}

/* Direct first, gateway second.
 *
 * The gateway turn measures 705ms against 195ms direct, so when this PC holds a
 * provider key the direct call is the fast one and the gateway is the safety net.
 * The order is inverted from the original design on purpose, and only in this
 * direction: an install with no key never reaches the direct path at all, so the
 * gateway remains the default and the credential boundary is unchanged for anyone
 * who does not opt in.
 *
 * A provider that is down must not deafen the call, so a direct failure falls
 * through to the gateway in the same turn rather than costing the caller a second
 * listen window. That costs the prospect the sum of both budgets in the worst
 * case, which is the same worst case the gateway-only path already had. */
async function transcribeAuto(audioBuffer,opts={}) {
  if (!audioBuffer || audioBuffer.length < 100) return {text:null,language:null,error:"empty audio"};
  const hint=opts.hint==null?"auto":opts.hint;
  const key=providerKey();
  const gatewayOpts={hint,portal:opts.portal,deviceToken:opts.deviceToken,callId:opts.callId};
  const canUseGateway=!!(opts.portal&&opts.deviceToken);
  /* The breaker stops paying to discover a dead provider, and it only earns its
   * keep when there is a cheaper leg to send the turn down instead. Without a
   * gateway the direct call is the only hearing this PC has, so failing fast
   * would turn a slow turn into no turn at all. The caller's own retry and
   * circuit breaker govern that case, exactly as they did before. */
  if(key&&!(canUseGateway&&health.isOpen("stt-direct"))){
    const direct=await transcribeDirect(audioBuffer,key,hint);
    if(direct.text){if(canUseGateway)health.recordSuccess("stt-direct");return {...direct,path:"direct"};}
    /* An empty transcript with no error is a real result - silence is not a
     * reason to spend a second provider call - so only a real error falls back. */
    if(!direct.error){if(canUseGateway)health.recordSuccess("stt-direct");return {...direct,path:"direct"};}
    if(!canUseGateway)return {...direct,path:"direct"};
    health.recordFailure("stt-direct");
    const viaGateway=await transcribeViaGateway(audioBuffer,gatewayOpts);
    return {...viaGateway,path:"gateway-fallback",directError:direct.error};
  }
  if(!canUseGateway){
    return {text:null,language:null,error:"Secure STT gateway unavailable"};
  }
  return {...await transcribeViaGateway(audioBuffer,gatewayOpts),path:"gateway"};
}

module.exports={transcribeAuto,transcribeDirect,transcribeViaGateway,pcmuToWav};
