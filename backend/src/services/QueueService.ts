import { Queue, Worker, Job, QueueEvents, JobsOptions } from "bullmq";
import { getRedisClient } from "./RedisService";
import AppError from "../errors/AppError";

// Queue names
export const QUEUE_NAMES = {
  INACTIVITY_CHECK: "inactivity-check",
  MESSAGE_SEND: "message-send",
  WEBHOOK_DELIVERY: "webhook-delivery",
  AI_PROCESSING: "ai-processing",
  RAG_INDEXING: "rag-indexing",
  ANALYTICS: "analytics",
} as const;

// Connection singleton per queue
const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();
const queueEvents = new Map<string, QueueEvents>();

const getConnectionParams = () => ({
  url: process.env.REDIS_URL || "redis://localhost:6379",
  maxRetriesPerRequest: 3,
});

// Get or create a queue
export const getQueue = async (name: string): Promise<Queue> => {
  if (queues.has(name)) {
    return queues.get(name)!;
  }

  const queue = new Queue(name, {
    connection: getConnectionParams(),
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: "exponential" as const,
        delay: 1000,
      },
      removeOnComplete: {
        age: 60 * 60, // 1 hour
        count: 1000,
      },
      removeOnFail: {
        age: 24 * 60 * 60, // 24 hours
        count: 5000,
      },
    },
  });

  queues.set(name, queue);
  return queue;
};

// Add a job to the queue
export interface QueueJob<T = any> {
  name: string;
  data: T;
  opts?: JobsOptions;
}

export const addJob = async <T = any>(queueName: string, job: QueueJob<T>): Promise<Job<T>> => {
  const queue = await getQueue(queueName);

  const result = await queue.add(job.name, job.data, {
    ...job.opts,
  });

  return result;
};

// Add multiple jobs (bulk)
export const addBulkJobs = async <T = any>(queueName: string, jobs: QueueJob<T>[]): Promise<Job<T>[]> => {
  const queue = await getQueue(queueName);

  const bulkJobs = jobs.map((job) => ({
    name: job.name,
    data: job.data,
    opts: job.opts,
  }));

  const results = await queue.addBulk(bulkJobs);
  return results;
};

// Get job by ID
export const getJob = async <T = any>(queueName: string, jobId: string): Promise<Job<T> | undefined> => {
  const queue = await getQueue(queueName);
  return queue.getJob(jobId);
};

// Get queue metrics
export const getQueueMetrics = async (queueName: string) => {
  const queue = await getQueue(queueName);

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    queue.getWaitingCount(),
    queue.getActiveCount(),
    queue.getCompletedCount(),
    queue.getFailedCount(),
    queue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
  };
};

// Get all queues metrics
export const getAllQueuesMetrics = async () => {
  const metrics: Record<string, any> = {};

  for (const name of queues.keys()) {
    metrics[name] = await getQueueMetrics(name);
  }

  return metrics;
};

// Close all queues gracefully
export const closeAllQueues = async (): Promise<void> => {
  const closePromises: Promise<void>[] = [];

  for (const [name, queue] of queues.entries()) {
    closePromises.push(
      queue.close().then(() => {
        console.log(`[Queue] Closed: ${name}`);
      })
    );
  }

  for (const [name, worker] of workers.entries()) {
    closePromises.push(
      worker.close().then(() => {
        console.log(`[Worker] Closed: ${name}`);
      })
    );
  }

  for (const [name, events] of queueEvents.entries()) {
    closePromises.push(
      events.close().then(() => {
        console.log(`[QueueEvents] Closed: ${name}`);
      })
    );
  }

  await Promise.all(closePromises);
  queues.clear();
  workers.clear();
  queueEvents.clear();
};

// Health check for queues
export const checkQueuesHealth = async (): Promise<{ healthy: boolean; details: Record<string, any> }> => {
  const details: Record<string, any> = {};
  let healthy = true;

  try {
    const client = await getRedisClient();
    await client.ping();
  } catch {
    healthy = false;
    details.redis = { connected: false };
  }

  for (const [name, queue] of queues.entries()) {
    try {
      const isPaused = await queue.isPaused();
      const metrics = await getQueueMetrics(name);
      details[name] = { isPaused, ...metrics, connected: true };
    } catch (error: any) {
      healthy = false;
      details[name] = { connected: false, error: error.message };
    }
  }

  return { healthy, details };
};

// Schedule a recurring job (cron-like)
export const addRecurringJob = async <T = any>(
  queueName: string,
  jobName: string,
  data: T,
  pattern: string // cron pattern
): Promise<void> => {
  const queue = await getQueue(queueName);

  // Remove existing recurring job with same name first
  const existingJobs = await queue.getRepeatableJobs();
  for (const existing of existingJobs) {
    if (existing.name === jobName) {
      await queue.removeRepeatableByKey(existing.key);
    }
  }

  await queue.add(jobName, data, {
    repeat: {
      pattern,
    },
  });
};

// Remove a recurring job
export const removeRecurringJob = async (queueName: string, jobName: string): Promise<boolean> => {
  const queue = await getQueue(queueName);

  const repeatableJobs = await queue.getRepeatableJobs();
  for (const job of repeatableJobs) {
    if (job.name === jobName) {
      return await queue.removeRepeatableByKey(job.key);
    }
  }

  return false;
};

// Pause a queue
export const pauseQueue = async (queueName: string): Promise<void> => {
  const queue = await getQueue(queueName);
  await queue.pause();
};

// Resume a queue
export const resumeQueue = async (queueName: string): Promise<void> => {
  const queue = await getQueue(queueName);
  await queue.resume();
};

// Drain a queue (remove all waiting jobs)
export const drainQueue = async (queueName: string): Promise<void> => {
  const queue = await getQueue(queueName);
  await queue.drain();
};

// Export job types for type safety
export type InactivityCheckJob = {
  companyId?: number;
  forceRun?: boolean;
};

export type MessageSendJob = {
  contactId: number;
  ticketId: number;
  body: string;
  fromMe: boolean;
  mediaUrl?: string;
  mediaType?: string;
};

export type WebhookDeliveryJob = {
  webhookId: number;
  payload: Record<string, any>;
  attempt?: number;
};

export type AIProcessingJob = {
  ticketId: number;
  contactId: number;
  message: string;
  companyId: number;
};

export type RAGIndexingJob = {
  documentId: number;
  companyId: number;
  priority?: "high" | "normal" | "low";
};

export type AnalyticsJob = {
  companyId: number;
  dateRange: {
    start: Date;
    end: Date;
  };
  reportType: "funnel" | "response_times" | "agent_performance";
};
