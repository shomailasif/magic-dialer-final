import crypto from "node:crypto";

export function diagnosticId(value?:string|null){
 const v=String(value||"").trim();
 return /^[A-Za-z0-9._:-]{8,96}$/.test(v)?v:crypto.randomUUID();
}
export function safeDiagnostic(stage:string,code:string,status:number,requestId:string){
 return {requestId,stage:String(stage||"unknown").slice(0,64),code:String(code||"INTERNAL_ERROR").slice(0,64),status};
}
export function redactDiagnostic(value:unknown,secrets:unknown[]=[]){
 let s=String(value instanceof Error?value.message:value??"").replace(/[\r\n]+/g," ").slice(0,500);
 for(const secret of secrets){const x=String(secret||"");if(x.length>=4)s=s.split(x).join("[REDACTED]")}
 s=s.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [REDACTED]")
   .replace(/\b(enc:v1:)[A-Za-z0-9._-]+/gi,"$1[REDACTED]")
   .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g,"[REDACTED]");
 return s;
}
