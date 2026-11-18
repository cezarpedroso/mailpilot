const fs = require('node:fs');
const path = require('node:path');
const base = path.join(__dirname, '..', 'backups');
const workflows = JSON.parse(fs.readFileSync(path.join(base, 'phase5-before.json'), 'utf8'));
for (const [name, filename] of [
  ['MailPilot — Email Intake', '01-intake-with-error.json'],
  ['MailPilot — AI Processing', '02-ai-with-error.json'],
]) {
  const workflow = workflows.find((item) => item.name === name && item.active);
  if (!workflow) throw new Error(`Active workflow missing: ${name}`);
  workflow.settings = { ...workflow.settings, errorWorkflow: 'p5ErrorMailPilot2026' };
  fs.writeFileSync(path.join(base, filename), JSON.stringify(workflow, null, 2) + '\n');
  console.log(`${name}: ${workflow.id}, ${workflow.nodes.length} nodes preserved`);
}
