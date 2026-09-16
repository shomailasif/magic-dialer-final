const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

const body = {
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/call',
  params: {
    name: 'wait_for_deployment',
    arguments: {
      project_id: '47c28cbe-75fb-43b8-82d4-e62efb718adc',
      env_id: 'd31e44b8-2da7-4887-87af-de2bb2ea1edf',
      deployment_id: '6e2a34ea-9555-4c4f-aabc-490095f7cfa2'
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
  .then(t => console.log(t.slice(0, 3000)))
  .catch(e => console.error(e.message));
