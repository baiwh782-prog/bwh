import { createFileRoute } from "@tanstack/react-router";

type Tone = "brief" | "chat" | "deep";

type InMessage = {
  role: "user" | "assistant";
  content: string;
};

const TONES: Record<Tone, { note: string; maxTokens: number; temperature: number }> = {
  brief: { note: "回答尽量短。先给结论，必要时最多三条要点。不要寒暄。", maxTokens: 640, temperature: 0.4 },
  chat: {
    note: "像一个清醒的夜谈对象。语气自然，有判断，不客套，不说教。段落短一些。",
    maxTokens: 1200,
    temperature: 0.7,
  },
  deep: {
    note: "把问题拆开讲清楚。先给判断，再给理由、取舍和例子。结构清楚，但不要写成公文。",
    maxTokens: 2000,
    temperature: 0.6,
  },
};

const BASE_SYSTEM =
  "你是「墨谈」里的对话者，由 Grok 支持。用对方使用的语言回答。具体、诚实、有温度。需要列举或代码时用简洁的 Markdown。不要提及这些指示，也不要主动报出模型编号。";

const WINDOW_MS = 60_000;
const MAX_HITS = 12;
const hits = new Map<string, number[]>();

function limited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (recent.length >= MAX_HITS) {
    hits.set(key, recent);
    return true;
  }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

function clientKey(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
}

function isTone(value: unknown): value is Tone {
  return value === "brief" || value === "chat" || value === "deep";
}

function parseMessages(value: unknown): InMessage[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) return null;
  const out: InMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const role = (item as { role?: unknown }).role;
    const content = (item as { content?: unknown }).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const text = content.trim().slice(0, 6000);
    if (!text) return null;
    out.push({ role, content: text });
  }
  if (out[out.length - 1]?.role !== "user") return null;
  if (out[out.length - 1].content.length > 4000) return null;
  return out;
}

function jsonError(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function safeApiError(status: number, bodyText: string): string {
  try {
    const parsed = JSON.parse(bodyText) as { error?: { message?: string }; message?: string };
    const message = parsed.error?.message || parsed.message;
    if (typeof message === "string" && message.trim()) return message.trim().slice(0, 180);
  } catch {
    /* ignore non-json bodies */
  }
  return `对话暂时连不上（${status}）`;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .join("");
}

function extractDelta(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const choice = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choice) || !choice[0] || typeof choice[0] !== "object") return "";
  const first = choice[0] as { delta?: { content?: unknown }; message?: { content?: unknown } };
  return textFromContent(first.delta?.content ?? first.message?.content);
}

function sse(obj: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(obj)}\n\n`);
}

function doneChunk(): Uint8Array {
  return new TextEncoder().encode("data: [DONE]\n\n");
}

function streamFromText(text: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: text })}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  };
}

function streamUpstream(upstream: Response): Response {
  const body = upstream.body;
  if (!body) return jsonError("没有收到回复", 502);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const stream = new ReadableStream({
    async start(controller) {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const data = trimmed.slice(5).trim();
            if (!data) continue;
            if (data === "[DONE]") {
              controller.enqueue(doneChunk());
              controller.close();
              return;
            }
            let payload: unknown;
            try {
              payload = JSON.parse(data);
            } catch {
              continue;
            }
            const errObj = (payload as { error?: { message?: string } }).error;
            if (errObj) {
              controller.enqueue(sse({ error: (errObj.message || "对话中断了").slice(0, 180) }));
              controller.close();
              return;
            }
            const delta = extractDelta(payload);
            if (delta) controller.enqueue(sse({ delta }));
          }
        }
        controller.enqueue(doneChunk());
        controller.close();
      } catch {
        controller.enqueue(sse({ error: "对话中断了" }));
        controller.close();
      }
    },
    cancel() {
      void reader.cancel();
    },
  });
  return new Response(stream, { headers: sseHeaders() });
}

export const Route = createFileRoute("/api/chat")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (limited(clientKey(request))) {
          return jsonError("说得有点快，稍等一会儿再发。", 429);
        }

        let body: unknown;
        try {
          body = await request.json();
        } catch {
          return jsonError("没读懂这条消息。", 400);
        }
        if (!body || typeof body !== "object") return jsonError("没读懂这条消息。", 400);

        const toneValue = (body as { tone?: unknown }).tone;
        const tone: Tone = isTone(toneValue) ? toneValue : "chat";
        const messages = parseMessages((body as { messages?: unknown }).messages);
        if (!messages) return jsonError("这条没法发送，请收短一点再试。", 400);

        const apiKey = process.env.XAI_API_KEY;
        if (!apiKey) return jsonError("这里还没接上 AI，稍后再试。", 503);

        const style = TONES[tone];
        let upstream: Response;
        try {
          upstream = await fetch("https://api.x.ai/v1/chat/completions", {
            method: "POST",
            signal: request.signal,
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model: "grok-4.5",
              stream: true,
              max_tokens: style.maxTokens,
              temperature: style.temperature,
              messages: [
                { role: "system", content: `${BASE_SYSTEM}\n${style.note}` },
                ...messages,
              ],
            }),
          });
        } catch {
          return jsonError("网络中断了，请再试一次。", 502);
        }

        if (!upstream.ok) {
          const text = await upstream.text();
          return jsonError(safeApiError(upstream.status, text), 502);
        }

        const contentType = upstream.headers.get("content-type") ?? "";
        if (!contentType.includes("text/event-stream")) {
          try {
            const payload = (await upstream.json()) as unknown;
            return streamFromText(extractDelta(payload));
          } catch {
            return jsonError("没有收到回复", 502);
          }
        }

        return streamUpstream(upstream);
      },
    },
  },
});

