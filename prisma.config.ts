import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Vercel+Neon sets DATABASE_URL (pooled) and DATABASE_URL_UNPOOLED (direct).
    // Prisma migrations need the direct (non-pooled) URL; runtime uses the pooled one.
    url: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL,
  },
});
