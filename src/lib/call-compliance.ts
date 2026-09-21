export type CallComplianceInput={doNotCall:boolean;phone:string|null;consentStatus?:string|null};
export type CallComplianceDecision={allowed:boolean;code:"ALLOW"|"DNC"|"NO_PHONE"|"CONSENT_DENIED"};
export function decideCallCompliance(input:CallComplianceInput):CallComplianceDecision{
 if(input.doNotCall)return {allowed:false,code:"DNC"};
 if(!String(input.phone||"").trim())return {allowed:false,code:"NO_PHONE"};
 if(String(input.consentStatus||"UNKNOWN").toUpperCase()==="DENIED")return {allowed:false,code:"CONSENT_DENIED"};
 return {allowed:true,code:"ALLOW"};
}
export function isSpokenOptOut(text:string){
 const x=String(text||"").toLowerCase().replace(/[’]/g,"'");
 return ["stop calling","don't call","do not call","remove me","take me off","unsubscribe"].some(p=>x.includes(p));
}

export function normalizePhoneForSuppression(phone:string|null|undefined){return String(phone||"").replace(/\D/g,"");}
