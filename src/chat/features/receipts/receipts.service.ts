// src/chat/features/receipts/receipts.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Message, MessageDocument, ReceiptEntry } from 'src/chat/features/messages/schemas/message.schema';

export type ReceiptType = 'delivered' | 'read' | 'played';
export type ReceiptInput = {
  conversationId: string;
  messageId: string;
  userId: string;
  deviceId: string;
  type: ReceiptType;
  atMs?: number;
};

@Injectable()
export class ReceiptsService {
  constructor(@InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>) {}

  async addReceipt(input: ReceiptInput) {
    const at = input.atMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(input.messageId),
      conversationId: input.conversationId,
    });
    if (!msg) throw new NotFoundException('Message not found');

    const entry: ReceiptEntry = { userId: input.userId, deviceId: input.deviceId, at };

    if (input.type === 'delivered') msg.deliveredTo = this.upsert(msg.deliveredTo ?? [], entry);

    if (input.type === 'read') {
      msg.readBy = this.upsert(msg.readBy ?? [], entry);

      // Ephemeral: startAfterRead
      if (msg.ephemeral?.enabled && msg.ephemeral?.startAfterRead) {
        if (!msg.ephemeral.expireAt && msg.ephemeral.ttlSeconds) {
          msg.ephemeral.expireAt = at + msg.ephemeral.ttlSeconds * 1000;
        }
      }
    }

    if (input.type === 'played') msg.playedBy = this.upsert(msg.playedBy ?? [], entry);

    await msg.save();
    return msg;
  }

  private upsert(arr: ReceiptEntry[], entry: ReceiptEntry): ReceiptEntry[] {
    let replaced = false;
    const out: ReceiptEntry[] = [];
    for (const r of arr) {
      if (r.userId === entry.userId && r.deviceId === entry.deviceId) {
        out.push(entry);
        replaced = true;
      } else out.push(r);
    }
    if (!replaced) out.push(entry);
    return out;
  }
}
