// src/chat/features/pins/pins.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Pin, PinDocument } from './pin.schema';

@Injectable()
export class PinsService {
  constructor(@InjectModel(Pin.name) private readonly model: Model<PinDocument>) {}

  async setPinned(params: { conversationId: string; messageId: string; userId: string; pinned: boolean }) {
    const { conversationId, messageId, userId, pinned } = params;

    if (pinned) {
      await this.model.updateOne(
        { conversationId, messageId },
        { $setOnInsert: { conversationId, messageId, pinnedBy: userId } },
        { upsert: true },
      );
      return { pinned: true };
    }

    await this.model.deleteOne({ conversationId, messageId });
    return { pinned: false };
  }

  async listPinned(conversationId: string, limit = 50) {
    return this.model.find({ conversationId }).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
