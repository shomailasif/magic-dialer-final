// mock-portal.cjs — deterministic local stand-in for the cloud portal so the
// deep verification can exercise the engine's real heartbeat/portal-config/
// disabled paths with zero outside network. Run:
//   node verify/mock-portal.cjs <port>
// Answers:
//   POST /api/heartbeat -> { disabled, config:{ product, lang, voiceStyle, ... } }
//   GET  /              -> "Mock portal up"
// A file next to it, "mock-disabled.flag", makes heartbeats return
// { disabled:true } so tests can prove the remote-kill path.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const port = Number(process.argv[2] || 48999);
const flag = path.join(__dirname, "mock-disabled.flag");
let hb = 0;

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/api") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "Magic Dialer mock portal", heartbeats: hb }));
    return;
  }
  if (req.url === "/api/heartbeat" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hb++;
      const disabled = fs.existsSync(flag);
      const payload = {
        disabled,
        config: disabled
          ? {}
          : {
              product: "Corporate Roll-Off Dropoff",
              companyName: "Acme Fulfilment Co",
              lang: "es",
              voiceStyle: "human",
              leadFields: ["name", "phone", "zip", "tonsPerWeek"],
              contactEmail: "sales@acme.example",
            },
      };
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
      // remember the count
      fs.writeFileSync(path.join(__dirname, "mock-heartbeat-count.txt"), String(hb));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1", () => console.log(`mock portal on 127.0.0.1:${port}`));
