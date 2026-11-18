import { NextRequest } from "next/server";
import { auth } from "@/auth";

const emailPath = /^emails(?:\/[0-9a-f-]{36}(?:\/events|\/draft)?)?$/i;

function allowed(method: string, path: string) {
  if (method === "GET") return emailPath.test(path) || ["analytics", "workflow-events", "notifications", "automation-errors", "health"].includes(path);
  if (method === "POST") return path === "emails";
  if (method === "PATCH") return /^emails\/[0-9a-f-]{36}\/draft$/i.test(path);
  return false;
}

async function forward(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const session = await auth();
  const developmentOpen = process.env.NODE_ENV !== "production" && !process.env.MAILPILOT_DEMO_EMAIL && !process.env.MAILPILOT_DEMO_PASSWORD;
  if (!session?.user?.email && !developmentOpen) return Response.json({ error: "unauthorized" }, { status: 401 });
  const path = (await context.params).path.join("/");
  if (!allowed(request.method, path)) return Response.json({ error: "not_found" }, { status: 404 });
  const base = process.env.GO_API_URL || "http://127.0.0.1:8080";
  const secret = process.env.GO_API_SHARED_SECRET;
  if (!secret && process.env.NODE_ENV === "production") return Response.json({ error: "api_not_configured" }, { status: 503 });
  try {
    const upstream = await fetch(`${base.replace(/\/$/, "")}/${path}`, {
      method: request.method,
      headers: { "Content-Type": "application/json", ...(secret ? { "X-MailPilot-Frontend-Token": secret } : {}), ...(session?.user?.email ? { "X-MailPilot-Actor": session.user.email } : {}) },
      body: request.method === "GET" ? undefined : await request.text(),
      cache: "no-store",
      signal: AbortSignal.timeout(request.method === "POST" ? 15000 : 10000),
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "Content-Type": upstream.headers.get("Content-Type") || "application/json", "Cache-Control": "no-store" },
    });
  } catch {
    return Response.json({ error: "api_unavailable" }, { status: 503 });
  }
}

export const GET = forward;
export const POST = forward;
export const PATCH = forward;
