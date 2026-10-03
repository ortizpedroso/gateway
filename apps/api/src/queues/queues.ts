import { Job, Queue, QueueOptions, Worker } from "bullmq";
import IORedis from "ioredis";

/** Conexão Redis compartilhada pelas filas (webhooks, e-mails, fiscal). */
export const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
});

const queueOpts = (): QueueOptions => ({
  connection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: "exponential", delay: 2_000 },
    removeOnComplete: { count: 1_000 },
    removeOnFail: { count: 5_000 },
  },
});

export const QUEUE = {
  WEBHOOK_OUT: "webhook-out",
  EMAIL: "email-transactions",
  FISCAL: "fiscal-nfse",
} as const;

export const webhookOutQueue = new Queue<WebhookOutJobData>(QUEUE.WEBHOOK_OUT, queueOpts());
export const emailQueue = new Queue<EmailJobData>(QUEUE.EMAIL, queueOpts());
export const fiscalQueue = new Queue<FiscalJobData>(QUEUE.FISCAL, queueOpts());

export type WebhookOutJobData = {
  webhookEventId: string; // linha em webhook_events (direction=OUTBOUND)
  url: string;
  payload: Record<string, unknown>;
  secret: string; // HMAC-SHA256
};

export type EmailJobData = {
 to: string;
 subject: string;
 html: string;
 chargeId?: string;
};

export type FiscalJobData = { invoiceId: string; chargeId: string };

export function makeWorker(name: string, processor: (job: Job) => Promise<void>): Worker {
  return new Worker(name, processor, { connection, concurrency: 8 });
}
