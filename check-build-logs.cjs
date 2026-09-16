const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

// Check build logs
const body = {
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/call',
  params: {
    name: 'get_build_logs',
    arguments: {
      project_id: '47c28cbe-75fb-43b8-82d4-e62efb718adc',
      limit: 30
    }
  }
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
  .then(t => console.log(t.slice(0, 5000)))
  .catch(e => console.error(e.message));
