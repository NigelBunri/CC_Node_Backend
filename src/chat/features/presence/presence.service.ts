// src/chat/features/presence/presence.service.ts
import { Injectable } from '@nestjs/common';

/**
 * PresenceService:
 * - Right now: placeholder hooks.
 * - Later: store per-user multi-device presence in Redis, lastSeen timestamps, etc.
 */
@Injectable()
export class PresenceService {
  markOnline(userId: string) {
    void userId;
  }
  markOffline(userId: string) {
    void userId;
  }
}
