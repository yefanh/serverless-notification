# Infrastructure (scaffold)

- **Queues**: `incoming` (ingestion -> ranking), `priority` (ranking -> dispatch), DLQs for each.
- **Lambdas**: ingestion (S3/API), ranking (OpenAI scoring), dispatchers (channel-specific).
- **Data**: DynamoDB table for preferences/rate limits; S3 bucket for event drops.
- **APIs**: API Gateway endpoint for direct ingestion (optional).
- **Observability**: CloudWatch alarms on DLQ depth, latency, and error rates.

## Environment variables (ingestion)
- `AWS_REGION`
- `INCOMING_QUEUE_URL` (SQS queue used by ingestion Lambda; pair with `incoming-dlq` via redrive policy)

## Environment variables (ranking)
- `AWS_REGION`
- `PRIORITY_QUEUE_URL` (SQS queue used by ranking Lambda; pair with `priority-dlq`)
- `OPENAI_API_KEY` (for LLM-based scoring; if unset, fallback heuristic scoring is used)
- `OPENAI_MODEL` (optional, default `gpt-4o-mini`)

## Environment variables (dispatch)
- `AWS_REGION`
- `PRIORITY_QUEUE_URL` (same priority queue that dispatch Lambdas consume from)
- `PREFERENCES_TABLE_NAME` (DynamoDB table for user preferences and rate-limit state)

## DynamoDB schema (preferences / rate limiting)
- Partition key: `pk` (string)
- Sort key: `sk` (string)
- Rate limit items:
  - `pk = "rate:{rateLimitKey}"`
  - `sk = "rate-limit"`
  - attributes:
    - `windowStart` (number, epoch millis for current window)
    - `count` (number, sends within current window)

## Wiring notes
- S3 bucket triggers ingestion Lambda on `ObjectCreated:*`.
- API Gateway -> ingestion Lambda for HTTP events.
- Ingestion Lambda -> `incoming` SQS (with DLQ).
- SQS `incoming` -> ranking Lambda.
- Ranking Lambda -> `priority` SQS (with DLQ).
- `priority` SQS -> dispatch Lambdas (channel-specific) -> provider SDKs.

Next: add IaC (Serverless/SAM/Terraform) definitions and wiring for triggers, IAM, and environment variables.
