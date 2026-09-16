const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

// List available tools first
const body = {
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/list',
  params: {}
};
fetch('https://dashboard.suga.app/api/mcp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token.access_token,
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream'
  },
  body: JSON.stringify(body)
}).then(r => r.text())
  .then(t => {
    const parsed = JSON.parse(t.replace('event: message\ndata: ', ''));
    const tools = parsed.result.tools.map(t => t.name);
    console.log('Available tools:', tools.join(', '));
  })
  .catch(e => console.error(e.message));
