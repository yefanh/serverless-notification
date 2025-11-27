import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import OpenAI from "openai";
import { logger } from "../../packages/libs/logger";
import {
  Channel,
  NotificationEvent,
  RankedMessage,
  toCanonicalEvent,
} from "../../packages/schemas/notifications";

const region = process.env.AWS_REGION || "us-east-1";
const priorityQueueUrl = process.env.PRIORITY_QUEUE_URL;
const openaiApiKey = process.env.OPENAI_API_KEY;
const openaiModel = process.env.OPENAI_MODEL || "gpt-4o-mini";

// SQS client used to send ranked messages to the priority queue.
const sqs = new SQSClient({ region });

// OpenAI client; only used when OPENAI_API_KEY is configured.
const openai = new OpenAI({
  apiKey: openaiApiKey,
});

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
 * Simple local fallback scoring that does not depend on OpenAI.
 * Useful for local debugging or when OPENAI_API_KEY is not configured.
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
 * Score and prioritize the notification using OpenAI.
 * - Input: normalized NotificationEvent
 * - Output: score (0-1), priority (1-10), optional sendAfter (ISO timestamp)
 *
 * Debugging tips:
 * - First run without OPENAI_API_KEY to verify fallbackScore behavior.
 * - After configuring OPENAI_API_KEY, temporarily log the raw OpenAI response if needed.
 */
export async function scoreWithLLM(event: NotificationEvent): Promise<{
  score: number;
  priority: number;
  sendAfter?: string;
}> {
  if (!openaiApiKey) {
    logger.warn("OPENAI_API_KEY not set, using fallback scoring", {
      eventId: event.eventId,
    });
    return fallbackScore(event);
  }

  const systemPrompt =
    "You are a notification ranking engine. Return ONLY valid JSON with fields: score (0-1), priority (1-10, 1=highest), sendAfter (ISO string or null). No explanation.";

  const userPrompt = `
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

  try {
    const completion = await openai.chat.completions.create({
      model: openaiModel,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      temperature: 0.1,
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "";
    logger.debug("LLM raw response", { eventId: event.eventId, raw });

    const parsed = JSON.parse(raw) as {
      score: number;
      priority: number;
      sendAfter?: string | null;
    };

    const score = typeof parsed.score === "number" ? parsed.score : 0.5;
    const priority = typeof parsed.priority === "number" ? parsed.priority : 5;
    const sendAfter =
      parsed.sendAfter && typeof parsed.sendAfter === "string" ? parsed.sendAfter : undefined;

    return { score, priority, sendAfter };
  } catch (err) {
    logger.error("LLM scoring failed, falling back", {
      eventId: event.eventId,
      error: (err as Error)?.message,
    });
    return fallbackScore(event);
  }
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
