"use strict";

/* The offline brain has to survive the trip from this repo to a customer PC.
 *
 * The behaviour test proves the routing is right. This one proves the pieces it
 * needs are actually shipped, pinned and installed:
 *
 *   1. The installer carries the llama.cpp server next to agent.exe.
 *   2. The 807 MB model is NOT in the installer; it is downloaded into the
 *      customer's data folder, so upgrades never cost another download.
 *   3. The runtime download is pinned by release tag AND SHA-256.
 *   4. The model download is pinned by size AND SHA-256.
 *   5. The server is started with the flags measured on the target hardware.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const here = __dirname;
const agent = path.join(here, "..", "agent");
const read = (p) => fs.readFileSync(p, "utf8");

const localAi = read(path.join(agent, "local-ai.js"));
const localStt = read(path.join(agent, "local-stt.js"));
const stt = read(path.join(agent, "multilingual-stt.js"));
const installer = read(path.join(here, "installer.iss"));
const prepare = read(path.join(here, "prepare-local-ai.ps1"));
const workflow = read(path.join(here, "..", "..", "..", ".github", "workflows", "build-windows-engine.yml"));
const localRuntime = require(path.join(agent, "local-ai.js"));

const checks = [
  // 1. The runtime ships with the program, in its own folder.
  () => assert.match(
    installer,
    /Source:\s*"dist\\local-ai\\\*";\s*DestDir:\s*"\{app\}\\local-ai"/,
    "the installer must carry the offline brain runtime",
  ),
  () => assert.doesNotMatch(installer, /\/\*/, "Inno comments must use ';': a '/*' line aborts the installer build"),

  // 2. The model is a download, not installer payload.
  () => assert.doesNotMatch(installer, /\.gguf/i, "the 807 MB model must never be bundled into the installer"),
  () => assert.doesNotMatch(installer, /qwen/i, "the installer must not name a model file"),
  () => assert.match(
    localAi,
    /function modelPath\(\) \{\s*return path\.join\(dataDir\(\), "models", MODEL_FILE\);/,
    "the model must live in the customer data folder, not the install folder",
  ),
  () => assert.match(localAi, /function dataDir\(\)[\s\S]*?LOCALAPPDATA/, "the data folder is the customer's profile"),
  () => {
    const here = process.env.AUTODIAL_HOME;
    delete process.env.AUTODIAL_HOME;
    const p = localRuntime.modelPath();
    if (here !== undefined) process.env.AUTODIAL_HOME = here;
    assert.ok(/models[\\/]Llama-3\.2-1B-Instruct-Q4_K_M\.gguf$/.test(p), "unexpected model path: " + p);
    assert.ok(!/local-ai[\\/]models/.test(p), "the model must not be looked up inside the install folder: " + p);
  },

  // 3. The runtime archive is pinned twice: tag and hash.
  () => assert.match(prepare, /releases\/download\/b12110\/llama-b12110-bin-win-cpu-x64\.zip/, "pinned llama.cpp release URL"),
  () => assert.match(prepare, /\$llamaSha = "98901e327c252875accaf2d1bf364e10e868843b0b63468baad1aa945cdc5da2"/, "pinned llama.cpp archive SHA-256"),
  () => assert.match(prepare, /if \(\$haveHash -ne \$sha\) \{ throw/, "a mismatched archive must abort the build"),
  () => assert.match(prepare, /& \$server --version/, "the staged server must prove it starts"),
  () => assert.match(prepare, /llama-server\.exe/, "the server binary must be staged"),
  () => assert.match(prepare, /ggml-cpu-haswell\.dll/, "the AVX2 CPU backend must be staged"),
  () => assert.match(prepare, /ggml-cpu-sse42\.dll/, "the SSE4.2 CPU backend must be staged"),
  () => assert.match(prepare, /mtmd\.dll/, "llama-server needs mtmd.dll at load time"),

  // 4. The model download is pinned by size and hash, and resumes.
  () => assert.match(localAi, /const MODEL_FILE = "Llama-3\.2-1B-Instruct-Q4_K_M\.gguf";/, "pinned model file"),
  () => assert.match(localAi, /const MODEL_BYTES = 807694464;/, "pinned model size"),
  () => assert.match(localAi, /const MODEL_SHA256 = "6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83"/, "pinned model SHA-256"),
  () => assert.match(localAi, /const LEGACY_MODEL_FILES = \["qwen2\.5-1\.5b-instruct-q4_k_m\.gguf"\]/, "the replaced model must be cleaned up after an upgrade"),
  () => assert.match(localAi, /if \(MODEL_BYTES && size !== MODEL_BYTES\) throw/, "a truncated download must be refused"),
  () => assert.match(localAi, /if \(got !== MODEL_SHA256\)/, "a swapped download must be refused"),
  () => assert.match(localAi, /Range: `bytes=\$\{have\}-`/, "the download must resume instead of restarting"),
  () => assert.match(localAi, /if \(MODEL_BYTES && stat\.size !== MODEL_BYTES\) return false;/, "a partial model must not count as installed"),

  // 5. The flags that make it usable on a two-core laptop.
  () => assert.match(localAi, /"-c", "1024"/, "a small context keeps memory and prefill low"),
  () => assert.match(localAi, /"-t", "4"/, "four threads was the measured sweet spot"),
  () => assert.match(localAi, /"-np", "1"/, "one slot: calls are sequential"),
  () => assert.match(localAi, /"--no-webui"/, "no web UI to load or expose"),
  () => assert.match(localAi, /const FIRST_PORT = 48773;/, "local port range start"),
  () => assert.match(localAi, /const LAST_PORT = 48779;/, "local port range end"),
  () => assert.match(localAi, /"--host", "127\.0\.0\.1"/, "the local model must never listen on the network"),
  () => assert.match(localAi, /if \(await healthy\(port\)\) return port; \/\/ another engine instance owns it/, "a second engine must reuse a running server"),

  // 6. Build and smoke test prove the customer actually gets it.
  () => assert.match(workflow, /- name: Stage offline brain runtime[\s\S]*?prepare-local-ai\.ps1/, "CI must stage the runtime"),
  () => assert.match(workflow, /local-ai\\\\llama-server\.exe/, "CI smoke test must look for the installed server"),
  () => assert.match(workflow, /if \(-not \(Test-Path -LiteralPath \$offlineServer\)\) \{ throw/, "a missing installed runtime must fail the build"),
  () => assert.match(workflow, /& \$offlineServer --version/, "the installed runtime must be started by the smoke test"),

  // 7. The brain gets the mode from a real call, or none of this is reachable.
  () => assert.match(read(path.join(agent, "local-call-controller.js")), /ai: config\.ai/, "the call controller must pass the brain choice through"),
  () => assert.match(read(path.join(agent, "call-runner.js")), /voiceScript, ai \}/, "the call runner must pass the brain choice through"),
  () => assert.match(read(path.join(agent, "call.js")), /waitForFirstSpeech, ai \}/, "the call path must pass the brain choice through"),

  // 8. The offline transcriber ships too, with a model that is downloaded, not
  //    bundled, and a timeout that fits inside the controller's turn budget.
  () => assert.match(prepare, /releases\/download\/b5454\/whisper-bin-x64\.zip/, "pinned whisper.cpp release URL"),
  () => assert.match(prepare, /\$whisperSha = "6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb"/, "pinned whisper.cpp archive SHA-256"),
  () => assert.match(prepare, /whisper-cli\.exe/, "the transcriber binary must be staged"),
  () => assert.match(prepare, /\$wdest = Join-Path \$dest "whisper"/, "whisper needs its own folder: it ships different ggml DLLs than llama-server"),
  () => assert.match(prepare, /& \$whisper --version/, "the staged transcriber must prove it starts"),
  () => assert.match(installer, /recursesubdirs createallsubdirs/, "the installer must recurse into local-ai\\whisper"),
  () => assert.doesNotMatch(installer, /ggml-tiny|\.bin/i, "the hearing model must never be bundled into the installer"),
  () => assert.match(localStt, /const MODEL_FILE = "ggml-tiny\.bin";/, "pinned hearing model file"),
  () => assert.match(localStt, /const MODEL_BYTES = 77691713;/, "pinned hearing model size"),
  () => assert.match(localStt, /const MODEL_SHA256 = "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21"/, "pinned hearing model SHA-256"),
  () => assert.match(localStt, /const LOCAL_TIMEOUT_MS = 4500;/, "the local transcriber must fit inside the 9s STT turn budget"),
  () => assert.match(localStt, /"-bs", "1"/, "beam size 1 is the measured speed/quality choice on this hardware"),
  () => assert.match(localStt, /"-nf"/, "temperature fallback must be off: it multiplies the turn cost"),
  () => assert.match(localStt, /path\.join\(dir, "local-ai", "whisper"\)/, "the transcriber lives beside the brain runtime, in its own folder"),
  () => assert.match(localStt, /path\.join\(dataDir\(\), "models", MODEL_FILE\)/, "the hearing model lives in the customer data folder"),
  () => assert.match(stt, /require\("\.\/local-stt"\)/, "the STT path must be able to reach the local transcriber"),
  () => assert.match(stt, /"local-fallback"/, "the local fallback must label itself"),
  () => assert.match(read(path.join(agent, "local-call-controller.js")), /ai: config\.ai \}/, "the call controller must pass the mode to the transcriber"),
  () => assert.match(workflow, /local-ai\\\\whisper\\\\whisper-cli\.exe/, "CI smoke test must look for the installed transcriber"),
  () => assert.match(workflow, /& \$offlineHearing --version/, "the installed transcriber must be started by the smoke test"),
  () => assert.match(workflow, /\$ErrorActionPreference = "Continue"/, "native --version output goes to stderr and must not abort the smoke test"),

  // 9. It stays light while idle, and a rescue turn does not pay model load.
  () => assert.match(localAi, /const IDLE_STOP_MS = 10 \* 60 \* 1000;/, "the model must be released when no call is running"),
  () => assert.match(localAi, /idleTimer = setTimeout\(\(\) => \{[\s\S]*?stopServer\(\);/, "idle means stopped, not just unused"),
  () => assert.match(localAi, /process\.once\("exit", \(\) => \{[\s\S]*?stopServer\(\);/, "an upgrade must not leave an orphaned llama-server holding the port"),
  () => assert.match(localAi, /if \(r\.status === 200\) touchIdle\(\);/, "warming counts as activity, or the server stops under a live call"),
  () => assert.match(localAi, /touchIdle\(\);\s*return \{/, "every answered turn pushes the idle stop back"),
  () => {
    const brain = read(path.join(agent, "intelligent-brain.js"));
    assert.match(brain, /!localPreferred\(config\) && localAllowed\(config\) && localAi\.installed\(\)/, "auto mode must prewarm the fallback brain");
    assert.match(brain, /warmLocal\(config\)\.catch\(\(\) => \{\}\);/, "prewarming must be background work, never part of the dial gate");
  },

  // 10. The decisive sales turns are answered by policy, not by a 1B sampler.
  () => {
    const brain = read(path.join(agent, "intelligent-brain.js"));
    const policy = read(path.join(agent, "local-policy.js"));
    assert.match(brain, /require\("\.\/local-policy"\)/, "the brain must load the sales policy layer");
    assert.match(brain, /localPolicy\.policyReply\(localPolicy\.lastLeadLine\(history\)/, "policy must run before the model");
    assert.match(brain, /localPolicy\.conversationState\(history, config\)/, "the offline prompt must know what was already said");
    assert.match(policy, /case "price":/, "price must be a policy turn");
    assert.match(policy, /It depends on the lane and volume/, "the price answer must not invent a number");
    assert.match(policy, /case "not-interested":/, "a brush-off must be a policy turn");
    assert.match(policy, /case "source":/, "the number-source question must be answered honestly");
    assert.match(policy, /Already asked: /, "the model must be told which questions it already asked");
  },
];

checks.forEach((fn) => fn());
console.log(`offline brain packaging: ${checks.length}/${checks.length} contract checks PASS`);
