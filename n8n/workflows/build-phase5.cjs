const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');

const ids = { sla: 'p5SlaMailPilot2026', recovery: 'p5RecoveryMailPilot2026', error: 'p5ErrorMailPilot2026' };
const nodeId = (name) => {
  const h = crypto.createHash('sha256').update(`mailpilot-phase5:${name}`).digest('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-8${h.slice(17,20)}-${h.slice(20,32)}`;
};
const node = (name, type, version, x, y, parameters = {}, extra = {}) => ({ id: nodeId(name), name, type: `n8n-nodes-base.${type}`, typeVersion: version, position: [x,y], parameters, ...extra });
const schedule = (name,x,y) => node(name,'scheduleTrigger',1.2,x,y,{rule:{interval:[{field:'minutes',minutesInterval:5}]}});
const errorTrigger = (name,x,y) => node(name,'errorTrigger',1,x,y,{});
const code = (name,x,y,jsCode) => node(name,'code',2,x,y,{jsCode});
const http = (name,x,y,{method='GET',url,body,neverError=false,onError}) => {
  const parameters = { method, url, sendHeaders:true,
    headerParameters:{parameters:[{name:'X-MailPilot-Token',value:'={{ $env.MAILPILOT_INTERNAL_TOKEN }}'}]},
    options:{timeout:60000} };
  if(body){ parameters.sendBody=true; parameters.contentType='json'; parameters.specifyBody='json'; parameters.jsonBody=body; parameters.headerParameters.parameters.unshift({name:'Content-Type',value:'application/json'}); }
  if(neverError) parameters.options.response={response:{neverError:true}};
  return node(name,'httpRequest',4.2,x,y,parameters,{retryOnFail:true,maxTries:3,waitBetweenTries:1000,...(onError?{onError}:{})});
};
const ifNode = (name,x,y,left,right='yes') => node(name,'if',2.2,x,y,{conditions:{options:{caseSensitive:true,leftValue:'',typeValidation:'strict',version:2},conditions:[{id:nodeId(name+':condition'),leftValue:left,rightValue:right,operator:{type:'string',operation:'equals'}}],combinator:'and'},options:{}});
const flow = (name,id,nodes,edges,errorWorkflow) => {
  const connections={};
  for(const [from,to,index=0] of edges){
    connections[from] ||= {main:[]};
    connections[from].main[index] ||= [];
    connections[from].main[index].push({node:to,type:'main',index:0});
  }
  return {id,name,active:false,nodes,connections,settings:{executionOrder:'v1',...(errorWorkflow?{errorWorkflow}:{})},pinData:{},tags:[]};
};

const sla=flow('MailPilot — SLA Escalation',ids.sla,[
  schedule('Every 5 Minutes',-720,0),
  http('Get Unresolved Emails',-490,0,{url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/unresolved' }}"}),
  code('Calculate Deadline',-240,0,`return $input.all().map(item => ({ json: { ...item.json, deadline_passed: new Date(item.json.deadline_at).getTime() <= Date.now() } }));`),
  ifNode('SLA Deadline Passed?',10,0,"={{ $json.deadline_passed ? 'yes' : 'no' }}"),
  http('Create Escalation',260,-100,{method:'POST',url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/emails/' + $json.id + '/escalate' }}",body:'={{ {} }}'}),
  code('Record Escalation Outcome',510,-100,`return $input.all().map(item => ({ json: { notification_created: item.json.created === true, notification_id: item.json.notification_id || null } }));`),
],[['Every 5 Minutes','Get Unresolved Emails'],['Get Unresolved Emails','Calculate Deadline'],['Calculate Deadline','SLA Deadline Passed?'],['SLA Deadline Passed?','Create Escalation',0],['Create Escalation','Record Escalation Outcome']],ids.error);

const recovery=flow('MailPilot — Queued Email Recovery',ids.recovery,[
  schedule('Every 5 Minutes (Recovery)',-900,0),
  http('Get Retry Candidates',-680,0,{url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/retry-candidates' }}"}),
  http('Claim Retry Atomically',-450,0,{method:'POST',url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/emails/' + $json.id + '/claim' }}",body:'={{ {} }}',neverError:true}),
  ifNode('Claim Granted?',-200,0,"={{ $json.claim_token ? 'yes' : 'no' }}"),
  http('Retry Existing Intake',50,-100,{method:'POST',url:"={{ $env.MAILPILOT_INTAKE_URL + '/webhook/mailpilot-intake' }}",body:"={{ { email_id: $('Claim Retry Atomically').item.json.email_id, external_message_id: $('Claim Retry Atomically').item.json.external_message_id, sender: $('Claim Retry Atomically').item.json.sender, subject: $('Claim Retry Atomically').item.json.subject, body: $('Claim Retry Atomically').item.json.body } }}",neverError:true,onError:'continueRegularOutput'}),
  http('Complete Recovery Attempt',310,-100,{method:'POST',url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/emails/' + $('Claim Retry Atomically').item.json.email_id + '/complete' }}",body:"={{ { claim_token: $('Claim Retry Atomically').item.json.claim_token, success: $json.success === true && $json.processing_status === 'processed', error_code: $json.error_code || ($json.error ? 'intake_error' : '') } }}"}),
  ifNode('Recovered?',570,-100,"={{ $json.recovered ? 'yes' : 'no' }}"),
  code('Recovery Recorded',810,-200,`return $input.all().map(item => ({ json: { status: item.json.status, attempt: item.json.attempt } }));`),
  code('Backoff Recorded',810,0,`return $input.all().map(item => ({ json: { status: item.json.status, attempt: item.json.attempt } }));`),
],[['Every 5 Minutes (Recovery)','Get Retry Candidates'],['Get Retry Candidates','Claim Retry Atomically'],['Claim Retry Atomically','Claim Granted?'],['Claim Granted?','Retry Existing Intake',0],['Retry Existing Intake','Complete Recovery Attempt'],['Complete Recovery Attempt','Recovered?'],['Recovered?','Recovery Recorded',0],['Recovered?','Backoff Recorded',1]],ids.error);

const monitor=flow('MailPilot — Error Monitor',ids.error,[
  errorTrigger('Workflow Error Trigger',-440,0),
  code('Redact Failure Details',-190,0,`const data = $input.first().json;
const workflow = data.workflow || {};
const execution = data.execution || {};
const raw = String(execution.error?.message || data.trigger?.error?.message || data.error?.message || '');
const code = /timeout/i.test(raw) ? 'timeout' : /401|403|unauthori[sz]ed|credential/i.test(raw) ? 'authentication_error' : /429|rate.limit/i.test(raw) ? 'rate_limited' : /connect|ECONN/i.test(raw) ? 'connection_error' : 'workflow_error';
const summary = { timeout:'Workflow timed out', authentication_error:'Authentication failed', rate_limited:'Provider rate limit reached', connection_error:'Service connection failed', workflow_error:'Unexpected workflow execution failure' }[code];
const workflowID = String(workflow.id || 'unknown').slice(0,100);
const executionID = String(execution.id || '').slice(0,100);
const key = ['n8n',workflowID,executionID || String(execution.startedAt || data.timestamp || new Date().toISOString()),code].join(':').slice(0,255);
return [{ json: { workflow_id:workflowID, workflow_name:String(workflow.name || 'Unknown workflow').slice(0,100), execution_id:executionID, error_code:code, error_message:summary, idempotency_key:key } }];`),
  http('Record Automation Failure',90,0,{method:'POST',url:"={{ $env.MAILPILOT_API_URL + '/internal/automation/failures' }}",body:'={{ $json }}'}),
],[['Workflow Error Trigger','Redact Failure Details'],['Redact Failure Details','Record Automation Failure']]);

for (const [filename,value] of [['03-sla-escalation.json',sla],['04-queued-email-recovery.json',recovery],['05-error-monitor.json',monitor]]) {
  fs.writeFileSync(path.join(__dirname,filename),JSON.stringify(value,null,2)+'\n');
  console.log(`${filename}: ${value.nodes.length} nodes`);
}
