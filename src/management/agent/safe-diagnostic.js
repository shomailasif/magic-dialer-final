const crypto=require("node:crypto");
function requestId(){return crypto.randomUUID()}
function safeError(value,secrets=[]){let s=String(value&&value.message||value||"").replace(/[\r\n]+/g," ").slice(0,500);for(const secret of secrets){const x=String(secret||"");if(x.length>=4)s=s.split(x).join("[REDACTED]")}return s.replace(/Bearer\s+[A-Za-z0-9._~+\/-]+=*/gi,"Bearer [REDACTED]").replace(/\b(enc:v1:)[A-Za-z0-9._-]+/gi,"$1[REDACTED]").replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g,"[REDACTED]")}
module.exports={requestId,safeError};
