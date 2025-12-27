// src/chat/features/reactions/reactions.service.ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Message, MessageDocument } from 'src/chat/features/messages/schemas/message.schema';

export type ReactionInput = {
  conversationId: string;
  messageId: string;
  userId: string;
  emoji: string;
  mode: 'add' | 'remove';
  nowMs?: number;
};

@Injectable()
export class ReactionsService {
  constructor(@InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>) {}

  async react(input: ReactionInput) {
    const now = input.nowMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(input.messageId),
      conversationId: input.conversationId,
    });
    if (!msg) throw new NotFoundException('Message not found');

    // WhatsApp-like: one reaction per user (enforced by removing previous)
    msg.reactions = (msg.reactions ?? []).filter((r) => r.userId !== input.userId);

    if (input.mode === 'add') {
      msg.reactions.push({ userId: input.userId, emoji: input.emoji, at: now } as any);
    }

    await msg.save();
    return msg;
  }
}
