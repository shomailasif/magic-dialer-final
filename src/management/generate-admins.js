const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(String(password), String(salt), 100000, 32, "sha256").toString("hex");
}

const pw = process.argv[2] || "MagicDialer2026!";

const admins = ["admin1", "admin2"].map((id, i) => {
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    id,
    email: `${id}@example.com`,
    name: `Admin ${i + 1}`,
    salt,
    hash: hashPassword(pw, salt),
  };
});

const out = path.join(__dirname, "portal", "admins.json");
fs.writeFileSync(out, JSON.stringify(admins, null, 2));
console.log("Written to", out);
console.log("Password for both admins:", pw);
