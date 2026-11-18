"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, ArrowDownRight, BarChart3, Check, CheckCircle2, ChevronRight, Clock3, Inbox, LoaderCircle, LogOut, Mail, Menu, Plus, RefreshCw, Search, Send, ShieldCheck, Sparkles, TriangleAlert, X } from "lucide-react";
import { signOut } from "next-auth/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { AutomationsView } from "@/components/automations-view";
import { api, type Analytics, type AutomationError, type Email, type Notification, type WorkflowEvent, displayDate, titleCase } from "@/lib/mailpilot";

type View = "inbox" | "review" | "analytics" | "automations";
const nav = [
  { label: "Inbox", href: "/", icon: Inbox, view: "inbox" },
  { label: "Review Queue", href: "/review", icon: ShieldCheck, view: "review" },
  { label: "Analytics", href: "/analytics", icon: BarChart3, view: "analytics" },
  { label: "Automations", href: "/automations", icon: Activity, view: "automations" },
] as const;
const categories = ["all", "billing", "support", "sales", "general"];

function Pill({ children, tone = "slate" }: { children: React.ReactNode; tone?: "slate" | "purple" | "green" | "amber" | "red" | "cyan" }) {
  const colors = { slate: "bg-slate-100 text-slate-700", purple: "bg-cyan-100 text-cyan-900", green: "bg-emerald-100 text-emerald-800", amber: "bg-amber-100 text-amber-800", red: "bg-rose-100 text-rose-800", cyan: "bg-cyan-100 text-cyan-900" };
  return <span className={`inline-flex items-center gap-1 rounded-sm px-2.5 py-1 text-[11px] font-semibold capitalize ${colors[tone]}`}>{children}</span>;
}
function StatusPill({ email }: { email: Email }) {
  const tone = email.processing_status === "processed" ? "green" : email.processing_status.includes("failed") || email.processing_status === "retry_exhausted" ? "red" : "amber";
  return <Pill tone={tone}><span className="size-1.5 rounded-full bg-current" />{titleCase(email.processing_status)}</Pill>;
}
function CategoryPill({ category }: { category: Email["category"] }) { return <Pill tone={category ? "purple" : "slate"}>{category ? titleCase(category) : "Unclassified"}</Pill>; }
function PriorityPill({ priority }: { priority: Email["priority"] }) { return <Pill tone={priority === "high" ? "red" : priority === "medium" ? "amber" : "slate"}>{priority ? titleCase(priority) : "—"}</Pill>; }
function Empty({ icon: Icon, title, copy }: { icon: typeof Inbox; title: string; copy: string }) { return <div className="flex min-h-56 flex-col items-center justify-center border border-dashed border-slate-200 bg-slate-50 p-8 text-center"><div className="mb-4 bg-cyan-100 p-3 text-cyan-800"><Icon className="size-5" /></div><h3 className="font-semibold text-slate-900">{title}</h3><p className="mt-1 max-w-sm text-sm text-slate-600">{copy}</p></div>; }

