import { createClient, RedisClientType } from "redis";
import AppError from "../errors/AppError";

let redisClient: RedisClientType | null = null;

const getRedisUrl = (): string => {
  return process.env.REDIS_URL || "redis://localhost:6379";
};

export const getRedisClient = async (): Promise<RedisClientType> => {
  if (redisClient && redisClient.isOpen) {
    return redisClient;
  }

  try {
    redisClient = createClient({ url: getRedisUrl() });

    redisClient.on("error", (err) => {
      console.error("[Redis] Client error:", err);
    });

    redisClient.on("connect", () => {
      console.log("[Redis] Connected successfully");
    });

    await redisClient.connect();
    return redisClient;
  } catch (error) {
    console.error("[Redis] Failed to connect:", error);
    throw new AppError("Redis connection failed", 503);
  }
};

export const closeRedisConnection = async (): Promise<void> => {
  if (redisClient && redisClient.isOpen) {
    await redisClient.quit();
    redisClient = null;
  }
};

// Rate limiter using Redis sliding window
export interface RateLimiterOptions {
  key: string;
  maxRequests: number;
  windowMs: number;
}

export const rateLimitRedis = async (options: RateLimiterOptions): Promise<{ allowed: boolean; remaining: number; resetAt: number }> => {
  const { key, maxRequests, windowMs } = options;
  const now = Date.now();
  const windowStart = now - windowMs;

  try {
    const client = await getRedisClient();
    const redisKey = `ratelimit:${key}`;

    // Use sorted set with timestamp as score
    const multi = client.multi();

    // Remove old entries outside the window
    multi.zRemRangeByScore(redisKey, 0, windowStart);

    // Count current requests in window
    multi.zCard(redisKey);

    // Add current request
    multi.zAdd(redisKey, { score: now, value: `${now}:${Math.random()}` });

    // Set expiry on the key
    multi.expire(redisKey, Math.ceil(windowMs / 1000));

    const results = await multi.exec();

    // Second result is the count before adding current request
    const currentCount = (results?.[1] as number) || 0;
    const allowed = currentCount < maxRequests;
    const remaining = Math.max(0, maxRequests - currentCount - 1);
    const resetAt = now + windowMs;

    return { allowed, remaining, resetAt };
  } catch (error) {
    console.error("[RateLimiter] Redis error, failing open:", error);
    // Fail open - allow request if Redis is unavailable
    return { allowed: true, remaining: maxRequests, resetAt: now + windowMs };
  }
};

// Distributed lock using Redis
export interface LockOptions {
  key: string;
  ttlMs: number;
}

export const acquireLock = async (options: LockOptions): Promise<{ acquired: boolean; lockValue: string }> => {
  const { key, ttlMs } = options;
  const lockValue = `${Date.now()}:${Math.random()}`;

  try {
    const client = await getRedisClient();
    const lockKey = `lock:${key}`;

    // SET NX with TTL - atomic lock acquisition
    const result = await client.set(lockKey, lockValue, {
      NX: true,
      PX: ttlMs,
    });

    return { acquired: result === "OK", lockValue };
  } catch (error) {
    console.error("[Lock] Redis error:", error);
    return { acquired: false, lockValue: "" };
  }
};

export const releaseLock = async (key: string, lockValue: string): Promise<boolean> => {
  try {
    const client = await getRedisClient();
    const lockKey = `lock:${key}`;

    // Lua script to release lock only if we own it
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    const result = await client.eval(script, { keys: [lockKey], arguments: [lockValue] });
    return result === 1;
  } catch (error) {
    console.error("[Lock] Release error:", error);
    return false;
  }
};

// Cache helper functions
export const cacheSet = async (key: string, value: string, ttlSeconds: number = 300): Promise<void> => {
  try {
    const client = await getRedisClient();
    await client.setEx(key, ttlSeconds, value);
  } catch (error) {
    console.error("[Cache] Set error:", error);
  }
};

export const cacheGet = async (key: string): Promise<string | null> => {
  try {
    const client = await getRedisClient();
    return await client.get(key);
  } catch (error) {
    console.error("[Cache] Get error:", error);
    return null;
  }
};

export const cacheDelete = async (key: string): Promise<void> => {
  try {
    const client = await getRedisClient();
    await client.del(key);
  } catch (error) {
    console.error("[Cache] Delete error:", error);
  }
};

export const cacheDeletePattern = async (pattern: string): Promise<void> => {
  try {
    const client = await getRedisClient();
    const keys = await client.keys(pattern);
    if (keys.length > 0) {
      await client.del(keys);
    }
  } catch (error) {
    console.error("[Cache] Delete pattern error:", error);
  }
};
