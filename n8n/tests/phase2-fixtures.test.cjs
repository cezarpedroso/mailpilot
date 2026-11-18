const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const workflow = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'workflows', '02-ai-processing.json'), 'utf8'));
const byName = (name) => workflow.nodes.find((node) => node.name === name);
const email = (body) => ({
  external_message_id: 'fixture-001',
  sender: 'customer@example.com',
  subject: 'Customer message',
  body,
});
const response = (content) => ({
  statusCode: 200,
  body: { choices: [{ message: { content } }] },
});
const runCode = (name, input, previous = {}) => {
  const source = byName(name)?.parameters.jsCode;
  assert.equal(typeof source, 'string', `Missing Code node: ${name}`);
  return vm.runInNewContext(`(() => { ${source} })()`, {
    $input: { first: () => ({ json: input }) },
    $: (nodeName) => ({ first: () => ({ json: previous[nodeName] }) }),
  })[0].json;
};

const examples = [
  ['I was charged twice this month.', 'billing', 'finance', 'high'],
  ['I cannot log in to my account.', 'support', 'support', 'medium'],
  ["I'd like pricing information for your business plan.", 'sales', 'sales', 'low'],
  ['What are your office hours?', 'general', 'general', 'low'],
];
const switchNode = byName('Route Category');
const routeNodes = ['Route finance', 'Route support', 'Route sales', 'Route general'];

for (const [body, category, team, priority] of examples) {
  const original = email(body);
  const prepared = runCode('Prepare Classification Request', original);
  assert.equal(prepared.request_body.model, 'openai/gpt-4o-mini');
  const classification = { category, priority, summary: 'A brief customer request.', needs_review: false };
  const validated = runCode('Validate Classification', response(JSON.stringify(classification)), {
    'When Executed by Another Workflow': original,
  });
  assert.equal(validated.category, category);
  assert.equal(validated.priority, priority);
  assert.ok(validated.summary);
  assert.equal(validated.classification_valid, true);
  const outputIndex = switchNode.parameters.rules.values.findIndex((rule) => rule.conditions.conditions[0].rightValue === category);
  assert.equal(byName(routeNodes[outputIndex]).parameters.assignments.assignments[0].value, team);
  const routed = { ...validated, assigned_team: team };
  const draftRequest = runCode('Prepare Draft Request', routed);
  const final = runCode('Validate Draft and Return', response('Thank you for contacting us. Could you share a few more details so our team can help?'), {
    'Prepare Draft Request': draftRequest,
  });
  assert.equal(final.processing_status, 'processed');
  assert.equal(final.assigned_team, team);
  assert.ok(final.suggested_reply.trim());
}

const original = email('Please help.');
for (const content of ['not json', JSON.stringify({ category: 'refunds', priority: 'high', summary: 'Request', needs_review: false }), JSON.stringify({ category: 'billing', priority: 'high' })]) {
  const result = runCode('Validate Classification', response(content), { 'When Executed by Another Workflow': original });
  assert.equal(result.processing_status, 'needs_review');
  assert.equal(result.needs_review, true);
  assert.equal(result.assigned_team, null);
  assert.equal(result.suggested_reply, null);
}

for (const [statusCode, errorCode] of [[401, 'openrouter_auth_failed'], [429, 'openrouter_rate_limited']]) {
  const result = runCode('Validate Classification', { statusCode, error: { message: `HTTP ${statusCode}` } }, {
    'When Executed by Another Workflow': original,
  });
  assert.equal(result.processing_status, 'ai_failed');
  assert.equal(result.error_code, errorCode);
}

const valid = runCode('Validate Classification', response(JSON.stringify({
  category: 'support', priority: 'medium', summary: 'Login issue.', needs_review: false,
})), { 'When Executed by Another Workflow': original });
const draftInput = { ...valid, assigned_team: 'support' };
const failedDraft = runCode('Validate Draft and Return', { statusCode: 429, error: { message: 'HTTP 429' } }, {
  'Prepare Draft Request': draftInput,
});
assert.equal(failedDraft.processing_status, 'draft_failed');
assert.equal(failedDraft.suggested_reply, null);
assert.equal(failedDraft.error_code, 'openrouter_rate_limited');

const unsafeDraft = runCode('Validate Draft and Return', response('We have processed your refund.'), {
  'Prepare Draft Request': draftInput,
});
assert.equal(unsafeDraft.processing_status, 'draft_failed');
assert.equal(unsafeDraft.error_code, 'unsafe_draft');
assert.equal(unsafeDraft.suggested_reply, null);

assert.equal(workflow.nodes.some((node) => /send.*email/i.test(node.name) || /gmail|smtp/i.test(node.type)), false);
console.log('Phase 2 fixture tests passed: four routes, malformed classifications, HTTP failures, and draft failure.');
