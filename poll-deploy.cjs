const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

async function poll() {
  for (let i = 0; i < 60; i++) {
    const body = {
      jsonrpc: '2.0',
      id: Date.now(),
      method: 'tools/call',
      params: {
        name: 'list_deployments',
        arguments: {
          project_id: '47c28cbe-75fb-43b8-82d4-e62efb718adc',
          env_id: 'd31e44b8-2da7-4887-87af-de2bb2ea1edf'
        }
      }
    };
    const r = await fetch('https://dashboard.suga.app/api/mcp', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + token.access_token,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream'
      },
      body: JSON.stringify(body)
    });
    const t = await r.text();
    const match = t.match(/"status":"([^"]+)"/);
    if (match) {
      console.log(`[${new Date().toISOString()}] Status: ${match[1]}`);
      if (match[1] === 'active' || match[1] === 'completed') {
        console.log('Deployment complete!');
        // Check for error
        const errMatch = t.match(/"error":("[^"]*"|null)/);
        if (errMatch && errMatch[1] !== 'null') console.log('Error:', errMatch[1]);
        return;
      }
      if (match[1] === 'failed') {
        const errMatch = t.match(/"error":"([^"]+)"/);
        console.log('BUILD FAILED:', errMatch ? errMatch[1] : 'unknown');
        return;
      }
    }
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log('Timed out waiting');
}
poll();
