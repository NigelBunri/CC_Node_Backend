// src/chat/features/calls/call-state.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { CallSession, CallSessionDocument } from './call-session.schema';

@Injectable()
export class CallStateService {
  constructor(@InjectModel(CallSession.name) private readonly model: Model<CallSessionDocument>) {}

  async upsertState(params: {
    conversationId: string;
    callId: string;
    fromUserId: string;
    toUserId: string;
    state: CallSession['state'];
    startedAtMs?: number;
    endedAtMs?: number;
    endedReason?: string;
  }) {
    const { conversationId, callId } = params;

    await this.model.updateOne(
      { conversationId, callId },
      { $set: { ...params }, $setOnInsert: { conversationId, callId } },
      { upsert: true },
    );

    return this.model.findOne({ conversationId, callId }).exec();
  }
}
