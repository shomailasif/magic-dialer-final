const fs = require('fs');
const path = require('path');
const token = JSON.parse(fs.readFileSync(path.join(__dirname, 'sugamcp', 'token.json'), 'utf8'));

const body = {
  jsonrpc: '2.0',
  id: Date.now(),
  method: 'tools/call',
  params: {
    name: 'get_logs',
    arguments: {
      project_id: '47c28cbe-75fb-43b8-82d4-e62efb718adc',
      env_id: 'd31e44b8-2da7-4887-87af-de2bb2ea1edf',
      container_id: '0nrl0r6g7wyn',
      limit: 500,
      level: 'info'
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
  .then(t => {
    // Parse the SSE response
    const lines = t.split('\n');
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = JSON.parse(line.slice(6));
        const text = data.result?.content?.[0]?.text;
        if (text) {
          const parsed = JSON.parse(text);
          // Filter for sip-conv and llm logs only
          for (const log of parsed.logs || []) {
            if (log.message.includes('[sip-conv]') || log.message.includes('[llm]')) {
              console.log(log.timestamp.slice(11, 19), log.message);
            }
          }
        }
      }
    }
  })
  .catch(e => console.error(e.message));
