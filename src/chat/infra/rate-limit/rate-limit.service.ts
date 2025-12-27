// src/chat/infra/rate-limit/rate-limit.service.ts

import { Injectable, HttpException, HttpStatus } from '@nestjs/common';

type Bucket = { resetAt: number; count: number };

@Injectable()
export class RateLimitService {
  private buckets = new Map<string, Bucket>();

  // Your existing style: assert(userId, action)
  assert(userId: string, action: string) {
    // default policy per action
    const key = `${action}:${userId}`;
    const limit = action === 'send' ? 25 : 60;
    const windowMs = action === 'send' ? 5000 : 60_000;
    this.assertAllowed({ key, limit, windowMs });
  }

  // ✅ handlers/messages.ts expects this
  assertAllowed(opts: { key: string; limit: number; windowMs: number }) {
    const now = Date.now();
    const b = this.buckets.get(opts.key);

    if (!b || now >= b.resetAt) {
      this.buckets.set(opts.key, { resetAt: now + opts.windowMs, count: 1 });
      return;
    }

    b.count += 1;

    if (b.count > opts.limit) {
      throw new HttpException('Too many requests', HttpStatus.TOO_MANY_REQUESTS);
    }
  }
}
