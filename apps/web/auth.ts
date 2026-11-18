import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";

const demoEmail = process.env.MAILPILOT_DEMO_EMAIL;
const demoPassword = process.env.MAILPILOT_DEMO_PASSWORD;

export const { handlers, auth } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 60 * 60 * 8 },
  pages: { signIn: "/login" },
  providers: [
    Credentials({
      name: "MailPilot demo",
      credentials: { email: { label: "Email", type: "email" }, password: { label: "Password", type: "password" } },
      async authorize(credentials) {
        if (!demoEmail || !demoPassword) return null;
        const email = typeof credentials?.email === "string" ? credentials.email.trim() : "";
        const password = typeof credentials?.password === "string" ? credentials.password : "";
        if (email !== demoEmail || password !== demoPassword) return null;
        return { id: "mailpilot-demo", email: demoEmail, name: "MailPilot demo" };
      },
    }),
  ],
});
