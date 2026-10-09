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
 *
 * Measured against the deployed gateway on 09 Oct, two things were wrong with the
 * old numbers. The platform answers a warm request in 171ms - the half-second
 * "floor" that looked like a slow host was a client measuring itself - but a
 * database round trip inside the container costs roughly 500ms. So the budget is
 * now sized for the provider, not the database: one generation, and a retry only
 * when a full generation's worth of time is genuinely left.
 *
 * 4000ms total with a 1800ms minimum attempt means the worst case is one slow
 * generation and nothing else. Before, a 5s budget with a 900ms minimum allowed
 * three generations back to back; against a slow provider that ran 6-9s, past the
 * platform's ~5s threshold, so the client received an HTML 502 rather than a JSON
 * error. That is the "AI gateway returned non-JSON (HTTP 502)" in the audio-sim
 * runs, and it is a self-inflicted timeout, not a provider outage: the engine's
 * own retry gets a clean JSON error and can try again immediately instead of
 * waiting out an HTML error page.
 */
export const AI_GATEWAY_BUDGET_MS=4_000,AI_ATTEMPT_MAX_MS=4_000,AI_MIN_ATTEMPT_MS=1_800;
export function retryAfterMs(value:string|null,nowMs=Date.now()){if(!value)return 180;const seconds=Number(value);if(Number.isFinite(seconds)&&seconds>=0)return Math.ceil(seconds*1000);const date=Date.parse(value);return Number.isFinite(date)?Math.max(0,date-nowMs):180}
export function remainingMs(deadlineMs:number,nowMs=Date.now()){return Math.max(0,deadlineMs-nowMs)}
export function boundedAttemptMs(deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs);return left>=AI_MIN_ATTEMPT_MS?Math.min(AI_ATTEMPT_MAX_MS,left):0}
export function boundedRetryDelay(retryAfter:string|null,deadlineMs:number,nowMs=Date.now()){const left=remainingMs(deadlineMs,nowMs),delay=Math.max(0,retryAfterMs(retryAfter,nowMs));return left-delay>=AI_MIN_ATTEMPT_MS?delay:null}
