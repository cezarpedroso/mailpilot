import { auth } from "@/auth";

export default auth((request) => {
  const developmentOpen = process.env.NODE_ENV !== "production" && !process.env.MAILPILOT_DEMO_EMAIL && !process.env.MAILPILOT_DEMO_PASSWORD;
  if (developmentOpen) return;
  const signedIn = Boolean(request.auth?.user);
  const path = request.nextUrl.pathname;
  if (path === "/login") return signedIn ? Response.redirect(new URL("/", request.nextUrl)) : undefined;
  return signedIn ? undefined : Response.redirect(new URL("/login", request.nextUrl));
});

export const config = { matcher: ["/((?!api/auth|_next/static|_next/image|favicon.ico|icon.svg).*)"] };
