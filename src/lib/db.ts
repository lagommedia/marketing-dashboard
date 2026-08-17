import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";

function createPrismaClient() {
  const url       = process.env.DATABASE_URL ?? "file:./prisma/dev.db";
  const authToken = process.env.TURSO_AUTH_TOKEN;

  // Local SQLite file — no auth token needed
  const fileUrl = url.startsWith("file:") || url.startsWith("/") || url.startsWith(".")
    ? (url.startsWith("file:") ? url : `file:${url}`)
    : url; // libsql:// or https:// passed through as-is

  const adapter = new PrismaLibSql({
    url: fileUrl,
    ...(authToken ? { authToken } : {}),
  });

  return new PrismaClient({
    adapter,
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
