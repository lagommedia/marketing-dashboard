import { withAuth } from "next-auth/middleware";

export default withAuth({
  pages: {
    signIn: "/login",
  },
});

export const config = {
  matcher: [
    // api/countdown is public: it serves a countdown GIF to email clients,
    // which send no cookies — behind auth it would redirect and break the image.
    // api/agent is the read-only agent surface: it carries its own bearer-token
    // check (src/lib/agent-auth.ts) and must not redirect to the login page.
    "/((?!login|api/auth|api/countdown|api/agent|_next/static|_next/image|favicon.ico).*)",
  ],
};
