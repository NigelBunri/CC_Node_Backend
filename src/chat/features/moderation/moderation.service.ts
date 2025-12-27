// src/chat/features/moderation/moderation.service.ts

import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Report, ReportDocument } from './report.schema';

@Injectable()
export class ModerationService {
  constructor(@InjectModel(Report.name) private readonly model: Model<ReportDocument>) {}

  async reportMessage(params: {
    conversationId: string;
    messageId: string;
    reportedBy: string;
    reason: Report['reason'];
    note?: string;
  }) {
    const { conversationId, messageId, reportedBy, reason, note } = params;

    await this.model.updateOne(
      { conversationId, messageId, reportedBy },
      { $setOnInsert: { conversationId, messageId, reportedBy, reason, note, status: 'open' } },
      { upsert: true },
    );

    return { ok: true };
  }
}
