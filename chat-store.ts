import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export type Tone = "brief" | "chat" | "deep";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  status?: "streaming" | "error" | "done" | "stopped";
};

export type Thread = {
  id: string;
  title: string;
  tone: Tone;
  messages: ChatMessage[];
  updatedAt: number;
};

type Persisted = {
  threads: Thread[];
  activeId: string | null;
};

type ChatState = Persisted & {
  newThread: () => string;
  setActive: (id: string) => void;
  setTone: (tone: Tone) => void;
  removeThread: (id: string) => void;
  commitExchange: (threadId: string, messages: ChatMessage[], title?: string) => void;
  patchMessage: (threadId: string, messageId: string, patch: Partial<ChatMessage>) => void;
  dropMessage: (threadId: string, messageId: string) => void;
};

function uid(): string {
  return crypto.randomUUID();
}

function titleFrom(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return "未命名";
  return clean.length > 18 ? `${clean.slice(0, 18)}…` : clean;
}

function touch(thread: Thread, patch: Partial<Thread>): Thread {
  return { ...thread, ...patch, updatedAt: Date.now() };
}

export const useChatStore = create<ChatState>()(
  persist(
    (set, get) => ({
      threads: [],
      activeId: null,
      newThread: () => {
        const blank = get().threads.find((t) => t.messages.length === 0);
        if (blank) {
          set({ activeId: blank.id });
          return blank.id;
        }
        const id = uid();
        const thread: Thread = {
          id,
          title: "未命名",
          tone: "chat",
          messages: [],
          updatedAt: Date.now(),
        };
        set({
          threads: [thread, ...get().threads],
          activeId: id,
        });
        return id;
      },
      setActive: (id) => set({ activeId: id }),
      setTone: (tone) => {
        const { activeId, threads } = get();
        if (!activeId) return;
        set({
          threads: threads.map((t) => (t.id === activeId ? touch(t, { tone }) : t)),
        });
      },
      removeThread: (id) => {
        const threads = get().threads.filter((t) => t.id !== id);
        const activeId = get().activeId === id ? (threads[0]?.id ?? null) : get().activeId;
        set({ threads, activeId });
      },
      commitExchange: (threadId, messages, title) => {
        set({
          threads: get().threads.map((t) => {
            if (t.id !== threadId) return t;
            const nextTitle =
              title && (t.title === "未命名" || t.messages.length === 0) ? titleFrom(title) : t.title;
            return touch(t, {
              title: nextTitle,
              messages: [...t.messages, ...messages],
            });
          }),
        });
      },
      patchMessage: (threadId, messageId, patch) => {
        set({
          threads: get().threads.map((t) => {
            if (t.id !== threadId) return t;
            return touch(t, {
              messages: t.messages.map((m) => (m.id === messageId ? { ...m, ...patch } : m)),
            });
          }),
        });
      },
      dropMessage: (threadId, messageId) => {
        set({
          threads: get().threads.map((t) => {
            if (t.id !== threadId) return t;
            return touch(t, { messages: t.messages.filter((m) => m.id !== messageId) });
          }),
        });
      },
    }),
    {
      name: "motan-threads-v1",
      // localStorage 读取位置：Zustand 在 ChatApp 挂载后调用 persist.rehydrate()，从此键恢复全部对话。
      // localStorage 写入位置：Zustand persist 在 store 状态变化时自动序列化 threads 和 activeId。
      storage: createJSONStorage(() => localStorage),
      skipHydration: true,
      partialize: (s) => ({ threads: s.threads, activeId: s.activeId }),
    },
  ),
);

export function formatTimestamp(ts: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(ts));
}

export function formatWhen(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.round(diff / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.round(hr / 24);
  if (day === 1) return "昨天";
  if (day < 7) return `${day} 天前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
