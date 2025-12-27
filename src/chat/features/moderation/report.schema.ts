// src/chat/features/moderation/report.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ReportDocument = HydratedDocument<Report>;

@Schema({ timestamps: true })
export class Report {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  messageId!: string;

  @Prop({ required: true })
  reportedBy!: string;

  @Prop({ required: true })
  reason!: 'spam' | 'abuse' | 'harassment' | 'illegal' | 'other';

  @Prop()
  note?: string;

  @Prop({ default: 'open', index: true })
  status!: 'open' | 'triaged' | 'closed';

  createdAt!: Date;
  updatedAt!: Date;
}

export const ReportSchema = SchemaFactory.createForClass(Report);
ReportSchema.index({ conversationId: 1, messageId: 1, reportedBy: 1 }, { unique: true });
ReportSchema.index({ status: 1, createdAt: -1 });
