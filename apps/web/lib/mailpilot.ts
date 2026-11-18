export type Draft = { id: string; email_id: string; content: string; approval_status: "pending" | "approved" | "rejected"; created_at: string; updated_at: string };
export type Email = {
  id: string; external_message_id: string; sender: string; subject: string; body: string;
  category: "billing" | "support" | "sales" | "general" | null;
  priority: "low" | "medium" | "high" | null; assigned_team: string | null;
  summary: string | null; needs_review: boolean; processing_status: string;
  created_at: string; updated_at: string; draft_status?: Draft["approval_status"] | null; draft?: Draft;
  retry_attempts: number; next_retry_at: string; retry_lease_until?: string | null; last_error_code?: string | null;
};
export type WorkflowEvent = { id: string; email_id: string; event_type: string; details: Record<string, unknown>; created_at: string; subject?: string; external_message_id?: string };
export type Analytics = { total_emails: number; processed_emails: number; pending_emails: number; drafts_awaiting_approval: number; by_category: Record<string, number>; by_priority: Record<string, number> };
export type Notification = { id: string; email_id: string; type: string; message: string; read_at: string | null; created_at: string; subject: string };
export type AutomationError = { id: string; workflow_id: string; workflow_name: string; execution_id: string; error_code: string; error_message: string; created_at: string };

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api/${path}`, { ...init, cache: "no-store", headers: { "Content-Type": "application/json", ...init?.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data as T;
}

export function displayDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function titleCase(value: string | null | undefined) {
  return value ? value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Unclassified";
}
