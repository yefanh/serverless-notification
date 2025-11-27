import { NotificationEvent } from "../packages/schemas/notifications";
import { fallbackScore, scoreWithLLM } from "../services/ranking/handler";

async function main() {
  const event: NotificationEvent = {
    eventId: "demo-1",
    source: "local-demo",
    occurredAt: new Date().toISOString(),
    user: {
      id: "user-123",
      segment: "beta",
      channels: ["email"],
    },
    content: {
      title: "Urgent: service incident detected",
      body: "We detected an error in your account. Please check your dashboard.",
    },
  };

  const useLlm = Boolean(process.env.OPENAI_API_KEY);

  const result = useLlm ? await scoreWithLLM(event) : fallbackScore(event);

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        useLlm,
        event,
        result,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

