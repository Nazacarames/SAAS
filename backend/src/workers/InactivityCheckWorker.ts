import { Worker, Job } from "bullmq";
import CheckInactiveContactsService from "../services/ContactServices/CheckInactiveContactsService";
import { QUEUE_NAMES, InactivityCheckJob } from "../services/QueueService";

let worker: Worker | null = null;

export const startInactivityCheckWorker = async (): Promise<Worker> => {
  if (worker) {
    return worker;
  }

  worker = new Worker<InactivityCheckJob>(
    QUEUE_NAMES.INACTIVITY_CHECK,
    async (job: Job<InactivityCheckJob>) => {
      console.log(`[InactivityWorker] Processing job ${job.id}, data:`, job.data);

      try {
        // Run the inactivity check service
        await CheckInactiveContactsService();
        console.log(`[InactivityWorker] Job ${job.id} completed successfully`);
      } catch (error: any) {
        console.error(`[InactivityWorker] Job ${job.id} failed:`, error?.message || error);
        throw error; // Re-throw to trigger BullMQ retry mechanism
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: 3,
      },
      concurrency: 1, // Only one inactivity check at a time
      limiter: {
        max: 1,
        duration: 60_000, // At most 1 job per minute
      },
    }
  );

  worker.on("completed", (job) => {
    console.log(`[InactivityWorker] Job ${job.id} has completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[InactivityWorker] Job ${job?.id} has failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error(`[InactivityWorker] Worker error:`, err);
  });

  console.log("[InactivityWorker] Started successfully");
  return worker;
};

export const stopInactivityCheckWorker = async (): Promise<void> => {
  if (worker) {
    await worker.close();
    worker = null;
    console.log("[InactivityWorker] Stopped");
  }
};

export const getInactivityCheckWorker = (): Worker | null => {
  return worker;
};
