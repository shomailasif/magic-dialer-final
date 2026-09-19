const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

/**
 * Magic Dialer local dashboard/set-up server (zero dependencies).
 *
 * Runs inside the agent's own bundled Node and serves a single-page,
 * brand-consistent web app on 127.0.0.1:<random port>:
 *
 *   GET  /            -> the dashboard/setup page (one shell, JS decides)
 *   GET  /api/state   -> { configured, ... } so the page picks setup vs dashboard
 *   GET  /api/status  -> live status.json feed (status, stats, activity)
 *   POST /api/setup   -> validate + persist the one-time onboarding form
 *   POST /api/resume  -> flip dashboard mode to "on"
 *   POST /api/pause   -> flip dashboard mode to "off"
 *   GET  /api/health  -> liveness probe
 *
 * This replaces the old PowerShell setup form (setup.ps1) and the console
 * ASCII banner as the customer-facing face of the product.
 */

/** Fixed loopback port used by the cloud portal for secure PC enrollment. */
const PREFERRED_PORT = 48771;

function localDataDir() {
  if (process.env.AUTODIAL_HOME) return process.env.AUTODIAL_HOME;
  return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "Magic Dialer");
}

function dashboardUrlPath() {
  return path.join(localDataDir(), "dashboard.url");
}

function writeDashboardUrl(url) {
  try {
    fs.mkdirSync(localDataDir(), { recursive: true });
    const ini = [
      "[InternetShortcut]",
      "URL=" + url,
      "IconFile=" + process.execPath.replace(/\\/g, "\\\\"),
      "IconIndex=0",
      "",
    ].join("\r\n");
    fs.writeFileSync(dashboardUrlPath(), ini, "utf8");
  } catch {}
}

