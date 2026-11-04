import express, { type ErrorRequestHandler } from "express";

type Mail = { id: string; subject: string };
export type FlagMessage = (messageId: string) => Promise<void>;

class InvalidNotification extends Error {}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNotification(payload: unknown): Mail[] {
  const messages = record(payload) && record(payload.body) ? payload.body.value : null;
  if (!Array.isArray(messages) || messages.length > 100) {
    throw new InvalidNotification();
  }
  const result: Mail[] = [];
  for (const message of messages) {
    if (!record(message) || typeof message.id !== "string" ||
        !message.id.trim() || message.id.length > 2048 ||
        typeof message.subject !== "string" || message.subject.length > 1024) {
      throw new InvalidNotification();
    }
    result.push({ id: message.id, subject: message.subject });
  }
  return result;
}

export function createApp(flag: FlagMessage, prefix: string) {
  if (!/^\[builder-connector-[A-Za-z0-9-]+\]$/.test(prefix)) {
    throw new Error("TEST_SUBJECT_PREFIX must be a unique [builder-connector-<run>] prefix.");
  }
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", (_request, response) => {
    response.json({ status: "healthy" });
  });
  app.post("/api/webhook", async (request, response) => {
    // Validate the entire batch before performing the first mailbox operation.
    const messages = parseNotification(request.body);
    let flagged = 0;
    for (const message of messages) {
      if (message.subject.startsWith(prefix)) {
        await flag(message.id);
        flagged++;
      }
    }
    const counts = { received: messages.length, flagged };
    console.info(JSON.stringify({ event: "notification_processed", ...counts }));
    response.json(counts);
  });
  const errors: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
    const bodyError = record(error) ? error.type : undefined;
    const invalid = error instanceof InvalidNotification || bodyError === "entity.parse.failed";
    const status = invalid ? 400 : bodyError === "entity.too.large" ? 413 : 502;
    console.error(JSON.stringify({ event: "notification_failed", status }));
    response.status(status).json({
      error: status === 400 ? "Invalid notification" :
        status === 413 ? "Notification too large" : "Flag operation failed",
    });
  };
  app.use(errors);
  return app;
}
