/**
 * Flip the packaged agent EXE from console to GUI subsystem so no terminal
 * window ever appears next to the dashboard. pkg only emits console
 * executables; toggling the PE Subsystem field (3=console -> 2=windows) is
 * safe for the embedded Node runtime.
 *
 * Usage: node build/patch-gui.cjs build/dist/MagicDialer.exe
 */
const fs = require("node:fs");

const exe = process.argv[2];
if (!exe || !fs.existsSync(exe)) {
  console.error("usage: node build/patch-gui.cjs <path-to-exe>");
  process.exit(1);
}

const b = fs.readFileSync(exe);
const peOff = b.readUInt32LE(0x3c);
if (b.toString("ascii", peOff, peOff + 4) !== "PE\u0000\u0000") {
  console.error("not a PE file");
  process.exit(1);
}
const optMagic = b.readUInt16LE(peOff + 24);
if (optMagic !== 0x10b && optMagic !== 0x20b) {
  console.error("unexpected optional header magic 0x" + optMagic.toString(16));
  process.exit(1);
}
const subOff = peOff + 24 + 68; // Subsystem lives 0x44 into the optional header
const sub = b.readUInt16LE(subOff);
if (sub === 2) {
  console.log("already GUI subsystem - nothing to do");
  process.exit(0);
}
if (sub !== 3) {
  console.error("unexpected subsystem value " + sub);
  process.exit(1);
}
b.writeUInt16LE(2, subOff);
fs.writeFileSync(exe, b);
console.log("patched subsystem 3 -> 2 (GUI, no console window)");