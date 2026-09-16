const fs = require('fs');
const t = JSON.parse(fs.readFileSync('sugamcp/token.json', 'utf8'));
console.log('expires_at:', t.expires_at);
console.log('issued_at:', t.issued_at);
console.log('now:', Date.now());
console.log('isExpired:', t.expires_at * 1000 < Date.now());