// src/chat/features/stars/stars.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Star, StarDocument } from './star.schema';

@Injectable()
export class StarsService {
  constructor(@InjectModel(Star.name) private readonly model: Model<StarDocument>) {}

  async setStarred(params: { userId: string; conversationId: string; messageId: string; starred: boolean }) {
    const { userId, conversationId, messageId, starred } = params;

    if (starred) {
      await this.model.updateOne(
        { userId, conversationId, messageId },
        { $setOnInsert: { userId, conversationId, messageId } },
        { upsert: true },
      );
      return { starred: true };
    }

    await this.model.deleteOne({ userId, conversationId, messageId });
    return { starred: false };
  }

  async listStarred(userId: string, limit = 100) {
    return this.model.find({ userId }).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
