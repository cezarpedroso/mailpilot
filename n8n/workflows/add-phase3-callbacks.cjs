const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '01-email-intake.json');
const workflow = JSON.parse(fs.readFileSync(file, 'utf8'));
if (workflow.nodes.some((node) => node.name === 'Has API Email ID?')) throw new Error('Callbacks already added');
const node = (name, type, typeVersion, position, parameters) => ({
  id: `00000000-0000-4000-9000-${String(workflow.nodes.length + 1).padStart(12, '0')}`,
  name, type, typeVersion, position, parameters,
});
const edge = (name) => ({ node: name, type: 'main', index: 0 });
const response = workflow.nodes.find((n) => n.name === 'Respond Processing Result');
response.parameters.responseBody = "={{ $('Prepare Processing Response').first().json }}";
response.parameters.options.responseCode = "={{ $('Prepare Processing Response').first().json.processing_status === 'processed' ? 200 : $('Prepare Processing Response').first().json.processing_status === 'needs_review' ? 422 : 502 }}";
response.position = [1180, -100];
const statusCondition = {
  options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 2 },
  conditions: [
    { id: 'phase3-email-id', leftValue: "={{ $('Webhook').first().json.body?.email_id || '' }}", rightValue: '', operator: { type: 'string', operation: 'notEmpty', singleValue: true } },
    { id: 'phase3-status', leftValue: "={{ ['processed','needs_review'].includes($json.processing_status) ? 'yes' : 'no' }}", rightValue: 'yes', operator: { type: 'string', operation: 'equals' } },
  ],
  combinator: 'and',
};
workflow.nodes.push(node('Has API Email ID?', 'n8n-nodes-base.if', 2.2, [670, -100], { conditions: statusCondition, options: {} }));
const httpNode = (name, suffix, bodyExpression, x) => node(name, 'n8n-nodes-base.httpRequest', 4.2, [x, -200], {
  method: suffix === 'classification' ? 'PATCH' : 'POST',
  url: "={{ $env.MAILPILOT_API_URL + '/internal/emails/' + $('Webhook').first().json.body.email_id + '/" + suffix + "' }}",
  sendHeaders: true,
  headerParameters: { parameters: [
    { name: 'Content-Type', value: 'application/json' },
    { name: 'X-MailPilot-Token', value: '={{ $env.MAILPILOT_INTERNAL_TOKEN }}' },
  ] },
  sendBody: true,
  contentType: 'json',
  specifyBody: 'json',
  jsonBody: bodyExpression,
  options: { timeout: 10000 },
});
workflow.nodes.push(httpNode('Save Classification to Go', 'classification', "={{ { category: $('Prepare Processing Response').first().json.category, priority: $('Prepare Processing Response').first().json.priority, assigned_team: $('Prepare Processing Response').first().json.assigned_team, summary: $('Prepare Processing Response').first().json.summary, needs_review: $('Prepare Processing Response').first().json.needs_review, processing_status: $('Prepare Processing Response').first().json.processing_status } }}", 880));
workflow.nodes.push(httpNode('Save Draft to Go', 'drafts', "={{ { content: $('Prepare Processing Response').first().json.suggested_reply } }}", 1080));
workflow.connections['Prepare Processing Response'] = { main: [[edge('Has API Email ID?')]] };
workflow.connections['Has API Email ID?'] = { main: [[edge('Save Classification to Go')], [edge('Respond Processing Result')]] };
workflow.connections['Save Classification to Go'] = { main: [[edge('Save Draft to Go')]] };
workflow.connections['Save Draft to Go'] = { main: [[edge('Respond Processing Result')]] };
fs.writeFileSync(file, JSON.stringify(workflow, null, 2) + '\n');
