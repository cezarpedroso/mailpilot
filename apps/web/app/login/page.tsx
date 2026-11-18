"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { Mail, LockKeyhole, LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    const result = await signIn("credentials", { email, password, redirect: false });
    setBusy(false);
    if (result?.error) { setError("Invalid email or password."); return; }
    router.push("/");
    router.refresh();
  }
  return <main className="grid min-h-screen place-items-center bg-[#f6f7f9] p-5">
    <form onSubmit={submit} className="w-full max-w-sm border border-slate-200 bg-white p-7 shadow-sm">
      <div className="mb-7 flex items-center gap-3"><span className="grid size-10 place-items-center border border-cyan-500 bg-slate-900 text-cyan-300"><Mail className="size-5" /></span><div><h1 className="text-xl font-bold tracking-tight text-slate-950">mailpilot.</h1><p className="text-xs text-slate-500">Protected demo workspace</p></div></div>
      <label className="block text-xs font-semibold text-slate-700">Email<Input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required className="mt-2 border-slate-200 bg-slate-50" /></label>
      <label className="mt-4 block text-xs font-semibold text-slate-700">Password<Input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" required className="mt-2 border-slate-200 bg-slate-50" /></label>
      {error && <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p>}
      <Button type="submit" disabled={busy} className="mt-6 w-full bg-cyan-600 text-white hover:bg-cyan-700">{busy ? <LoaderCircle className="mr-2 size-4 animate-spin" /> : <LockKeyhole className="mr-2 size-4" />}{busy ? "Signing in..." : "Sign in"}</Button>
    </form>
  </main>;
}
