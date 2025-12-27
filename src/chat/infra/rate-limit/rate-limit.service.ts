// src/chat/infra/rate-limit/rate-limit.service.ts
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

@Injectable()
export class RateLimitService {
  private buckets = new Map<string, { resetAt: number; count: number }>();

  private limits: Record<string, { windowMs: number; max: number }> = {
    join: { windowMs: 10_000, max: 30 },
    leave: { windowMs: 10_000, max: 30 },
    send: { windowMs: 5_000, max: 25 },
    edit: { windowMs: 10_000, max: 20 },
    delete: { windowMs: 10_000, max: 20 },
    react: { windowMs: 5_000, max: 60 },
    receipt: { windowMs: 5_000, max: 200 },
    typing: { windowMs: 2_000, max: 30 },
    gap: { windowMs: 10_000, max: 20 },
    call: { windowMs: 5_000, max: 60 },
  };

  assert(userId: string, action: string) {
    const rule = this.limits[action] ?? { windowMs: 10_000, max: 50 };
    const key = `${userId}:${action}`;
    const now = Date.now();

    const entry = this.buckets.get(key);
    if (!entry || now >= entry.resetAt) {
      this.buckets.set(key, { resetAt: now + rule.windowMs, count: 1 });
      return;
    }

    entry.count += 1;
    if (entry.count > rule.max) {
      throw new HttpException(`Rate limit exceeded for ${action}`, HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
