// src/chat/features/receipts/receipts.service.ts

import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

// ✅ Use relative import (avoid 'src/...')
import { Message, MessageDocument, ReceiptEntry } from '../messages/schemas/message.schema';

export type ReceiptInput = {
  conversationId: string;
  messageId: string;
  userId: string;
  deviceId: string;
  type: 'delivered' | 'read' | 'played';
  atMs?: number;
};

@Injectable()
export class ReceiptsService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
  ) {}

  async addReceipt(input: ReceiptInput) {
    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    });

    if (!msg) throw new NotFoundException('message not found');

    const atMs = input.atMs ?? Date.now();

    // ✅ field name must be atMs
    const entry: ReceiptEntry = {
      userId: input.userId,
      deviceId: input.deviceId,
      atMs,
    };

    if (input.type === 'delivered') msg.deliveredTo = this.upsert(msg.deliveredTo ?? [], entry);
    if (input.type === 'read') {
      msg.readBy = this.upsert(msg.readBy ?? [], entry);

      // Optional ephemeral behavior (if you use it)
      if (msg.ephemeral?.enabled && msg.ephemeral?.startAfterRead) {
        if (!msg.ephemeral.expireAt && msg.ephemeral.ttlSeconds) {
          msg.ephemeral.expireAt = atMs + msg.ephemeral.ttlSeconds * 1000;
        }
      }
    }
    if (input.type === 'played') msg.playedBy = this.upsert(msg.playedBy ?? [], entry);

    await msg.save();
    return msg;
  }

  private upsert(list: ReceiptEntry[], entry: ReceiptEntry): ReceiptEntry[] {
    const filtered = (list ?? []).filter((x) => x.userId !== entry.userId);
    filtered.push(entry);
    return filtered;
  }
}
