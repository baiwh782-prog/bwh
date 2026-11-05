import { previewPathPrefix } from "@/lib/preview-path-prefix";
import type { Tone } from "@/lib/chat-store";

export type OutMessage = {
  role: "user" | "assistant";
  content: string;
};

function endpoint(): string {
  if (typeof window === "undefined") return "/api/chat";
  const prefix = previewPathPrefix(window.location.hostname, window.location.pathname);
  return `${prefix ?? ""}/api/chat`;
}

export async function streamChat(
  input: { tone: Tone; messages: OutMessage[] },
  signal: AbortSignal,
  onDelta: (delta: string) => void,
): Promise<void> {
  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });

  const contentType = res.headers.get("content-type") ?? "";
  if (!res.ok || !contentType.includes("text/event-stream") || !res.body) {
    let message = "发送失败，请再试一次。";
    try {
      const data = (await res.json()) as { error?: string };
      if (data.error) message = data.error;
    } catch {
      /* body wasn't json */
    }
    throw new Error(message);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.startsWith("data:"));
      if (!line) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") return;
      let payload: { delta?: string; error?: string };
      try {
        payload = JSON.parse(data) as { delta?: string; error?: string };
      } catch {
        continue;
      }
      if (payload.error) throw new Error(payload.error);
      if (payload.delta) onDelta(payload.delta);
    }
  }
}
