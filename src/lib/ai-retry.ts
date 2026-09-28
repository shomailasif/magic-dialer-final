/* This budget must stay UNDER the agent's live-turn patience (7s), not above it.
 *
 * It was 12s while the engine gave up at 7s, so the engine always abandoned the
 * request first: the portal kept burning Groq calls whose answer nobody would
 * read, and when the platform gave up before the route did, the client received
 * an HTML 502 instead of a JSON error. That is where the "AI gateway returned
 * non-JSON (HTTP 502)" and "timed out after 7000ms" in the 20:40Z log came from.
 *
 * The engine's own 7s is deliberate and must not be raised: 12s there produced
 * 21s and 22s of dead air on the 16:09Z call, and 4.5s cost a real call on a tail
 * spike. So the route is brought down to the caller instead. Measured warm p100 is
 * 2174ms, so 4s per attempt is ample.
 */
export const AI_GATEWAY_BUDGET_MS=5_000,AI_ATTEMPT_MAX_MS=4_000,AI_MIN_ATTEMPT_MS=900;
export function retryAfterMs(value:string|null,nowMs=Date.now()){if(!value)return 180;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-nowMs):180}
export function remainingMs(deadlineMs:number,nowMs=Date.now()){return Math.max(0,deadlineMs-nowMs)}
export function boundedAttemptMs(deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs);return left>=AI_MIN_ATTEMPT_MS?Math.min(AI_ATTEMPT_MAX_MS,left):0}
export function boundedRetryDelay(retryAfter:string|null,deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs),delay=Math.max(0,retryAfterMs(retryAfter,nowMs));return left-delay>=AI_MIN_ATTEMPT_MS?delay:null}