export function MailPilotDashboard({ view }: { view: View }) {
  const pathname = usePathname();
  const [emails, setEmails] = useState<Email[]>([]);
  const [metrics, setMetrics] = useState<Analytics | null>(null);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [automationErrors, setAutomationErrors] = useState<AutomationError[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Email | null>(null);
  const [selectedEvents, setSelectedEvents] = useState<WorkflowEvent[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draftText, setDraftText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState("");
  const [simulateOpen, setSimulateOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [sender, setSender] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const [mail, stats, activity, notices, failures] = await Promise.all([api<Email[]>("emails"), api<Analytics>("analytics"), api<WorkflowEvent[]>("workflow-events"), api<Notification[]>("notifications"), api<AutomationError[]>("automation-errors")]);
      setEmails(mail); setMetrics(stats); setEvents(activity); setNotifications(notices); setAutomationErrors(failures); setError("");
    } catch (e) { setError(e instanceof Error ? e.message : "Could not load dashboard data"); }
    finally { setLoading(false); }
  }, []);

  const openEmail = useCallback(async (id: string) => {
    setSelectedId(id); setDetailLoading(true); setSaveMessage("");
    try {
      const [mail, timeline] = await Promise.all([api<Email>(`emails/${id}`), api<WorkflowEvent[]>(`emails/${id}/events`)]);
      setSelected(mail); setSelectedEvents(timeline); setDraftText(mail.draft?.content || "");
    } catch (e) { setSaveMessage(e instanceof Error ? e.message : "Could not load email"); }
    finally { setDetailLoading(false); }
  }, []);

  useEffect(() => { const timer = setTimeout(() => { void refresh(); }, 0); return () => clearTimeout(timer); }, [refresh]);
  useEffect(() => {
    if (!selectedId || !selected || selected.processing_status !== "queued") return;
    const timer = setInterval(() => { void openEmail(selectedId); void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [selectedId, selected, openEmail, refresh]);

  const filtered = useMemo(() => emails.filter((email) => {
    const matchesSearch = `${email.sender} ${email.subject} ${email.body} ${email.summary || ""}`.toLowerCase().includes(search.toLowerCase());
    return matchesSearch && (category === "all" || email.category === category);
  }), [emails, search, category]);
  const reviewItems = useMemo(() => emails.filter((email) => email.draft_status === "pending" || email.needs_review), [emails]);
  const failures = emails.filter((email) => email.processing_status.includes("failed") || email.processing_status === "retry_exhausted");
  const queued = emails.filter((email) => email.processing_status === "queued");

  async function submitEmail(event: React.FormEvent) {
    event.preventDefault(); setFormError("");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sender.trim()) || !subject.trim() || !body.trim()) { setFormError("Enter a valid sender address, subject, and message."); return; }
    setSubmitting(true);
    try {
      const created = await api<Email>("emails", { method: "POST", body: JSON.stringify({ external_message_id: `simulation-${crypto.randomUUID()}`, sender: sender.trim(), subject: subject.trim(), body: body.trim() }) });
      setSimulateOpen(false); setSender(""); setSubject(""); setBody("");
      await refresh(); await openEmail(created.id);
    } catch (e) { setFormError(e instanceof Error ? e.message : "Could not submit email"); }
    finally { setSubmitting(false); }
  }

  async function updateDraft(status?: "approved" | "rejected") {
    if (!selected?.draft) return;
    if (!draftText.trim()) { setSaveMessage("The reply cannot be empty."); return; }
    setSaving(true); setSaveMessage("");
    try {
      await api(`emails/${selected.id}/draft`, { method: "PATCH", body: JSON.stringify({ content: draftText.trim(), ...(status ? { approval_status: status } : {}) }) });
      await openEmail(selected.id); await refresh();
      setSaveMessage(status ? `Draft ${status}. No email was sent.` : "Draft saved.");
    } catch (e) { setSaveMessage(e instanceof Error ? e.message : "Could not save draft"); }
    finally { setSaving(false); }
  }

  const title = { inbox: "Inbox", review: "Review Queue", analytics: "Analytics", automations: "Automations" }[view];
  const subtitle = { inbox: "Manage incoming messages and AI drafts.", review: "Approve or edit suggested replies.", analytics: "Email activity at a glance.", automations: "Workflow status and recovery." }[view];

  return <div className="min-h-screen lg:flex">
    <aside className={`${mobileOpen ? "flex" : "hidden"} fixed inset-0 z-40 flex-col border-r border-[#555a60] bg-[#454a50] p-4 text-white lg:sticky lg:top-0 lg:flex lg:h-screen lg:w-[238px] lg:shrink-0`}>
      <div className="flex items-center justify-between px-1 py-1"><Link href="/" className="flex items-center gap-3" onClick={() => setMobileOpen(false)}><span className="grid size-9 place-items-center border border-cyan-300 text-cyan-200"><Mail className="size-4" /></span><span className="text-[18px] font-bold tracking-tight text-white">mailpilot.</span></Link><button className="lg:hidden" onClick={() => setMobileOpen(false)} aria-label="Close navigation"><X className="size-5" /></button></div>
      <div className="mt-11 px-2 text-[10px] font-bold uppercase tracking-[.14em] text-slate-200">Workspace</div>
      <nav className="mt-3 space-y-1">{nav.map((item) => <Link key={item.href} href={item.href} onClick={() => setMobileOpen(false)} className={`flex items-center gap-3 border-l-[3px] px-3 py-3 text-sm font-medium transition-colors ${pathname === item.href ? "border-cyan-300 bg-black/15 text-white" : "border-transparent text-slate-200 hover:bg-white/10 hover:text-white"}`}><item.icon className="size-[18px]" /><span>{item.label}</span>{item.view === "review" && metrics && metrics.drafts_awaiting_approval > 0 && <span className="ml-auto bg-cyan-200 px-1.5 py-0.5 text-[10px] font-bold text-slate-900">{metrics.drafts_awaiting_approval}</span>}</Link>)}</nav>
      <div className="mt-auto border-t border-white/20 px-2 pt-4 text-xs text-slate-200"><div className="font-semibold text-white">Demo workspace</div><div className="mt-1">Draft approval required</div><button onClick={() => void signOut({ callbackUrl: "/login" })} className="mt-4 flex items-center gap-2 text-cyan-200 hover:text-white"><LogOut className="size-3.5" />Sign out</button></div>
    </aside>

    <div className="min-w-0 flex-1"><header className="sticky top-0 z-20 flex h-[64px] items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur-sm sm:px-8 lg:px-10"><div className="flex items-center gap-3"><button className="text-slate-700 lg:hidden" onClick={() => setMobileOpen(true)} aria-label="Open navigation"><Menu className="size-5" /></button><span className="text-xs text-slate-600">Workspace</span><ChevronRight className="size-3 text-slate-400" /><span className="text-xs font-semibold text-slate-900">{title}</span></div><div className="flex items-center gap-3"><button onClick={() => void refresh(true)} className="p-2 text-slate-600 hover:bg-slate-100 hover:text-slate-950" aria-label="Refresh data"><RefreshCw className="size-4" /></button><div className="hidden items-center gap-2 border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-semibold text-slate-800 sm:flex"><span className="size-1.5 bg-cyan-500" />Live data</div></div></header>
      <main className="mx-auto max-w-[1500px] px-5 pb-16 pt-9 sm:px-8 lg:px-10"><div className="mb-8 flex flex-col justify-between gap-5 sm:flex-row sm:items-start"><div><div className="mb-2 text-[11px] font-semibold uppercase tracking-[.15em] text-cyan-700">Mail operations</div><h1 className="text-3xl font-semibold tracking-tight text-slate-950 sm:text-[36px]">{title}</h1><p className="mt-2 text-sm text-slate-600">{subtitle}</p></div>{view === "inbox" && <Button className="h-10 rounded-sm bg-cyan-600 px-4 text-white hover:bg-cyan-700" onClick={() => setSimulateOpen(true)}><Plus className="mr-1 size-4" /> Simulate email</Button>}</div>
      {error && <div role="alert" className="mb-6 flex items-center gap-3 rounded border border-rose-500/25 bg-rose-500/10 px-4 py-3 text-sm text-rose-700"><TriangleAlert className="size-4 shrink-0" />{error}<button className="ml-auto underline" onClick={() => void refresh(true)}>Retry</button></div>}
      {view === "inbox" && <>
        <div className="mb-7 grid grid-cols-2 gap-3 xl:grid-cols-4"><Metric label="Total emails" value={metrics?.total_emails} icon={Mail} loading={loading} note="All stored messages" /><Metric label="Processed" value={metrics?.processed_emails} icon={CheckCircle2} loading={loading} note="AI workflow complete" /><Metric label="Awaiting review" value={metrics?.drafts_awaiting_approval} icon={ShieldCheck} loading={loading} note="Pending draft approvals" /><Metric label="Queued" value={metrics?.pending_emails} icon={Clock3} loading={loading} note="Waiting for processing" /></div>
        <div className="overflow-hidden rounded-sm border border-slate-200 bg-white shadow-sm shadow-slate-200/40"><div className="flex flex-col gap-4 border-b border-slate-200 p-5 lg:flex-row lg:items-center lg:justify-between"><h2 className="text-base font-semibold text-slate-950">Messages</h2><div className="flex flex-wrap gap-2"><div className="relative min-w-[190px] flex-1 lg:w-60"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" /><Input aria-label="Search emails" placeholder="Search messages..." value={search} onChange={(e) => setSearch(e.target.value)} className="h-9 border-slate-200 bg-slate-50 pl-9 text-sm" /></div><select aria-label="Filter by category" value={category} onChange={(e) => setCategory(e.target.value)} className="h-9 rounded-sm border border-slate-200 bg-slate-50 px-3 text-xs text-slate-700">{categories.map((c) => <option key={c} value={c}>{c === "all" ? "All categories" : titleCase(c)}</option>)}</select></div></div>
          {loading ? <ListSkeleton /> : filtered.length === 0 ? <div className="p-5"><Empty icon={Inbox} title="No messages found" copy={emails.length ? "Try a different search or category." : "Simulate an incoming email to start your workspace."} /></div> : <div className="divide-y divide-slate-200">{filtered.map((email) => <EmailRow key={email.id} email={email} onClick={() => void openEmail(email.id)} />)}</div>}
        </div>
      </>}
      {view === "review" && <><div className="mb-6 flex items-center gap-3 border border-cyan-200 bg-cyan-50 px-4 py-3 text-sm text-slate-700"><ShieldCheck className="size-4 text-cyan-700" /><span>Approval updates the draft. No email is sent.</span></div><div className="overflow-hidden rounded-sm border border-slate-200 bg-white"><div className="border-b border-slate-200 p-5"><h2 className="font-semibold text-slate-950">Needs review</h2></div>{loading ? <ListSkeleton /> : reviewItems.length ? <div className="divide-y divide-slate-200">{reviewItems.map((email) => <EmailRow key={email.id} email={email} onClick={() => void openEmail(email.id)} review />)}</div> : <div className="p-5"><Empty icon={CheckCircle2} title="Review queue is clear" copy="New drafts and flagged emails appear here." /></div>}</div></>}
      {view === "analytics" && <AnalyticsView data={metrics} loading={loading} />}
      {view === "automations" && <AutomationsView events={events} failures={failures} queued={queued} notifications={notifications} automationErrors={automationErrors} loading={loading} openEmail={openEmail} />}
      </main>
    </div>

    <Dialog open={simulateOpen} onOpenChange={setSimulateOpen}><DialogContent style={{ maxWidth: "min(32rem, calc(100% - 2rem))" }} className="border-slate-200 bg-white p-6"><DialogHeader><DialogTitle className="flex items-center gap-2 text-lg"><span className="grid size-8 place-items-center rounded-sm bg-cyan-500/20 text-cyan-700"><Plus className="size-4" /></span>Simulate incoming email</DialogTitle><DialogDescription className="text-slate-600">Send a fictional message through Go, n8n, and OpenRouter. No email will be sent.</DialogDescription></DialogHeader><form onSubmit={submitEmail} className="mt-2 space-y-4"><label className="block text-xs font-semibold text-slate-700">Sender<Input type="email" required maxLength={320} placeholder="customer@example.com" className="mt-2 border-slate-200 bg-slate-50" value={sender} onChange={(e) => setSender(e.target.value)} /></label><label className="block text-xs font-semibold text-slate-700">Subject<Input required placeholder="How can we help?" className="mt-2 border-slate-200 bg-slate-50" value={subject} onChange={(e) => setSubject(e.target.value)} /></label><label className="block text-xs font-semibold text-slate-700">Message<Textarea required rows={6} placeholder="Write the incoming email..." className="mt-2 border-slate-200 bg-slate-50" value={body} onChange={(e) => setBody(e.target.value)} /></label>{formError && <p role="alert" className="text-xs text-rose-700">{formError}</p>}<Button type="submit" disabled={submitting} className="w-full bg-cyan-600 text-white hover:bg-cyan-700">{submitting ? <><LoaderCircle className="mr-2 size-4 animate-spin" />Processing through n8n...</> : <><Send className="mr-2 size-4" />Process email</>}</Button></form></DialogContent></Dialog>

    <Dialog open={Boolean(selectedId)} onOpenChange={(open) => { if (!open) { setSelectedId(null); setSelected(null); } }}><DialogContent style={{ maxWidth: "min(48rem, calc(100% - 2rem))" }} className="max-h-[92vh] overflow-y-auto border-slate-200 bg-white p-0"><DialogHeader className="border-b border-slate-200 px-6 py-5"><DialogTitle className="pr-8 text-xl">{detailLoading ? "Loading message..." : selected?.subject || "Message"}</DialogTitle><DialogDescription className="text-slate-600">{selected ? `${selected.sender} · ${displayDate(selected.created_at)}` : "Fetching persisted record"}</DialogDescription></DialogHeader>{detailLoading && !selected ? <div className="space-y-4 p-6"><Skeleton className="h-20" /><Skeleton className="h-32" /></div> : selected && <div className="space-y-6 p-6"><div className="flex flex-wrap gap-2"><CategoryPill category={selected.category} /><PriorityPill priority={selected.priority} /><StatusPill email={selected} />{selected.needs_review && <Pill tone="amber">Needs classification review</Pill>}</div><div className="grid gap-3 sm:grid-cols-2"><Info label="Assigned department" value={titleCase(selected.assigned_team)} /><Info label="External message ID" value={selected.external_message_id} /></div><section><SectionTitle icon={Mail}>Original email</SectionTitle><div className="mt-3 whitespace-pre-wrap break-words rounded border border-slate-200 bg-slate-50 p-4 text-sm leading-7 text-slate-700">{selected.body}</div></section><section><SectionTitle icon={Sparkles}>AI analysis</SectionTitle><p className="mt-3 rounded border border-cyan-400/10 bg-cyan-400/[.05] p-4 text-sm leading-6 text-slate-700">{selected.summary || "Classification is still pending."}</p></section><section><div className="flex items-center justify-between"><SectionTitle icon={Send}>Suggested reply</SectionTitle>{selected.draft && <Pill tone={selected.draft.approval_status === "approved" ? "green" : selected.draft.approval_status === "rejected" ? "red" : "amber"}>{titleCase(selected.draft.approval_status)}</Pill>}</div>{selected.draft ? <><Textarea aria-label="Suggested reply" className="mt-3 min-h-36 border-slate-200 bg-slate-50 leading-6" value={draftText} onChange={(e) => setDraftText(e.target.value)} disabled={selected.draft.approval_status !== "pending"} /><div className="mt-3 flex flex-wrap gap-2"><Button size="sm" variant="outline" onClick={() => void updateDraft()} disabled={saving || selected.draft.approval_status !== "pending" || draftText.trim() === selected.draft.content} className="border-slate-200">Save changes</Button><Button size="sm" onClick={() => void updateDraft("approved")} disabled={saving || selected.draft.approval_status !== "pending"} className="bg-emerald-500 text-[#072018] hover:bg-emerald-400"><Check className="mr-1 size-3" />Approve</Button><Button size="sm" variant="outline" onClick={() => void updateDraft("rejected")} disabled={saving || selected.draft.approval_status !== "pending"} className="border-rose-400/25 text-rose-700"><X className="mr-1 size-3" />Reject</Button></div><p className="mt-2 text-xs text-slate-500">Review actions only update the stored draft. Nothing is sent.</p></> : <p className="mt-3 rounded border border-dashed border-slate-200 p-4 text-sm text-slate-600">A draft has not been generated yet. {selected.processing_status === "queued" ? "Checking for updates..." : "Check the workflow activity for details."}</p>}{saveMessage && <p role="status" className="mt-3 text-xs text-cyan-700">{saveMessage}</p>}</section><section><SectionTitle icon={Activity}>Workflow timeline</SectionTitle><div className="mt-4 space-y-4">{selectedEvents.length ? selectedEvents.map((event) => <div key={event.id} className="flex gap-3"><div className="mt-1.5 size-2 shrink-0 rounded-full bg-cyan-400 ring-4 ring-cyan-400/10" /><div><div className="text-sm font-medium text-slate-800">{titleCase(event.event_type)}</div><div className="mt-1 text-xs text-slate-500">{displayDate(event.created_at)}</div></div></div>) : <p className="text-sm text-slate-500">No workflow events recorded.</p>}</div></section></div>}</DialogContent></Dialog>
  </div>;
}

function SectionTitle({ icon: Icon, children }: { icon: typeof Mail; children: React.ReactNode }) { return <h3 className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.13em] text-slate-600"><Icon className="size-4 text-cyan-700" />{children}</h3>; }
function Info({ label, value }: { label: string; value: string }) { return <div className="min-w-0 rounded border border-slate-200 bg-slate-50 p-3"><div className="text-[11px] text-slate-500">{label}</div><div className="mt-1 truncate text-sm font-medium text-slate-800" title={value}>{value}</div></div>; }
function Metric({ label, value, icon: Icon, note, loading }: { label: string; value?: number; icon: typeof Mail; note: string; loading: boolean }) { return <div className="rounded border border-slate-200 bg-white p-4"><div className="flex items-start justify-between"><span className="text-xs font-medium text-slate-600">{label}</span><span className="rounded-sm bg-cyan-400/10 p-2 text-cyan-700"><Icon className="size-4" /></span></div>{loading ? <Skeleton className="mt-4 h-9 w-16" /> : <div className="mt-3 text-[30px] font-semibold tracking-tight text-slate-950">{value ?? 0}</div>}<p className="mt-1 text-[11px] text-slate-500">{note}</p></div>; }
function EmailRow({ email, onClick, review = false }: { email: Email; onClick: () => void; review?: boolean }) { return <button onClick={onClick} className="group flex w-full flex-col gap-3 px-5 py-4 text-left transition-colors hover:bg-cyan-50/50 lg:flex-row lg:items-center"><div className="flex min-w-0 flex-1 items-start gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-sm bg-slate-100 text-xs font-bold text-slate-800">{email.sender.slice(0, 2).toUpperCase()}</div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="truncate text-sm font-semibold text-slate-900 group-hover:text-cyan-700">{email.subject}</span>{review && email.draft_status === "pending" && <span className="size-1.5 bg-cyan-500" />}</div><p className="mt-1 truncate text-xs text-slate-600">{email.sender} <span className="px-1 text-slate-400">·</span> {email.summary || email.body}</p></div></div><div className="flex shrink-0 flex-wrap items-center gap-2 pl-[52px] lg:pl-0"><CategoryPill category={email.category} /><PriorityPill priority={email.priority} /><span className="hidden min-w-20 text-xs capitalize text-slate-600 xl:block">{email.assigned_team || "—"}</span><span className="min-w-[76px] text-right text-[11px] text-slate-500">{displayDate(email.created_at)}</span><ChevronRight className="size-4 text-slate-500 group-hover:text-cyan-700" /></div></button>; }
function ListSkeleton() { return <div className="space-y-5 p-5">{[1, 2, 3, 4].map((n) => <div key={n} className="flex items-center gap-3"><Skeleton className="size-10 rounded" /><div className="flex-1"><Skeleton className="mb-2 h-4 w-1/3" /><Skeleton className="h-3 w-2/3" /></div></div>)}</div>; }

function AnalyticsView({ data, loading }: { data: Analytics | null; loading: boolean }) {
  const categories = ["billing", "support", "sales", "general"];
  const priorities = ["high", "medium", "low"];
  const bar = (label: string, count: number, total: number, color: string) => <div key={label} className="space-y-2"><div className="flex justify-between text-sm"><span className="capitalize text-slate-700">{label}</span><span className="font-semibold text-slate-950">{count}</span></div><div className="h-2 overflow-hidden rounded-sm bg-slate-200"><div className={`h-full rounded-sm ${color}`} style={{ width: `${total ? count / total * 100 : 0}%` }} /></div></div>;
  return <><div className="grid grid-cols-2 gap-3 xl:grid-cols-4"><Metric label="Total emails" value={data?.total_emails} icon={Mail} loading={loading} note="Stored in PostgreSQL" /><Metric label="Processed" value={data?.processed_emails} icon={CheckCircle2} loading={loading} note="AI workflow completed" /><Metric label="Pending" value={data?.pending_emails} icon={Clock3} loading={loading} note="Queued for processing" /><Metric label="Drafts to review" value={data?.drafts_awaiting_approval} icon={ShieldCheck} loading={loading} note="Awaiting approval" /></div><div className="mt-6 grid gap-5 lg:grid-cols-2"><div className="rounded border border-slate-200 bg-white p-6"><h2 className="font-semibold text-slate-950">Emails by category</h2><p className="mt-1 text-xs text-slate-500">AI assigned classifications</p><div className="mt-7 space-y-6">{categories.map((c) => bar(c, data?.by_category[c] || 0, data?.total_emails || 0, "bg-cyan-400"))}</div></div><div className="rounded border border-slate-200 bg-white p-6"><h2 className="font-semibold text-slate-950">Emails by priority</h2><p className="mt-1 text-xs text-slate-500">Current persisted priority</p><div className="mt-7 space-y-6">{priorities.map((p) => bar(p, data?.by_priority[p] || 0, data?.total_emails || 0, p === "high" ? "bg-rose-400" : p === "medium" ? "bg-amber-400" : "bg-cyan-400"))}</div></div></div><div className="mt-5 flex items-center gap-2 rounded border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600"><ArrowDownRight className="size-4 text-cyan-700" />These counts come from the application database. Unclassified queued emails are omitted from category and priority bars.</div></>;
}
