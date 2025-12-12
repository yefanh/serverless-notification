# Intelligent Notification System

LLM-powered, low-latency notification pipeline built on an event-driven AWS stack (Lambda, API Gateway, SQS, S3, DynamoDB) with ranking, personalized send-times, and robust delivery safeguards.

## Goals
- Sub-1s end-to-end latency from event ingestion to queued notification.
- Personalized ranking and timing via Gemini-powered scoring per user segment.
- Operational resilience: DLQs, rate limiting, exponential backoff, observability.

## Architecture (high level)
- **Event ingestion**: S3 event/Lambda or API Gateway -> normalizes payloads -> pushes to SQS.
- **Preference lookup**: DynamoDB stores user/channel preferences and quiet hours; queried during ranking/dispatch.
- **Ranking service**: Lambda that dequeues, enriches, and calls Gemini API to score/priority-rank notifications per segment.
- **Dispatchers**: Channel-specific Lambdas (email/SMS/push/webhook) pull prioritized messages, apply rate limits, and send with backoff + DLQ on failure.
- **Observability**: CloudWatch metrics + structured logs; DLQ alarms for investigation.

## Build plan (phases)
1) Document architecture and workflows. 
2) Scaffold project: repo layout, sample env config, stub Lambdas/services.
3) Event ingestion path: S3 trigger -> transformer -> SQS (with DLQ).
4) Ranking service: Gemini scoring + prioritization queue.
5) Dispatch service: preference checks, rate limiting, exponential backoff, DLQs.
6) Deploy/test workflows: IaC (Serverless/Terraform) + local test harness.

## Repo layout (to be created next)
- `infra/` – IaC for AWS resources (S3, SQS, Lambda, DynamoDB, API Gateway, DLQs).
- `services/` – Lambda/service source (ingestion, ranking, dispatchers).
- `packages/` – Shared libraries (schemas, clients, utilities).
- `docs/` – Architecture, runbooks, and ops playbooks.

## Prereqs (planned)
- Node.js LTS, pnpm/npm, AWS CLI configured, Gemini API key for ranking.

## Deploying with Serverless (AWS)
- Install the Serverless Framework CLI globally: `npm install -g serverless` (once on your machine).
- Configure AWS credentials for your account: `aws configure` (or environment variables).
- Set `GEMINI_API_KEY` (and optionally `GEMINI_MODEL`) in your shell.
- From the project root:
  - Deploy: `npm run deploy` (runs `serverless deploy` using `serverless.yml`).
  - Remove stack: `npm run remove`.

The Serverless config wires:
- S3 bucket -> ingestion Lambda.
- HTTP endpoint `/events` -> ingestion Lambda.
- Ingestion Lambda -> `incoming` SQS (+ DLQ).
- `incoming` SQS -> ranking Lambda -> `priority` SQS (+ DLQ).
- `priority` SQS -> dispatch Lambda -> provider (stub).

## Local ranking demo (no AWS required)
- Build the project: `npm run build`.
- Run the demo: `npm run local:ranking-demo`.
- Behavior:
  - Without `GEMINI_API_KEY`, uses the local `fallbackScore` heuristic.
  - With `GEMINI_API_KEY`, calls Gemini via `scoreWithLLM` and prints the LLM-based score/priority/sendAfter.

Next: build the scaffold and stub services so each phase can be implemented incrementally.
