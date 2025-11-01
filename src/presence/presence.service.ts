import { Injectable, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';

@Injectable()
export class PresenceService implements OnModuleInit {
  private redis!: Redis;

  async onModuleInit() {
    this.redis = new Redis(process.env.REDIS_URL!);
  }

  async markOnline(userId: string, sessionId: string) {
    await this.redis.sadd(`online:${userId}`, sessionId);
  }

  async markOffline(userId: string, sessionId: string) {
    await this.redis.srem(`online:${userId}`, sessionId);
  }

  async isOnline(userId: string): Promise<boolean> {
    return (await this.redis.scard(`online:${userId}`)) > 0;
  }
}
