import type { LiveConnection } from "./config";

type StreamFrame = { id: string | null; type: string; data: unknown };

/** Retry delay after the stream drops; the polling fallback keeps the UI usable meanwhile. */
const RETRY_MS = 3_000;
const MAX_RETRY_MS = 30_000;

/**
 * Follow the scheduler's SSE notification stream.
 *
 * The stream is only a hint that something changed; the snapshot endpoints stay the source of
 * truth. A fetch-based reader is used instead of EventSource because the scheduler names every
 * frame with `event: <type>`, and EventSource dispatches named frames only to listeners registered
 * for that exact name — a reader that treats every frame the same needs no event-type catalog.
 *
 * Reconnects resume from the last event id, so a short drop does not lose notifications.
 */
export function followSchedulerEvents(
  connection: LiveConnection,
  onEvent: (frame: StreamFrame) => void,
  onState: (state: "open" | "closed") => void,
): () => void {
  let stopped = false;
  let lastId: string | null = null;
  let controller: AbortController | null = null;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const handleFrame = (raw: string) => {
    let id: string | null = null;
    let type = "message";
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith("id:")) id = line.slice(3).trim();
      else if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    // Frames without data are comments or pings, which only keep the connection alive.
    if (!data.length) return;
    if (id) lastId = id;
    let parsed: unknown = data.join("\n");
    try {
      parsed = JSON.parse(String(parsed));
    } catch {
      // Keep the raw text; callers only need the notification itself.
    }
    onEvent({ id, type, data: parsed });
  };

  const run = async () => {
    let retry = RETRY_MS;
    while (!stopped) {
      controller = new AbortController();
      try {
        const res = await fetch(`${connection.schedulerUrl}/v1/events/stream`, {
          headers: {
            accept: "text/event-stream",
            ...(lastId ? { "last-event-id": lastId } : {}),
          },
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(`stream HTTP ${res.status}`);
        onState("open");
        retry = RETRY_MS;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let cut = buffer.indexOf("\n\n");
          while (cut >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            handleFrame(frame);
            cut = buffer.indexOf("\n\n");
          }
        }
      } catch {
        // Dropped or refused: reconnect below. The polling fallback covers the gap meanwhile.
      }
      if (stopped) break;
      onState("closed");
      await sleep(retry);
      retry = Math.min(retry * 2, MAX_RETRY_MS);
    }
  };

  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
