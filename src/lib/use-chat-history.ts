"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * localStorage-backed chat persistence, shared by the agent chat surfaces.
 *
 * Two things are stored per namespace:
 *   <ns>-chat-history   the conversation currently on screen
 *   <ns>-chat-sessions  previous conversations, newest first, capped
 *
 * Storage is per-browser: it survives closing the panel and reloading the
 * page, but does not follow the user to another machine. Every read and write
 * is wrapped — Safari private mode and blocked site data both throw on access,
 * and a chat panel should never crash over saved history.
 */

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ChatSession {
  id: string;
  startedAt: string;
  title: string;
  messages: ChatMessage[];
}

const MAX_SESSIONS = 20;

function read<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota, private mode, blocked site data — history is best-effort */
  }
}

function remove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

export function useChatHistory(namespace: string) {
  const activeKey = `${namespace}-chat-history`;
  const sessionsKey = `${namespace}-chat-sessions`;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // Hydrate after mount, never during render: the server has no localStorage,
  // so reading it inline would produce a hydration mismatch.
  useEffect(() => {
    setMessages(read<ChatMessage[]>(activeKey, []));
    setSessions(read<ChatSession[]>(sessionsKey, []));
    setHydrated(true);
  }, [activeKey, sessionsKey]);

  // Persist the live conversation as it changes (but not the empty state we
  // start with before hydration, which would wipe what is saved).
  useEffect(() => {
    if (!hydrated) return;
    if (messages.length > 0) write(activeKey, messages);
    else remove(activeKey);
  }, [messages, hydrated, activeKey]);

  const persistSessions = useCallback(
    (next: ChatSession[]) => {
      setSessions(next);
      write(sessionsKey, next);
    },
    [sessionsKey]
  );

  /** Files the current conversation into history and clears the panel. */
  const archiveAndClear = useCallback(() => {
    setMessages((current) => {
      if (current.length === 0) return current;
      const firstUser = current.find((m) => m.role === "user");
      const session: ChatSession = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: new Date().toISOString(),
        title: firstUser ? firstUser.content.slice(0, 80) : "Conversation",
        messages: current,
      };
      setSessions((prev) => {
        const next = [session, ...prev].slice(0, MAX_SESSIONS);
        write(sessionsKey, next);
        return next;
      });
      return [];
    });
    remove(activeKey);
  }, [activeKey, sessionsKey]);

  /** Reopens an archived conversation, filing the current one first. */
  const restoreSession = useCallback(
    (session: ChatSession) => {
      setMessages((current) => {
        if (current.length > 0) {
          const firstUser = current.find((m) => m.role === "user");
          const archived: ChatSession = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            startedAt: new Date().toISOString(),
            title: firstUser ? firstUser.content.slice(0, 80) : "Conversation",
            messages: current,
          };
          setSessions((prev) => {
            const next = [archived, ...prev.filter((s) => s.id !== session.id)].slice(0, MAX_SESSIONS);
            write(sessionsKey, next);
            return next;
          });
        } else {
          setSessions((prev) => {
            const next = prev.filter((s) => s.id !== session.id);
            write(sessionsKey, next);
            return next;
          });
        }
        return session.messages;
      });
      write(activeKey, session.messages);
    },
    [activeKey, sessionsKey]
  );

  const deleteSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        write(sessionsKey, next);
        return next;
      });
    },
    [sessionsKey]
  );

  /** Drops everything: the live conversation and all archived ones. */
  const clearAll = useCallback(() => {
    setMessages([]);
    persistSessions([]);
    remove(activeKey);
  }, [activeKey, persistSessions]);

  return {
    messages,
    setMessages,
    sessions,
    hydrated,
    archiveAndClear,
    restoreSession,
    deleteSession,
    clearAll,
  };
}

/** "2h ago" / "Mar 3" — compact enough for a history row. */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
