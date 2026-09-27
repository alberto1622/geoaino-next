import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import { PrismaAdapter } from "@auth/prisma-adapter";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import { compare } from "bcryptjs";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/rate-limit";

/** Tentatives de connexion : 5 par compte et 20 par IP sur 15 minutes. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_LIMIT_PER_EMAIL = 5;
const LOGIN_LIMIT_PER_IP = 20;

/** Erreur lue par la page de connexion (`result.code === "rate_limited"`). */
class RateLimitedSignin extends CredentialsSignin {
  code = "rate_limited";
}

const config: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/login" },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, request) {
        const email = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!email || !password) return null;

        // Anti force brute : chaque tentative compte ; un succès remet le compteur
        // du compte à zéro (celui de l'IP expire seul).
        const emailKey = `login:email:${email.trim().toLowerCase()}`;
        const ipOk = rateLimit(`login:ip:${clientIp(request.headers)}`, LOGIN_LIMIT_PER_IP, LOGIN_WINDOW_MS).allowed;
        const emailOk = rateLimit(emailKey, LOGIN_LIMIT_PER_EMAIL, LOGIN_WINDOW_MS).allowed;
        if (!ipOk || !emailOk) throw new RateLimitedSignin();

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.password) return null;

        const valid = await compare(password, user.password);
        if (!valid) return null;
        resetRateLimit(emailKey);

        await prisma.user.update({
          where: { id: user.id },
          data: { lastSignedIn: new Date() },
        });

        return { id: user.id, email: user.email, name: user.name, role: user.role };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.id = user.id;
        token.role = (user as { role?: string }).role;
      }
      return token;
    },
    async session({ session, token }) {
      if (token && session.user) {
        (session.user as { id?: string }).id = token.id as string;
        (session.user as { role?: string }).role = token.role as string;
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(config);
