# Architecture & Workflows

## Components
- **API Gateway (optional)**: HTTP ingestion for first-party events.
- **S3 bucket**: Event drops trigger ingestion Lambda for batch/bulk sources.
- **Ingestion Lambda**: Normalizes events, validates schema, writes to `incoming` SQS queue.
- **DynamoDB (preferences)**: User/channel preferences, quiet hours, rate limits, failover channels.
- **Ranking Lambda**: Pulls from `incoming`, enriches with preferences/segment data, calls OpenAI for scoring, writes to `priority` queue.
- **Dispatch Lambdas**: Channel-specific consumers (email/SMS/push/webhook). Apply per-channel rate limiting and exponential backoff; write to DLQ on exhaustion.
- **DLQs**: One per queue/critical Lambda to capture poison messages.
- **CloudWatch**: Metrics, dashboards, alerts on DLQ depth, latency, and error rates.

## Event flow
1) **Source**: Events arrive via API Gateway or land in S3.
2) **Ingestion Lambda**: S3 trigger or HTTP handler validates payload -> canonical notification envelope -> `incoming` SQS.
3) **Ranking Lambda**: Consumes `incoming`, fetches preferences/segments (DynamoDB), builds prompt, calls OpenAI, assigns priority + scheduled send time -> pushes to `priority` SQS with attributes.
4) **Dispatch Lambdas**: Poll `priority` queue, respect scheduled time/rate limits, send via provider SDKs. On failure, apply exponential backoff; final failure -> DLQ.

## Data contracts (draft)
- **Incoming event (canonical)**:
  - `eventId`, `source`, `occurredAt`
  - `user` { `id`, `segment`, `channels`[] }
  - `content` { `title`, `body`, `cta`?, `metadata` }
- **Ranked message**:
  - `priority` (int), `sendAfter` (timestamp), `scoreBreakdown`
  - `channel` (`email|sms|push|webhook`)
  - `delivery` { `address`, `provider`?, `rateLimitKey` }

## Reliability controls
- **Rate limiting**: Token bucket per `channel:tenant` key stored in DynamoDB; dispatch checks/updates atomically.
- **Backoff**: Exponential with jitter (e.g., base 2^n * 100ms, cap 30s); store attempt count in SQS message attributes.
- **DLQs**: Configure `maxReceiveCount` on source queues; alarms on DLQ depth.
- **Idempotency**: Use `eventId` as idempotency key (DynamoDB item or SQS dedup for FIFO).
- **Observability**: Structured logs per stage (`eventId`, `userId`, `channel`, `priority`, `latencyMs`), metrics on end-to-end latency and error counts.

## Security & configuration
- Secrets (OpenAI API key) in AWS Secrets Manager or env vars via Lambda configuration.
- Principle of least privilege IAM roles per Lambda.
- Validation: JSON schema for incoming events to prevent malformed payloads.

## Phase plan (what we'll build)
- **Phase 1**: Repo scaffold + shared schemas/utilities.
- **Phase 2**: Ingestion path (S3 trigger -> `incoming` SQS with DLQ).
- **Phase 3**: Ranking Lambda with OpenAI integration (stubbed locally, real call configurable).
- **Phase 4**: Dispatchers with rate limiting/backoff and DLQ wiring.
- **Phase 5**: IaC + local test harness (e.g., Serverless offline or SAM) + dashboards.
