// Sync a published n8n CLI export into reviewable, secret-free repository JSON.
const fs = require('node:fs');
const path = require('node:path');

const input = process.argv[2];
if (!input) throw new Error('Usage: node sync-published.cjs <published-export.json>');
const workflows = JSON.parse(fs.readFileSync(input, 'utf8'));
const files = new Map([
  ['MailPilot — Email Intake', '01-email-intake.json'],
  ['MailPilot — AI Processing', '02-ai-processing.json'],
  ['MailPilot — SLA Escalation', '03-sla-escalation.json'],
  ['MailPilot — Queued Email Recovery', '04-queued-email-recovery.json'],
  ['MailPilot — Error Monitor', '05-error-monitor.json'],
]);
for (const [name, file] of files) {
  const matches = workflows.filter(w => w.name === name && w.active);
  if (matches.length !== 1) throw new Error(`Expected one published ${name}; found ${matches.length}`);
  const w = matches[0];
  if (w.pinData && Object.keys(w.pinData).length) throw new Error(`Pinned data in ${name}; review before export`);
  const sanitized = {
    id: w.id,
    name: w.name,
    active: true,
    nodes: w.nodes,
    connections: w.connections,
    settings: w.settings,
    pinData: {},
    tags: [],
  };
  fs.writeFileSync(path.join(__dirname, file), JSON.stringify(sanitized, null, 2) + '\n');
  console.log(`${file}: ${w.nodes.length} published nodes`);
}
