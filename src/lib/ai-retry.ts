export const AI_GATEWAY_BUDGET_MS=12_000,AI_ATTEMPT_MAX_MS=5_000,AI_MIN_ATTEMPT_MS=900;
export function retryAfterMs(value:string|null,nowMs=Date.now()){if(!value)return 180;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-nowMs):180}
export function remainingMs(deadlineMs:number,nowMs=Date.now()){return Math.max(0,deadlineMs-nowMs)}
export function boundedAttemptMs(deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs);return left>=AI_MIN_ATTEMPT_MS?Math.min(AI_ATTEMPT_MAX_MS,left):0}
export function boundedRetryDelay(retryAfter:string|null,deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs),delay=Math.max(0,retryAfterMs(retryAfter,nowMs));return left-delay>=AI_MIN_ATTEMPT_MS?delay:null}
