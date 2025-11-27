import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { logger } from "../../packages/libs/logger";
import { NotificationEvent, toCanonicalEvent } from "../../packages/schemas/notifications";

const region = process.env.AWS_REGION || "us-east-1";
const incomingQueueUrl = process.env.INCOMING_QUEUE_URL;

const s3 = new S3Client({ region });
const sqs = new SQSClient({ region });

async function streamToString(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function loadFromS3Record(record: any): Promise<unknown[]> {
  const bucket = record?.s3?.bucket?.name;
  const key = decodeURIComponent(record?.s3?.object?.key || "");
  if (!bucket || !key) return [];

  const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const body = response.Body ? await streamToString(response.Body as any) : "";
  const parsed = body ? JSON.parse(body) : {};
  return Array.isArray(parsed) ? parsed : [parsed];
}

function loadFromGenericRecord(record: any): unknown[] {
  if (record?.body) {
    const parsed = JSON.parse(record.body);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  return [record];
}

async function collectEvents(event: any): Promise<unknown[]> {
  if (Array.isArray(event?.Records) && event.Records[0]?.s3?.object) {
    const batches = await Promise.all(event.Records.map(loadFromS3Record));
    return batches.flat();
  }

  if (Array.isArray(event?.Records)) {
    return event.Records.flatMap(loadFromGenericRecord);
  }

  if (event?.body) {
    const parsed = JSON.parse(event.body);
    return Array.isArray(parsed) ? parsed : [parsed];
  }

  return [event];
}

async function enqueueIncoming(message: NotificationEvent) {
  if (!incomingQueueUrl) {
    throw new Error("INCOMING_QUEUE_URL env var not set");
  }

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: incomingQueueUrl,
      MessageBody: JSON.stringify(message),
      MessageAttributes: {
        eventId: { DataType: "String", StringValue: message.eventId },
        userId: { DataType: "String", StringValue: message.user.id },
      },
    }),
  );
}

export const handler = async (event: any) => {
  const rawEvents = await collectEvents(event);

  const normalized: NotificationEvent[] = rawEvents.map((record) => toCanonicalEvent(record));
  logger.info("Ingestion: normalized events", { count: normalized.length });

  for (const record of normalized) {
    await enqueueIncoming(record);
  }

  logger.info("Ingestion enqueued to SQS", { count: normalized.length });
  return {
    statusCode: 200,
    body: JSON.stringify({ accepted: normalized.length }),
  };
};
