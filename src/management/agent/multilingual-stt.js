"use strict";
const { normalizeLanguage, detectLanguageText } = require("./language");
const { requestId, safeError } = require("./safe-diagnostic");

const GROQ_TRANSCRIBE_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
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

async function transcribeAuto(audioBuffer,{hint="auto",portal="",deviceToken="",callId=""}={}) {
  if (!audioBuffer || audioBuffer.length < 100) return {text:null,language:null,error:"empty audio"};
  const base=String(portal||"").replace(/\/+$/,"");if(base&&deviceToken){const reqId=requestId(),cid=callId||requestId(),c=new AbortController(),t=setTimeout(()=>c.abort(),15000);try{const r=await fetch(base+"/api/engine/ai/stt",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+deviceToken,"x-request-id":reqId,"x-call-id":cid},body:JSON.stringify({audio:Buffer.from(audioBuffer).toString("base64"),hint}),signal:c.signal});const d=await r.json().catch(()=>({}));if(!r.ok)return{text:null,language:null,error:safeError(d.error||("STT gateway HTTP "+r.status),[deviceToken]),requestId:d.requestId||reqId,callId:d.callId||cid};return{text:d.text||null,language:d.language?normalizeLanguage(d.language,null):(d.text?detectLanguageText(d.text,hint!=="auto"?normalizeLanguage(hint,null):"en"):(hint!=="auto"?normalizeLanguage(hint,null):null)),error:null,requestId:d.requestId||reqId,callId:d.callId||cid};}catch(e){return{text:null,language:null,error:safeError(e||"STT gateway failed",[deviceToken]),requestId:reqId,callId:cid};}finally{clearTimeout(t);}}
  const key=process.env.GROQ_API_KEY||process.env.AUTODIAL_GROQ_KEY||"";
  if (!key) return {text:null,language:null,error:"Secure STT gateway unavailable"};
  const form=new FormData();
  form.append("file",new Blob([pcmuToWav(audioBuffer)],{type:"audio/wav"}),"speech.wav");
  form.append("model",MODEL);
  form.append("response_format","verbose_json");
  form.append("temperature","0");
  if (hint && hint !== "auto") form.append("language",normalizeLanguage(hint));
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),15000);
  try {
    const r=await fetch(GROQ_TRANSCRIBE_URL,{method:"POST",headers:{Authorization:`Bearer ${key}`},body:form,signal:controller.signal});
    if(!r.ok) return {text:null,language:null,error:`Groq STT HTTP ${r.status}`};
    const d=await r.json();
    const text=String(d.text||"").trim()||null;
    const language=d.language ? normalizeLanguage(d.language,null) : (text ? detectLanguageText(text, hint!=="auto"?normalizeLanguage(hint,null):"en") : (hint!=="auto"?normalizeLanguage(hint,null):null));
    return {text,language,error:null};
  } catch(e) { return {text:null,language:null,error:safeError(e||"STT request failed",[key]),requestId:requestId(),callId:callId||null}; }
  finally { clearTimeout(timer); }
}

module.exports={transcribeAuto,pcmuToWav};
