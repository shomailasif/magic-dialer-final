const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

const body = {
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/call',
  params: {
    name: 'set_env_variable',
    arguments: {
      project_id: '47c28cbe-75fb-43b8-82d4-e62efb718adc',
      env_id: 'd31e44b8-2da7-4887-87af-de2bb2ea1edf',
      container_id: '0nrl0r6g7wyn',
      name: '_DEPLOY5',
      value: (new Date).toString()
    }
  }
};

fetch('https://dashboard.suga.app/api/mcp', {
  method: 'POST',
  headers: {
    'Authorization': 'Bearer ' + token.access_token,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify(body)
}).then(r => r.text())
  .then(t => console.log('Deploy triggered:', t.slice(0, 300)))
  .catch(e => console.error('Deploy failed:', e.message));