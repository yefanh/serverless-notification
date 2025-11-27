import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { logger } from "../../packages/libs/logger";
import {
  Channel,
  NotificationEvent,
  RankedMessage,
  toCanonicalEvent,
} from "../../packages/schemas/notifications";

const region = process.env.AWS_REGION || "us-east-1";
const priorityQueueUrl = process.env.PRIORITY_QUEUE_URL;

// Gemini config
const geminiApiKey = process.env.GEMINI_API_KEY;
// Use gemini-2.5-pro as it provides high intelligence and is currently available.
// (gemini-3-pro-preview may hit quota limits on free tier).
const geminiModelName = process.env.GEMINI_MODEL || "gemini-2.5-pro";

// SQS client used to send ranked messages to the priority queue.
const sqs = new SQSClient({ region });

// Gemini client; only instantiated when an API key is present.
const genAI = geminiApiKey ? new GoogleGenerativeAI(geminiApiKey) : null;

/**
 * Choose a delivery channel for this notification.
 * For now we use the first declared user channel; default to email if missing.
 */
export function pickChannel(event: NotificationEvent): Channel {
  const preferred = event.user.channels?.[0];
  if (preferred === "email" || preferred === "sms" || preferred === "push" || preferred === "webhook") {
    return preferred;
  }
  return "email";
}

/**
 * Simple local fallback scoring that does not depend on any external LLM.
 * Useful for local debugging or when GEMINI_API_KEY is not configured.
 */
export function fallbackScore(event: NotificationEvent): {
  score: number;
  priority: number;
  sendAfter?: string;
} {
  const text = `${event.content.title} ${event.content.body}`.toLowerCase();
  let score = 0.5;

  if (text.includes("urgent") || text.includes("critical")) score += 0.3;
  if (text.includes("error") || text.includes("incident")) score += 0.2;

  score = Math.min(1, Math.max(0, score));
  // Lower priority number means more urgent, e.g., 1 = highest, 10 = lowest.
  const priority = score > 0.8 ? 1 : score > 0.6 ? 3 : 5;

  return { score, priority, sendAfter: undefined };
}

/**
 * Score and prioritize the notification using Gemini.
 * - Input: normalized NotificationEvent
 * - Output: score (0-1), priority (1-10), optional sendAfter (ISO timestamp)
 */
export async function scoreWithLLM(event: NotificationEvent): Promise<{
  score: number;
  priority: number;
  sendAfter?: string;
}> {
  if (!genAI) {
    logger.warn("GEMINI_API_KEY not set, using fallback scoring", {
      eventId: event.eventId,
    });
    return fallbackScore(event);
  }

  const model = genAI.getGenerativeModel({ model: geminiModelName });

  const prompt = `
Notification event:
- eventId: ${event.eventId}
- source: ${event.source}
- userId: ${event.user.id}
- segment: ${event.user.segment ?? "unknown"}
- channels: ${event.user.channels.join(", ") || "none"}

Content:
Title: ${event.content.title}
Body: ${event.content.body}

Rules:
- Higher score/priority for time-sensitive, critical, or error/incident messages.
- Lower priority for marketing or non-urgent updates.
- If message can wait (e.g. marketing), you MAY set sendAfter to a future time (e.g. in 1-3 hours). Otherwise use null.

Respond with JSON only, e.g.:
{"score":0.92,"priority":1,"sendAfter":null}
`;

  const MAX_RETRIES = 3;
  // Increase base delay to 10 seconds to handle strict Gemini 3 limits (often requires ~20s wait)
  const BASE_DELAY_MS = 10000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();
      // Remove markdown code blocks if present
      if (text.startsWith("```")) {
        text = text.replace(/^```(json)?\s*/, "").replace(/\s*```$/, "");
      }
      logger.debug("Gemini raw response", { eventId: event.eventId, raw: text });

      const parsed = JSON.parse(text) as {
        score: number;
        priority: number;
        sendAfter?: string | null;
      };

      const score = typeof parsed.score === "number" ? parsed.score : 0.5;
      const priority = typeof parsed.priority === "number" ? parsed.priority : 5;
      const sendAfter =
        parsed.sendAfter && typeof parsed.sendAfter === "string" ? parsed.sendAfter : undefined;

      return { score, priority, sendAfter };
    } catch (err: any) {
      const message = err?.message || "";
      const isRateLimit = message.includes("429") || message.includes("Quota exceeded") || message.includes("Too Many Requests");
      
      if (isRateLimit && attempt < MAX_RETRIES) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1); // 2s, 4s, 8s...
        logger.warn(`Gemini rate limit hit, retrying in ${delay}ms...`, { eventId: event.eventId, attempt });
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      logger.error("Gemini scoring failed, falling back", {
        eventId: event.eventId,
        error: message,
        attempt,
      });
      return fallbackScore(event);
    }
  }
  return fallbackScore(event);
}

/**
 * Send the ranked message to the priority SQS queue.
 * Debugging tip: you can call this function from a local script with a mock RankedMessage.
 */
async function sendToPriorityQueue(message: RankedMessage) {
  if (!priorityQueueUrl) {
    throw new Error("PRIORITY_QUEUE_URL env var not set");
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: priorityQueueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        eventId: { DataType: "String", StringValue: message.eventId },
        userId: { DataType: "String", StringValue: message.userId },
        priority: { DataType: "Number", StringValue: String(message.priority) },
      },
    }),
  );
}

/**
 * Ranking Lambda entry point:
 * - Read events from the incoming queue
 * - Normalize into NotificationEvent
 * - Score and prioritize using LLM (with fallback)
 * - Send to the priority queue for dispatch Lambdas to consume
 */
export const handler = async (event: any) => {
  const records = Array.isArray(event?.Records) ? event.Records : [event];

  for (const record of records) {
    const body = record?.body ? JSON.parse(record.body) : record;
    const notification = toCanonicalEvent(body) as NotificationEvent;

    const ranking = await scoreWithLLM(notification);
    const rankedMessage: RankedMessage = {
      eventId: notification.eventId,
      userId: notification.user.id,
      channel: pickChannel(notification),
      priority: ranking.priority,
      score: ranking.score,
      sendAfter: ranking.sendAfter,
      content: notification.content,
      preferences: {
        rateLimitKey: `user:${notification.user.id}`,
      },
      source: notification.source,
    };

    await sendToPriorityQueue(rankedMessage);
  }

  logger.info("Ranking complete", { count: records.length });
  return { processed: records.length };
};

