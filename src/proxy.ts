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
    "/((?!login|api/auth|api/countdown|_next/static|_next/image|favicon.ico).*)",
  ],
};
