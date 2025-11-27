import { z } from "zod";

const UserSchema = z.object({
  id: z.string(),
  segment: z.string().optional(),
  channels: z.array(z.string()).default([]),
});

const ContentSchema = z.object({
  title: z.string(),
  body: z.string(),
  cta: z.string().optional(),
  metadata: z.record(z.any()).optional(),
});

export const IncomingEventSchema = z.object({
  eventId: z.string(),
  source: z.string().default("unknown"),
  occurredAt: z.string().optional(),
  user: UserSchema,
  content: ContentSchema,
});

export type NotificationEvent = z.infer<typeof IncomingEventSchema>;

export type Channel = "email" | "sms" | "push" | "webhook";

export interface DeliveryPreferences {
  quietHours?: { start: string; end: string };
  rateLimitKey?: string;
  failoverChannels?: Channel[];
  timezone?: string;
}

export interface RankedMessage {
  eventId: string;
  userId: string;
  channel: Channel;
  priority: number;
  score: number;
  sendAfter?: string;
  content: {
    title: string;
    body: string;
    cta?: string;
    metadata?: Record<string, unknown>;
  };
  preferences?: DeliveryPreferences;
  source?: string;
}

/**
 * Validate and normalize incoming events into a canonical shape.
 */
export function toCanonicalEvent(input: unknown): NotificationEvent {
  return IncomingEventSchema.parse(input);
}
