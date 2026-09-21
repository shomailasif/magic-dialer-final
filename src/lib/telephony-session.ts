import type { DialerProvider } from "@prisma/client";
import { makeSIPCall, type SIPCallConfig, type SIPCallResult } from "@/lib/sip-caller";
import type { AgentConfig } from "@/lib/sip-conversation";

export type TelephonyCapabilities={liveMedia:boolean;bargeIn:boolean;stt:boolean;tts:boolean};
export type TelephonySession={
 provider:DialerProvider;
 capabilities:TelephonyCapabilities;
 placeConversationalCall:(agent:AgentConfig)=>Promise<SIPCallResult>;
};
export function certifiedLiveProvider(provider:DialerProvider){
 return provider==="RINGCENTRAL";
}
export function createTelephonySession(provider:DialerProvider,sip:SIPCallConfig):TelephonySession{
 if(provider!=="RINGCENTRAL") throw new Error(`Provider ${provider} has no certified live-media adapter.`);
 return {
  provider,
  capabilities:{liveMedia:true,bargeIn:true,stt:true,tts:true},
  placeConversationalCall:(agent)=>makeSIPCall(sip,agent)
 };
}
