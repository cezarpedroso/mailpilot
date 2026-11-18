"use client";

import { Activity, ArrowRight, Bell, Clock3, RefreshCw, ShieldAlert, TriangleAlert } from "lucide-react";
import { type AutomationError, type Email, type Notification, type WorkflowEvent, displayDate, titleCase } from "@/lib/mailpilot";

type Props = {
  events: WorkflowEvent[];
  failures: Email[];
  queued: Email[];
  notifications: Notification[];
  automationErrors: AutomationError[];
  loading: boolean;
  openEmail: (id: string) => Promise<void>;
};

function Stat({ label, value, note, icon: Icon }: { label: string; value: number; note: string; icon: typeof Activity }) {
  return <div className="rounded border border-slate-200 bg-white p-4">
    <div className="flex items-center justify-between text-xs text-slate-600"><span>{label}</span><Icon className="size-4 text-cyan-700" /></div>
    <div className="mt-3 text-3xl font-semibold text-slate-950">{value}</div><p className="mt-1 text-[11px] text-slate-500">{note}</p>
  </div>;
}
function Panel({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return <section className="overflow-hidden rounded border border-slate-200 bg-white"><div className="border-b border-slate-200 p-5"><h2 className="font-semibold text-slate-950">{title}</h2><p className="mt-1 text-xs text-slate-500">{note}</p></div><div className="p-5">{children}</div></section>;
}
function EmptyLine({ children }: { children: React.ReactNode }) { return <p className="text-sm text-slate-500">{children}</p>; }

export function AutomationsView({ events, failures, queued, notifications, automationErrors, loading, openEmail }: Props) {
  const escalations = notifications.filter((item) => item.type === "sla_escalation");
  const recoveryEvents = events.filter((item) => item.event_type.startsWith("recovery_"));
  const retried = queued.filter((item) => item.retry_attempts > 0);
  return <>
    <div className="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
      <Stat label="Queued emails" value={queued.length} note="Latest 100 emails" icon={Clock3} />
      <Stat label="Retrying" value={retried.length} note="Queued with prior attempts" icon={RefreshCw} />
      <Stat label="SLA escalations" value={escalations.length} note="Latest 100 notifications" icon={ShieldAlert} />
      <Stat label="Automation errors" value={automationErrors.length} note="Latest 100 recorded failures" icon={TriangleAlert} />
    </div>
    {loading && <div className="mb-5 rounded border border-slate-200 p-4 text-sm text-slate-600">Loading persisted automation records…</div>}
    <div className="grid gap-5 xl:grid-cols-[1.35fr_1fr]">
      <div className="space-y-5">
        <Panel title="Workflow activity" note="Persisted application events; this is not n8n execution history">
          {events.length ? <div className="max-h-[420px] divide-y divide-slate-200 overflow-y-auto pr-2">{events.map((event) => <button key={event.id} onClick={() => void openEmail(event.email_id)} className="flex w-full items-center gap-3 py-3 text-left hover:text-cyan-700"><span className="grid size-9 shrink-0 place-items-center rounded-sm bg-cyan-400/10 text-cyan-700"><Activity className="size-4" /></span><span className="min-w-0 flex-1"><span className="block text-sm font-medium text-slate-800">{titleCase(event.event_type)}</span><span className="block truncate text-xs text-slate-500">{event.subject || event.email_id}</span></span><span className="text-[11px] text-slate-500">{displayDate(event.created_at)}</span><ArrowRight className="size-3.5 text-slate-600" /></button>)}</div> : <EmptyLine>No application events recorded.</EmptyLine>}
        </Panel>
        <Panel title="Recovery events" note="Claims, successful recovery, backoff, and exhausted attempts">
          {recoveryEvents.length ? <div className="max-h-[360px] space-y-3 overflow-y-auto pr-2">{recoveryEvents.map((event) => <button key={event.id} onClick={() => void openEmail(event.email_id)} className="flex w-full items-center justify-between rounded border border-slate-200 bg-slate-50 p-3 text-left"><div><div className="text-sm text-slate-800">{titleCase(event.event_type)}</div><div className="mt-1 text-xs text-slate-500">{event.subject} · Attempt {String(event.details?.attempt ?? "—")}</div></div><span className="text-[11px] text-slate-500">{displayDate(event.created_at)}</span></button>)}</div> : <EmptyLine>No recovery events recorded.</EmptyLine>}
        </Panel>
      </div>
      <div className="space-y-5">
        <Panel title="Queued and retrying" note="Current retry attempt and next eligible time">
          {queued.length ? <div className="space-y-3">{queued.map((email) => <button key={email.id} onClick={() => void openEmail(email.id)} className="w-full rounded border border-slate-200 bg-slate-50 p-3 text-left"><div className="truncate text-sm font-medium text-slate-800">{email.subject}</div><div className="mt-1 text-xs text-slate-500">Attempts: {email.retry_attempts} · Next: {displayDate(email.next_retry_at)}</div>{email.last_error_code && <div className="mt-1 text-xs text-amber-700">{titleCase(email.last_error_code)}</div>}</button>)}</div> : <EmptyLine>No emails are queued.</EmptyLine>}
          {failures.length > 0 && <div className="mt-4 border-t border-slate-200 pt-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-rose-700">Processing failures</h3>{failures.map((email) => <button key={email.id} onClick={() => void openEmail(email.id)} className="mb-2 block w-full rounded-sm bg-rose-400/[.05] p-3 text-left text-sm text-slate-700">{email.subject} · {titleCase(email.processing_status)} · {email.retry_attempts} retries</button>)}</div>}
        </Panel>
        <Panel title="SLA escalations" note="One notification per overdue unresolved email">
          {escalations.length ? <div className="space-y-3">{escalations.map((notice) => <button key={notice.id} onClick={() => notice.email_id && void openEmail(notice.email_id)} className="block w-full rounded border border-amber-400/15 bg-amber-400/[.05] p-3 text-left"><div className="text-sm text-slate-800">{notice.subject || "Email"}</div><div className="mt-1 text-xs text-amber-700">{notice.message}</div><div className="mt-1 text-[11px] text-slate-500">{displayDate(notice.created_at)}</div></button>)}</div> : <EmptyLine>No SLA escalations recorded.</EmptyLine>}
        </Panel>
        <Panel title="Recent automation errors" note="Sanitized failures captured by the n8n Error Monitor">
          {automationErrors.length ? <div className="space-y-3">{automationErrors.map((item) => <div key={item.id} className="rounded border border-rose-400/15 bg-rose-400/[.05] p-3"><div className="text-sm font-medium text-slate-800">{item.workflow_name}</div><div className="mt-1 text-xs text-rose-700">{item.error_message}</div><div className="mt-1 text-[11px] text-slate-500">Execution {item.execution_id || "unknown"} · {displayDate(item.created_at)}</div></div>)}</div> : <EmptyLine>No automation errors recorded.</EmptyLine>}
        </Panel>
        <Panel title="Internal notifications" note="Recent persisted SLA, recovery, and error notices">
          {notifications.length ? <div className="space-y-3">{notifications.map((notice) => <div key={notice.id} className="flex gap-2 border-b border-slate-200 pb-3 last:border-0 last:pb-0"><Bell className="mt-0.5 size-4 shrink-0 text-cyan-700" /><div><div className="text-sm text-slate-700">{notice.message}</div><div className="mt-1 text-[11px] text-slate-500">{titleCase(notice.type)} · {displayDate(notice.created_at)}</div></div></div>)}</div> : <EmptyLine>No internal notifications recorded.</EmptyLine>}
        </Panel>
      </div>
    </div>
  </>;
}
