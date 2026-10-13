export type CallComplianceInput={doNotCall:boolean;phone:string|null;consentStatus?:string|null};
export type CallComplianceDecision={allowed:boolean;code:"ALLOW"|"DNC"|"NO_PHONE"|"CONSENT_DENIED"};
export function decideCallCompliance(input:CallComplianceInput):CallComplianceDecision{
 if(input.doNotCall)return {allowed:false,code:"DNC"};
 if(!String(input.phone||"").trim())return {allowed:false,code:"NO_PHONE"};
 if(String(input.consentStatus||"UNKNOWN").toUpperCase()==="DENIED")return {allowed:false,code:"CONSENT_DENIED"};
 return {allowed:true,code:"ALLOW"};
}
/* Unambiguous do-not-call. These suppress regardless of anything else in the
 * turn - if somebody says "don't call me, I'm busy right now" the "busy right
 * now" must not soften it into a callback request. */
const HARD_OPT_OUT:readonly string[]=[
 "stop calling","don't call","do not call","remove me","take me off","unsubscribe",
 "don't want you to call","do not want you to call","dont want you to call",
 "don't want to be contacted","do not want to be contacted","dont want to be contacted",
 "don't want any contact","do not want any contact",
];

/* The follow-up refusal: "I don't want you to follow-up", "no more follow up".
 * The same request as don't call me, phrased politely - and on the call of 13 Oct
 * this was the only opt-out present in the whole conversation, so nothing
 * suppressed the number and the next campaign called them again. */
const SOFT_OPT_OUT:readonly string[]=[
 "don't want you to follow","do not want you to follow","dont want you to follow",
 "don't want any follow","do not want any follow","dont want any follow",
 "don't want a follow","do not want a follow","dont want a follow",
 "no follow","no more follow","no further follow",
 "don't follow up","do not follow up","dont follow up",
 "no call back","no callbacks","no callback","don't need a call back",
 "not want you to call","not want you to contact",
];

/* A follow-up refusal can be time-boxed, and a time-boxed one is NOT an opt-out.
 * "No follow up for now" is somebody asking for space, and suppressing their
 * number forever over it would be wrong and self-defeating - they are a live lead
 * who said come back later. */
const TEMPORAL_EXEMPT:readonly RegExp[]=[
 /\bfor now\b/,/\bright now\b/,/\bfor today\b/,/\btoday\b/,/\bthis (?:week|morning|afternoon|evening)\b/,
 /\b(?:later|another time|next (?:week|month))\b/,/\bafter \d/,/\bat \d/,/\bthis afternoon\b/,/\btonight\b/,
];

/* The prospect offering to contact US is the opposite of an opt-out. "I will
 * call you if I need anything" is a live lead, and suppressing it is the single
 * most damaging mistake available in this function. */
const PROSPECT_WILL_CALL_RE=/\b(?:i|we)(?:'ll| will| will be| can) call you\b/;

function normaliseForMatching(text:string){
  return String(text||"")
   .toLowerCase()
   .replace(/['']/g,"'")
   /* hyphen, and the Unicode dashes recognisers emit for one */
   .replace(/[-\u2010-\u2015]/g," ")
   .replace(/\s+/g," ")
   .trim();
}

export function isSpokenOptOut(text:string){
 const x=normaliseForMatching(text);
 if(!x)return false;
 if(PROSPECT_WILL_CALL_RE.test(x))return false;
 if(HARD_OPT_OUT.some(p=>x.includes(p)))return true;
 if(!SOFT_OPT_OUT.some(p=>x.includes(p)))return false;
return !TEMPORAL_EXEMPT.some(re=>re.test(x));
}

export function normalizePhoneForSuppression(phone:string|null|undefined){return String(phone||"").replace(/\D/g,"");}
