/* Is the ~500ms floor the server, or my own test harness?
 *
 * Every latency number so far came from a client opening a fresh TCP and TLS
 * connection per request. To a host in another continent the handshake alone is
 * several hundred milliseconds, so "the floor is half a second" may have been
 * measuring the client, not Suga.
 *
 *   handshake - DNS + TCP + TLS only, no HTTP request
 *   fresh     - new connection for every request
 *   reuse     - one connection kept alive, which is what a live agent does
 */
const https = require("node:https");
const tls = require("node:tls");

const HOST = "0nrl0r6g7wyn-production-4w2zqfnq.europe-west1.suga.run";

function get(agent, headers) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const req = https.request({ host: HOST, path: "/", method: "GET", agent, headers: headers || {} }, (res) => {
      let n = 0;
      res.on("data", (c) => { n += c.length; });
      res.on("end", () => resolve({ ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.statusCode }));
    });
    req.on("error", reject);
    req.end();
  });
}

const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
const now = () => Number(process.hrtime.bigint());

(async () => {
  console.log(`host: ${HOST}\n`);

  const hs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = now();
    await new Promise((resolve, reject) => {
      const s = tls.connect({ host: HOST, port: 443, servername: HOST }, () => {
        hs.push(now() - t0);
        s.destroy();
        resolve();
      });
      s.on("error", reject);
    });
  }
  console.log(`DNS+TCP+TLS handshake alone : ${hs.map((x) => x.toFixed(0) + "ms").join(", ")}  median ${med(hs).toFixed(0)}ms`);

  const fresh = [];
  for (let i = 0; i < 4; i++) {
    fresh.push((await get(new https.Agent({ keepAlive: false }), { Connection: "close" })).ms);
  }
  console.log(`new connection each time   : ${fresh.map((x) => x.toFixed(0) + "ms").join(", ")}  median ${med(fresh).toFixed(0)}ms`);

  const ka = new https.Agent({ keepAlive: true, maxSockets: 1 });
  await get(ka);
  const reused = [];
  for (let i = 0; i < 6; i++) reused.push((await get(ka)).ms);
  console.log(`kept-alive connection      : ${reused.map((x) => x.toFixed(0) + "ms").join(", ")}  median ${med(reused).toFixed(0)}ms`);

  const f = med(fresh), r = med(reused);
  console.log(`\nper-request handshake cost : ${(f - r).toFixed(0)}ms`);
  console.log(r < 250
    ? `=> The floor was my harness. The server answers in ${r.toFixed(0)}ms on a warm connection.`
    : `=> The server is genuinely slow: ${r.toFixed(0)}ms on a reused connection, no handshake in that.`);
})().catch((e) => { console.error("FATAL", e.message); process.exit(1); });