const FAVICON = "data:image/svg+xml," + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1d4ed8"/><path d="M46 40.5v5a3 3 0 0 1-3.3 3 30.6 30.6 0 0 1-13.4-4.8 30.2 30.2 0 0 1-9.3-9.3A30.6 30.6 0 0 1 15.2 21a3 3 0 0 1 3-3.3h5a3 3 0 0 1 3 2.6c.2 1.4.5 2.8.9 4.1a3 3 0 0 1-.7 3.2l-2.2 2.2a24 24 0 0 0 9.3 9.3l2.2-2.2a3 3 0 0 1 3.2-.7c1.3.4 2.7.7 4.1.9a3 3 0 0 1 2.6 3z" fill="#fff"/></svg>`
);

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Magic Dialer</title>
<link rel="icon" href="${FAVICON}">
<style>
  :root{
    --navy:#0b1220; --navy2:#111a2e; --ink:#0f172a; --mut:#5b6b85;
    --line:#e6eaf1; --bg:#f5f7fb; --card:#ffffff; --blue:#1d4ed8; --blue2:#2563eb;
    --teal:#0d9488; --green:#16a34a; --amber:#d97706; --red:#dc2626;
    --shadow:0 1px 2px rgba(15,23,42,.06),0 8px 24px rgba(15,23,42,.06);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:"Segoe UI",-apple-system,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--ink)}
  a{color:var(--blue2);text-decoration:none}
  .top{background:linear-gradient(135deg,var(--navy) 0%,var(--navy2) 60%,#16233f 100%);padding:0 28px;display:flex;align-items:center;gap:14px;height:64px;box-shadow:0 1px 0 rgba(255,255,255,.04) inset}
  .logo{width:36px;height:36px;border-radius:9px;background:linear-gradient(135deg,#2563eb,#1d4ed8);display:flex;align-items:center;justify-content:center;flex:none}
  .logo svg{width:22px;height:22px}
  .word{color:#fff;font-size:17px;font-weight:600;letter-spacing:.2px}
  .tag{color:#8ea3c2;font-size:12px;margin-top:1px}
  .top .grow{flex:1}
  .pill{font-size:12px;font-weight:600;padding:5px 12px;border-radius:999px;display:inline-flex;align-items:center;gap:6px;letter-spacing:.3px}
  .pill .dot{width:7px;height:7px;border-radius:50%;background:currentColor}
  .pill.on{background:rgba(22,163,74,.15);color:#15803d}
  .pill.off{background:rgba(100,116,139,.15);color:#475569}
  .pill.warn{background:rgba(217,119,6,.15);color:#b45309}
  .pill.err{background:rgba(220,38,38,.15);color:#b91c1c}
  .wrap{max-width:940px;margin:0 auto;padding:28px 20px 60px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;box-shadow:var(--shadow)}
  .head{display:flex;align-items:center;justify-content:space-between;margin-bottom:18px}
  .head h1{font-size:20px;font-weight:600}
  .head p{color:var(--mut);font-size:13px;margin-top:3px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:20px}
  .stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
  .stat .lab{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--mut);font-weight:600}
  .stat .val{font-size:24px;font-weight:700;margin-top:6px;font-variant-numeric:tabular-nums}
  .stat .sub{font-size:11px;color:var(--mut);margin-top:2px}
  .sec{padding:0 0 14px;border-bottom:1px solid var(--line);margin-bottom:14px}
  .sec:last-child{border-bottom:0;margin-bottom:0;padding-bottom:0}
  .sec h2{font-size:14px;font-weight:600;margin-bottom:3px}
  .sec .desc{font-size:12px;color:var(--mut);margin-bottom:12px}
  label{display:block;font-size:12px;font-weight:600;color:#334155;margin:12px 0 5px}
  input{width:100%;padding:10px 12px;border:1px solid #d6dde8;border-radius:8px;font-size:14px;font-family:inherit;background:#fff;color:var(--ink);outline:none;transition:border-color .15s,box-shadow .15s}
  input:focus{border-color:var(--blue2);box-shadow:0 0 0 3px rgba(37,99,235,.12)}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:0 16px}
  @media(max-width:640px){.row{grid-template-columns:1fr}}
  .btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;border:none;border-radius:9px;padding:12px 22px;font-size:14px;font-weight:600;font-family:inherit;cursor:pointer;transition:filter .15s,transform .05s}
  .btn:active{transform:translateY(1px)}
  .btn.primary{background:var(--blue2);color:#fff;box-shadow:0 1px 2px rgba(29,78,216,.4)}
  .btn.primary:hover{filter:brightness(1.08)}
  .btn.ghost{background:#fff;color:#334155;border:1px solid #d6dde8}
  .btn.ghost:hover{background:#f8fafc}
  .btn.teal{background:var(--teal);color:#fff}
  .hint{font-size:12px;color:var(--mut);margin-top:8px;line-height:1.5}
  .err{color:var(--red);font-size:13px;margin-top:10px;min-height:18px}
  .ok{color:var(--green);font-size:13px;margin-top:10px;min-height:18px;font-weight:600}
  ul.feed{list-style:none}
  ul.feed li{display:flex;gap:10px;padding:9px 0;border-bottom:1px solid var(--line);font-size:13px;color:#334155}
  ul.feed li:last-child{border-bottom:0}
  ul.feed time{flex:none;color:var(--mut);font-size:11px;width:108px;padding-top:2px}
  .empty{color:var(--mut);font-size:13px;padding:12px 2px}
  .foot{color:var(--mut);font-size:12px;margin-top:26px;display:flex;justify-content:space-between;align-items:center}
  .center{text-align:center;padding:60px 20px}
  .bigcheck{width:74px;height:74px;border-radius:50%;background:rgba(22,163,74,.12);color:var(--green);display:inline-flex;align-items:center;justify-content:center;margin-bottom:18px}
  .center h2{font-size:22px;font-weight:700;margin-bottom:6px}
  .center p{color:var(--mut);font-size:14px;margin-bottom:26px;max-width:420px}
  .steps{display:flex;gap:24px;margin-bottom:24px}
  .step{flex:1;position:relative;padding-top:6px}
  .step .n{width:26px;height:26px;border-radius:50%;background:#dfe7f5;color:#475569;font-size:12px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;margin-bottom:8px;border:1px solid #d1d9ea}
  .step.done .n{background:var(--blue2);color:#fff;border-color:var(--blue2)}
  .step .t{font-size:12px;font-weight:600;color:#475569}
  .step.done .t{color:var(--ink)}
  .hidden{display:none}
  .inl{display:flex;align-items:center;gap:10px}
  .warn-box{background:#fffbeb;border:1px solid #fde68a;color:#92400e;font-size:12px;border-radius:9px;padding:10px 12px;margin-bottom:14px;line-height:1.5}
</style>
</head>
<body>
<div class="top">
  <div class="logo"><svg viewBox="0 0 64 64"><path id="phIcon" d="M46 40.5v5a3 3 0 0 1-3.3 3 30.6 30.6 0 0 1-13.4-4.8 30.2 30.2 0 0 1-9.3-9.3A30.6 30.6 0 0 1 15.2 21a3 3 0 0 1 3-3.3h5a3 3 0 0 1 3 2.6c.2 1.4.5 2.8.9 4.1a3 3 0 0 1-.7 3.2l-2.2 2.2a24 24 0 0 0 9.3 9.3l2.2-2.2a3 3 0 0 1 3.2-.7c1.3.4 2.7.7 4.1.9a3 3 0 0 1 2.6 3z"/></svg></div>
  <div>
    <div class="word">Magic Dialer</div>
    <div class="tag">Automated voice outreach platform</div>
  </div>
  <div class="grow"></div>
  <span id="topPill" class="pill off hidden"><span class="dot"></span><span id="topPillTxt">Starting</span></span>
</div>

<div class="wrap">
  <div id="setupView" class="hidden">
    <div class="steps">
      <div class="step done"><div class="n">1</div><div class="t">Your company</div></div>
      <div class="step"><div class="n">2</div><div class="t">Contact &amp; leads</div></div>
      <div class="step"><div class="n">3</div><div class="t">Finish setup</div></div>
    </div>
    <div class="card" style="padding:22px 24px">
      <div class="warn-box">One-time setup. After you save, this PC starts as your agent and appears ONLINE in your portal within a few seconds.</div>
      <form id="setupForm">
        <div class="sec">
          <h2>Your company</h2>
          <div class="desc">How the AI agent introduces itself to the people it calls.</div>
          <div class="row">
            <div>
              <label for="fCompany">Company name</label>
              <input id="fCompany" autocomplete="organization" placeholder="e.g. Summit Logistics">
            </div>
            <div>
              <label for="fPersona">Agent first name</label>
              <input id="fPersona" autocomplete="given-name" placeholder="e.g. Atlas">
            </div>
          </div>
          <label for="fProduct">What do you sell / your service?</label>
          <input id="fProduct" placeholder="Short description the agent uses on calls">
        </div>
        <div class="sec">
          <h2>Contact &amp; leads</h2>
          <div class="desc">Where qualified leads go and how they reach you back.</div>
          <label for="fLeadFields">Info you want from each qualified lead (comma-separated)</label>
          <input id="fLeadFields" placeholder="name, phone, company">
          <div class="row">
            <div>
              <label for="fEmail">Email for qualified leads</label>
              <input id="fEmail" type="email" autocomplete="email" placeholder="you@company.com">
            </div>
            <div>
              <label for="fCallback">Callback number (optional)</label>
              <input id="fCallback" inputmode="tel" placeholder="e.g. +1 555 0123">
            </div>
          </div>
          <label for="fCallbackIn">Manager calls back within (optional)</label>
          <input id="fCallbackIn" placeholder="e.g. 30 minutes">
        </div>
        <div class="sec">
          <h2>Phone line (VOIP)</h2>
          <div class="desc">Your SIP credentials for outbound calls. Get these from your VOIP provider (RingCentral, Twilio, Vonage, etc). Leave blank to use PC speakers + mic only.</div>
          <div class="row">
            <div>
              <label for="fVoipProvider">Provider</label>
              <select id="fVoipProvider">
                <option value="">None (local mic only)</option>
                <option value="ringcentral">RingCentral</option>
                <option value="twilio">Twilio</option>
                <option value="vonage">Vonage</option>
                <option value="plivo">Plivo</option>
                <option value="thinq">ThinQ</option>
                <option value="flowroute">Flowroute</option>
                <option value="asterisk">Asterisk / FreePBX</option>
                <option value="generic">Generic SIP</option>
              </select>
            </div>
            <div>
              <label for="fVoipNumber">Outbound caller ID number</label>
              <input id="fVoipNumber" placeholder="+1 555 123 4567">
            </div>
          </div>
          <div class="row">
            <div>
              <label for="fVoipUser">SIP username / account</label>
              <input id="fVoipUser" placeholder="your SIP username">
            </div>
            <div>
              <label for="fVoipPass">SIP password</label>
              <input id="fVoipPass" type="password" placeholder="your SIP password">
            </div>
          </div>
          <div class="row">
            <div>
              <label for="fVoipServer">SIP server (optional)</label>
              <input id="fVoipServer" placeholder="sip.ringcentral.com">
            </div>
            <div>
              <label for="fVoipExt">Extension (optional)</label>
              <input id="fVoipExt" placeholder="101">
            </div>
          </div>
        </div>
        <div class="sec" style="border-bottom:0;padding-bottom:0">
          <h2>Finish local setup</h2>
          <div class="desc">Account connection is handled securely from your logged-in Magic Dialer portal. No access key is required here.</div>
          <div class="inl" style="margin-top:18px">
            <button type="submit" id="saveBtn" class="btn primary">Save &amp; start</button>
            <button type="button" id="cancelBtn" class="btn ghost">Cancel</button>
          </div>
          <div class="err" id="setupErr"></div>
          <div class="ok hidden" id="setupOk"></div>
        </div>
      </form>
    </div>
  </div>

  <div id="dashView" class="hidden">
    <div class="head">
      <div>
        <h1 id="dashTitle">Agent overview</h1>
        <p id="dashLine">Loading status…</p>
      </div>
      <div class="inl">
        <button id="pauseBtn" class="btn ghost hidden">Pause</button>
        <button id="resumeBtn" class="btn teal hidden">Resume</button>
      </div>
    </div>
    <div class="grid">
      <div class="stat"><div class="lab">Calls made</div><div class="val" id="sCalls">&ndash;</div><div class="sub">all time</div></div>
      <div class="stat"><div class="lab">Calls today</div><div class="val" id="sToday">&ndash;</div><div class="sub">since midnight</div></div>
      <div class="stat"><div class="lab">Qualified leads</div><div class="val" id="sQualified">&ndash;</div><div class="sub" id="sRate">0% rate</div></div>
      <div class="stat"><div class="lab">Best score</div><div class="val" id="sBest">&ndash;</div><div class="sub">qualification</div></div>
    </div>
    <div class="card" style="padding:20px 24px">
      <h2 style="font-size:14px;font-weight:600;margin-bottom:8px">Recent activity</h2>
      <ul class="feed" id="feed"><li class="empty">No activity yet.</li></ul>
    </div>
  </div>

  <div id="doneView" class="hidden">
    <div class="card"><div class="center">
      <div class="bigcheck"><svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg></div>
      <h2>All set. Your agent is running.</h2>
      <p>This window can be closed. Magic Dialer is now working on this PC and will appear ONLINE in your portal in a few seconds.</p>
      <button id="doneBtn" class="btn primary">Close this window</button>
    </div></div>
  </div>

  <div class="foot"><span id="footVersion">Magic Dialer</span><span>Automatic Outbound Calling Suite</span></div>
</div>

<script>
function $id(v){return document.getElementById(v)}
var state={configured:false,mode:"on"};
function statusClass(p){
  if(!p.status)return "off";
  if(p.status==="ONLINE")return "on";
  if(p.status==="DISABLED")return "err";
  if(p.status==="OFFLINE")return "warn";
  return "warn";
}
function statusText(p){
  if(p.status==="ONLINE")return "Online";
  if(p.status==="DISABLED")return "Disabled";
  if(p.status==="OFFLINE")return "Offline";
  return p.status||"Starting";
}
function renderPill(p){
  var el=$id("topPill"),tx=$id("topPillTxt");
  el.className="pill "+statusClass(p);
  tx.textContent=state.mode==="off"?"Paused":(statusText(p)||"—");
  el.classList.remove("hidden");
}
function numV(x){return x==null?"–":String(x).replace(/\\B(?=(\\d{3})+(?!\\d))/g,",")}
function renderStats(s){
  s=s||{};
  $id("sCalls").textContent=numV(s.calls||0);
  $id("sToday").textContent=numV(s.today||0);
  $id("sQualified").textContent=numV(s.qualified||0);
  $id("sBest").textContent=(s.bestScore==null||s.bestScore==null)?"–":(Math.round(s.bestScore*100)/100);
  $id("sRate").textContent=Math.round((s.qualifiedRate||0)*100)+"% rate";
  $id("dashTitle").textContent="Agent overview"+(state.mode==="off"?" (paused)":"");
}
function renderFeed(a){
  var ul=$id("feed");
  if(!a){ul.innerHTML='<li class="empty">No activity yet.</li>';return}
  ul.innerHTML=a.map(function(l){
    var t="";
    try{t=new Date(l.at).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}catch(e){}
    return '<li><time>'+t+'</time><span>'+escap(l.msg)+'</span></li>';
  }).join("");
}
function escap(s){var d=document.createElement("div");d.textContent=s==null?"":String(s);return d.innerHTML}
function renderStatus(p){
  if(!p)return;
  var stale = p.ts && (Date.now()-p.ts>25000);
  var eff = stale?Object.assign({},p,{status:"OFFLINE",line:p.line||"Agent heartbeat lost - the app process stopped."}):p;
  renderPill(eff);
  renderStats(eff.stats);
  renderFeed(eff.logs);
  $id("dashLine").textContent=eff.line||"—";
  $id("footVersion").textContent="Magic Dialer "+(eff.version||"");
  var paused=(eff.mode==="off"||state.mode==="off");
  $id("pauseBtn").classList.toggle("hidden",paused);
  $id("resumeBtn").classList.toggle("hidden",!paused);
  $id("topPillTxt").textContent=paused?"Paused":(statusText(eff)||"—");
}
async function loadState(){
  try{
    var r=await fetch("/api/state");var s=await r.json();
    state=s;
    if(s.configured){$id("setupView").classList.add("hidden");$id("doneView").classList.add("hidden");$id("dashView").classList.remove("hidden");document.title="Magic Dialer — Dashboard";tick();setInterval(tick,2000)}
    else{$id("dashView").classList.add("hidden");$id("doneView").classList.add("hidden");$id("setupView").classList.remove("hidden");document.title="Magic Dialer — Setup"}
  }catch(e){}
}
async function tick(){
  try{var r=await fetch("/api/status");var p=await r.json();
    state.mode=p.mode||state.mode||"on";
    if(p.done&&$id("doneView").classList.contains("hidden")&&!state.configured)return;
    renderStatus(p);
  }catch(e){}
}
$id("setupForm").addEventListener("submit",async function(ev){
  ev.preventDefault();
  var body={
    companyName:$id("fCompany").value.trim(),
    persona:$id("fPersona").value.trim(),
    product:$id("fProduct").value.trim(),
    leadFields:$id("fLeadFields").value.split(",").map(function(s){return s.trim()}).filter(Boolean),
    contactEmail:$id("fEmail").value.trim(),
    callbackNumber:$id("fCallback").value.trim(),
    callbackIn:$id("fCallbackIn").value.trim(),
    voipProvider:$id("fVoipProvider").value.trim(),
    voipNumber:$id("fVoipNumber").value.trim(),
    voipUser:$id("fVoipUser").value.trim(),
    voipPass:$id("fVoipPass").value.trim(),
    voipServer:$id("fVoipServer").value.trim(),
    voipExt:$id("fVoipExt").value.trim()};
  $id("setupErr").textContent="";
  var missing=[];
  if(!body.companyName)missing.push("company name");
  if(!body.product)missing.push("what you sell");
  if(missing.length){$id("setupErr").textContent="Please fill in: "+missing.join(", ")+".";return}
  var btn=$id("saveBtn");btn.disabled=true;btn.textContent="Starting agent…";
  try{
    var r=await fetch("/api/setup",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    var j=await r.json();
    if(!r.ok||!j.ok){$id("setupErr").textContent=j.error||"Setup failed. Please try again.";btn.disabled=false;btn.textContent="Save & start";return}
    $id("setupView").classList.add("hidden");
    $id("doneView").classList.remove("hidden");
    setTimeout(function(){window.close()},1800);
  }catch(e){$id("setupErr").textContent="Could not reach the local agent service.";btn.disabled=false;btn.textContent="Save & start"}
});
$id("cancelBtn").addEventListener("click",function(){window.close()});
$id("doneBtn").addEventListener("click",function(){window.close()});
$id("pauseBtn").addEventListener("click",async function(){await fetch("/api/pause",{method:"POST"});state.mode="off";tick()});
$id("resumeBtn").addEventListener("click",async function(){await fetch("/api/resume",{method:"POST"});state.mode="on";tick()});
loadState();
</script>
</body>
</html>`;

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not found.");
}

async function escapHtml(v) { return String(v == null ? "" : v).replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch])); }

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 100 * 1024) req.destroy(); });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve(null); }
    });
    req.on("error", () => resolve(null));
  });
}

/**
 * opts:
 *   readConfig : () -> config object|null
 *   writeConfig: (config) -> void
 *   statusPath : string|null (path to status.json the dashboard should read)
 *   onSetup    : (fields) -> void   (persist onboarding, called once)
 *   onMode     : (mode) -> void     ("on"|"off")
 *   onCall     : (number) -> Promise<any>
 *   serviceName: string (title/version seed)
 * Returns { port, url, close }.
 */
function listenOnFixedPort(server, port, cb) {
  server.once("error", (e) => cb(null, e));
  server.listen(port, "127.0.0.1", () => cb(server.address().port, null));
}

async function startWebUi(opts) {
  const serviceName = opts.serviceName || "Magic Dialer";
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const p = u.pathname;

    if (req.method === "GET" && p === "/" && u.searchParams.get("enroll")) {
      const ticket = String(u.searchParams.get("enroll") || "");
      const portal = String(u.searchParams.get("portal") || "").replace(/\/+$/, "");
      const number = String(u.searchParams.get("call") || "").replace(/[^0-9+]/g, "");
      if (!ticket || !/^https?:\/\//.test(portal)) { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("Invalid enrollment request."); return; }
      try {
        if (typeof opts.onEnroll !== "function") throw new Error("Enrollment unavailable");
        await opts.onEnroll({ ticket, portal });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end("<!doctype html><title>Magic Dialer</title><body style='font-family:system-ui;padding:32px'><h2>Magic Dialer</h2><h3 style='color:#15803d'>This PC is connected.</h3><p>Returning to the portal...</p><script>try{if(window.opener){window.opener.postMessage({type:'magic-dialer-enrolled'}, "+JSON.stringify(portal)+");setTimeout(function(){window.close()},250)}}catch(e){}</script></body>");
      } catch (e) {
        res.writeHead(409, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        const msg = e && e.message ? e.message : "Enrollment rejected";
        res.end("<!doctype html><title>Magic Dialer</title><body style='font-family:system-ui;padding:32px'><h2>Magic Dialer</h2><h3 style='color:#b91c1c'>PC connection failed.</h3><p>"+escapHtml(msg)+"</p><script>try{if(window.opener){window.opener.postMessage({type:'magic-dialer-enrollment-failed',error:"+JSON.stringify(String(msg))+"}, "+JSON.stringify(portal)+")}}catch(e){}</script></body>");
      }
      return;
    }
    if (req.method === "GET" && p === "/" && u.searchParams.get("call")) {
      const number = String(u.searchParams.get("call") || "").replace(/[^0-9+]/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(number)) { res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Invalid phone number."); return; }
      if (typeof opts.onCall !== "function") { res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" }); res.end("Local call control unavailable."); return; }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end("<!doctype html><title>Magic Dialer</title><body style='font-family:system-ui;padding:32px'><h2>Magic Dialer</h2><p>Starting local-engine test call...</p></body>");
      setImmediate(async () => { try { await opts.onCall(number); } catch {} });
      return;
    }
    if (req.method === "GET" && p === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAGE);
      return;
    }
    if (req.method === "GET" && p === "/favicon.ico") {
      res.writeHead(200, { "Content-Type": "image/x-icon", "Cache-Control": "max-age=86400" });
      res.end(Buffer.alloc(0));
      return;
    }
    if (req.method === "GET" && p === "/api/state") {
      const cfg = opts.readConfig();
      sendJson(res, 200, { configured: !!(cfg && (cfg.deviceToken || cfg.token) && cfg.portalUrl) });
      return;
    }
    if (req.method === "GET" && p === "/api/status") {
      let feed = { status: "STARTING", line: "Starting " + serviceName + "...", mode: "on" };
      if (opts.statusPath) {
        try { feed = Object.assign(feed, JSON.parse(fs.readFileSync(opts.statusPath, "utf8"))); } catch {}
      }
      sendJson(res, 200, feed);
      return;
    }
    if (req.method === "GET" && p === "/api/health") {
      sendJson(res, 200, { ok: true, service: serviceName });
      return;
    }
    if (req.method === "POST" && p === "/api/setup") {
      const body = await readJson(req);
      if (!body || typeof body !== "object") { sendJson(res, 400, { ok: false, error: "Bad request." }); return; }
      const companyName = String(body.companyName || "").trim();
      const product = String(body.product || "").trim();
      if (!companyName || !product) {
        sendJson(res, 400, { ok: false, error: "Company name and product are required." });
        return;
      }
      const persona = String(body.persona || "").trim() || "Atlas";
      const leadFields = Array.isArray(body.leadFields) ? body.leadFields.map(String).map((s) => s.trim()).filter(Boolean) : String(body.leadFields || "").split(",").map((s) => s.trim()).filter(Boolean);
      const contactEmail = String(body.contactEmail || "").trim();
      const callbackNumber = String(body.callbackNumber || "").trim() || null;
      const callbackIn = String(body.callbackIn || "").trim() || null;
      const voipProvider = String(body.voipProvider || "").trim();
      const voipNumber = String(body.voipNumber || "").trim();
      const voipUser = String(body.voipUser || "").trim();
      const voipPass = String(body.voipPass || "").trim();
      const voipServer = String(body.voipServer || "").trim();
      const voipExt = String(body.voipExt || "").trim();
      const cfg = opts.readConfig() || {};
      cfg.companyName = companyName;
      cfg.product = product;
      cfg.persona = persona;
      cfg.leadFields = leadFields;
      cfg.contactEmail = contactEmail;
      cfg.callbackNumber = callbackNumber;
      cfg.callbackIn = callbackIn;
      if (voipProvider || voipNumber || voipUser) {
        const HOSTED = { ringcentral: "sip.ringcentral.com", twilio: "sip-1042-sip.twilio.com", vonage: "sip.nexmo.com", plivo: "sip.plivo.com", thinq: "sip.thinq.com", flowroute: "sip.flowroute.com" };
        cfg.voip = {
          provider: voipProvider,
          number: voipNumber,
          username: voipUser,
          sipPassword: voipPass,
          server: voipServer || HOSTED[voipProvider] || "",
          extension: voipExt,
          ready: !!(voipUser && voipPass),
        };
      }
      opts.writeConfig(cfg);
      try { opts.onSetup && opts.onSetup(cfg); } catch {}
      sendJson(res, 200, { ok: true, configured: true });
      return;
    }
    if (req.method === "POST" && p === "/api/call") {
      const body = await readJson(req);
      const number = String(body && body.number || "").replace(/[^0-9+]/g, "");
      if (!/^\+?[0-9]{7,15}$/.test(number)) { sendJson(res, 400, { ok: false, error: "Invalid phone number." }); return; }
      if (typeof opts.onCall !== "function") { sendJson(res, 503, { ok: false, error: "Local call control unavailable." }); return; }
      try {
        const result = await opts.onCall(number);
        sendJson(res, 200, { ok: true, engine: "local", result });
      } catch (e) {
        sendJson(res, 500, { ok: false, engine: "local", error: e && e.message || "Local call failed." });
      }
      return;
    }
    if (req.method === "POST" && (p === "/api/pause" || p === "/api/resume")) {
      const mode = p === "/api/pause" ? "off" : "on";
      try {
        const cfg = opts.readConfig() || {};
        cfg.mode = mode;
        opts.writeConfig(cfg);
        if (opts.statusPath) {
          let s = { mode };
          try { s = Object.assign(s, JSON.parse(fs.readFileSync(opts.statusPath, "utf8"))); } catch {}
          s.mode = mode;
          fs.mkdirSync(path.dirname(opts.statusPath), { recursive: true });
          fs.writeFileSync(opts.statusPath, JSON.stringify(s));
        }
      } catch {}
      try { opts.onMode && opts.onMode(mode); } catch {}
      sendJson(res, 200, { ok: true, mode });
      return;
    }
    notFound(res);
  });

  const requestedPort = opts.port === 0 ? 0 : (opts.port || PREFERRED_PORT);
  const actualPort = await new Promise((resolve, reject) => {
    listenOnFixedPort(server, requestedPort, (port, err) => err ? reject(err) : resolve(port));
  });
  const url = `http://127.0.0.1:${actualPort}/`;
  return {
    port: actualPort,
    url,
    title: serviceName,
    close: () => new Promise((done) => server.close(done)),
  };
}

module.exports = { startWebUi, PAGE, localDataDir, dashboardUrlPath, writeDashboardUrl };