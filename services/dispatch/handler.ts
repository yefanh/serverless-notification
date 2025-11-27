import { DynamoDBClient, GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { SQSClient, ChangeMessageVisibilityCommand } from "@aws-sdk/client-sqs";
import { logger } from "../../packages/libs/logger";
import { RankedMessage } from "../../packages/schemas/notifications";

const region = process.env.AWS_REGION || "us-east-1";
const preferencesTableName = process.env.PREFERENCES_TABLE_NAME;
const dispatchQueueUrl = process.env.PRIORITY_QUEUE_URL;

const dynamodb = new DynamoDBClient({ region });
const sqs = new SQSClient({ region });

interface RateLimitState {
  windowStart: number;
  count: number;
}

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_PER_WINDOW = 30;
const BASE_BACKOFF_MS = 200;
const MAX_BACKOFF_MS = 30_000;

async function loadPreferences(rateLimitKey?: string | null): Promise<RateLimitState | null> {
  if (!preferencesTableName || !rateLimitKey) return null;

  const resp = await dynamodb.send(
    new GetItemCommand({
      TableName: preferencesTableName,
      Key: { pk: { S: `rate:${rateLimitKey}` }, sk: { S: "rate-limit" } },
      ConsistentRead: true,
    }),
  );

  if (!resp.Item) return null;

  const windowStart = resp.Item.windowStart?.N ? Number(resp.Item.windowStart.N) : 0;
  const count = resp.Item.count?.N ? Number(resp.Item.count.N) : 0;
  return { windowStart, count };
}

async function updateRateLimitState(rateLimitKey: string, now: number, state: RateLimitState) {
  if (!preferencesTableName) return;

  await dynamodb.send(
    new UpdateItemCommand({
      TableName: preferencesTableName,
      Key: { pk: { S: `rate:${rateLimitKey}` }, sk: { S: "rate-limit" } },
      UpdateExpression: "SET windowStart = :windowStart, #count = :count",
      ExpressionAttributeNames: { "#count": "count" },
      ExpressionAttributeValues: {
        ":windowStart": { N: String(state.windowStart) },
        ":count": { N: String(state.count) },
      },
    }),
  );
}

async function withinRateLimit(message: RankedMessage): Promise<boolean> {
  const rateLimitKey = message.preferences?.rateLimitKey;
  if (!rateLimitKey) {
    return true;
  }

  const now = Date.now();
  let state = await loadPreferences(rateLimitKey);

  if (!state || now - state.windowStart > RATE_LIMIT_WINDOW_MS) {
    state = { windowStart: now, count: 0 };
  }

  if (state.count >= RATE_LIMIT_MAX_PER_WINDOW) {
    logger.warn("Rate limit exceeded", {
      rateLimitKey,
      windowStart: state.windowStart,
      count: state.count,
    });
    return false;
  }

  state.count += 1;
  await updateRateLimitState(rateLimitKey, now, state);

  logger.debug("Rate limit ok", {
    rateLimitKey,
    windowStart: state.windowStart,
    count: state.count,
  });
  return true;
}

async function sendThroughProvider(message: RankedMessage): Promise<void> {
  logger.info("Dispatching (placeholder provider)", {
    eventId: message.eventId,
    userId: message.userId,
    channel: message.channel,
    priority: message.priority,
  });
}

function computeBackoffDelayMs(receiveCount: number): number {
  const exp = 2 ** Math.min(receiveCount, 10);
  const delay = BASE_BACKOFF_MS * exp;
  return Math.min(delay, MAX_BACKOFF_MS);
}

async function applyBackoffIfPossible(record: any) {
  const receiptHandle = record.receiptHandle;
  const receiveCount = Number(record.attributes?.ApproximateReceiveCount || "1");

  if (!dispatchQueueUrl || !receiptHandle) {
    return;
  }

  const delayMs = computeBackoffDelayMs(receiveCount);

  await sqs.send(
    new ChangeMessageVisibilityCommand({
      QueueUrl: dispatchQueueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: Math.floor(delayMs / 1000),
    }),
  );

  logger.warn("Applied exponential backoff", {
    receiveCount,
    delayMs,
  });
}

export const handler = async (event: any) => {
  const records = Array.isArray(event?.Records) ? event.Records : [event];

  for (const record of records) {
    const body = record?.body ? JSON.parse(record.body) : record;
    const message = body as RankedMessage;

    if (message.sendAfter && Date.parse(message.sendAfter) > Date.now()) {
      logger.info("Skipping until sendAfter", {
        eventId: message.eventId,
        sendAfter: message.sendAfter,
      });
      continue;
    }

    const allowed = await withinRateLimit(message);
    if (!allowed) {
      await applyBackoffIfPossible(record);
      continue;
    }

    try {
      await sendThroughProvider(message);
    } catch (err) {
      logger.error("Dispatch failed", {
        eventId: message.eventId,
        error: (err as Error)?.message,
      });

      await applyBackoffIfPossible(record);
      throw err;
    }
  }

  return { dispatched: records.length };
};
