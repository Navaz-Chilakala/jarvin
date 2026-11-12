// Test-only child: simulate a process crash after a tool side effect.
const fs = require('node:fs');
const { RunJournal } = require(process.argv[2]);
const { runAgent } = require(process.argv[3]);
const [directory, workspace, baseUrl, marker] = process.argv.slice(4);
const journal = new RunJournal(directory);
const record = journal.start({ request: 'Test request', workspace, sessionId: 'test', model: 'test', hadImages: false });
runAgent({
  settings: { baseUrl, model: 'test', numCtx: 4096, temperature: 0, maxSteps: 2 },
  system: '', history: [{ role: 'user', content: 'Test request' }],
  tools: [{ name: 'side_effect', description: 'test', parameters: {}, risk: 'exec', run: async () => { fs.appendFileSync(marker, 'once\n'); process.exit(73); } }],
  ctx: { root: workspace, signal: new AbortController().signal },
  approve: async () => true,
  emit: (event) => {
    if (event.type === 'tool_start') journal.toolStart(record.id, event.id, event.name);
    if (event.type === 'tool_result') journal.toolResult(record.id, event.id, event.ok);
  },
}).catch((error) => { console.error(error); process.exit(1); });
