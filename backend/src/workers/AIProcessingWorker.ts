import { Worker, Job } from "bullmq";
import { QUEUE_NAMES, AIProcessingJob } from "../services/QueueService";
import { executeAgentTurn } from "../services/WhatsAppCloudServices/ProcessCloudWebhookService";
import Ticket from "../models/Ticket";
import Contact from "../models/Contact";

let worker: Worker | null = null;

export const startAIProcessingWorker = async (): Promise<Worker> => {
  if (worker) return worker;

  worker = new Worker<AIProcessingJob>(
    QUEUE_NAMES.AI_PROCESSING,
    async (job: Job<AIProcessingJob>) => {
      const { ticketId, contactId, message, companyId } = job.data;
      console.log(`[AIProcessingWorker] Processing job ${job.id} ticket=${ticketId}`);

      try {
        const ticket = await Ticket.findByPk(ticketId);
        const contact = await Contact.findByPk(contactId);
        if (!ticket || !contact) {
          console.error(`[AIProcessingWorker] Ticket=${ticketId} or Contact=${contactId} not found`);
          return;
        }

        await executeAgentTurn({ ticket, contact, text: message });
        console.log(`[AIProcessingWorker] Job ${job.id} completed`);
      } catch (error: any) {
        console.error(`[AIProcessingWorker] Job ${job.id} failed:`, error?.message || error);
        throw error;
      }
    },
    {
      connection: {
        url: process.env.REDIS_URL || "redis://localhost:6379",
        maxRetriesPerRequest: null,
      },
      concurrency: 3,
    }
  );

  worker.on("completed", (job) => {
    console.log(`[AIProcessingWorker] Job ${job.id} completed`);
  });

  worker.on("failed", (job, err) => {
    console.error(`[AIProcessingWorker] Job ${job?.id} failed:`, err.message);
  });

  worker.on("error", (err) => {
    console.error(`[AIProcessingWorker] Worker error:`, err);
  });

  console.log("[AIProcessingWorker] Started");
  return worker;
};

export const stopAIProcessingWorker = async (): Promise<void> => {
  if (worker) {
    await worker.close();
    worker = null;
  }
};
