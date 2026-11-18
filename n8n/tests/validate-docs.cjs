const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const matches = [...readme.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)];
const local = matches.map(m => m[1]).filter(ref => !/^https?:/.test(ref) && !ref.startsWith('#'));
const missing = local.filter(ref => !fs.existsSync(path.join(root, ref)));
if (missing.length) throw new Error(`Broken local links: ${missing.join(', ')}`);
const expected = [
  '01-email-intake', '02-ai-processing', '03-sla-escalation',
  '04-queued-email-recovery', '05-error-monitor',
];
for (const name of expected) {
  if (!fs.existsSync(path.join(root, 'docs/images/workflows', `${name}.png`))) throw new Error(`Missing screenshot: ${name}`);
  if (!fs.existsSync(path.join(root, 'n8n/workflows', `${name}.json`))) throw new Error(`Missing workflow: ${name}`);
}
const diagram = readme.match(/```mermaid\r?\n([\s\S]*?)\r?\n```/);
if (!diagram || !diagram[1].startsWith('flowchart LR')) throw new Error('Missing architecture diagram');
const output = path.join(root, 'n8n/backups/architecture.mmd');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, diagram[1] + '\n');
console.log(`Verified ${local.length} local links, five workflow images/JSON exports, and extracted Mermaid source`);
