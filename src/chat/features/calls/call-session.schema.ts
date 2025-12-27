// src/chat/features/calls/call-session.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type CallSessionDocument = HydratedDocument<CallSession>;

@Schema({ timestamps: true })
export class CallSession {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  callId!: string;

  @Prop({ required: true })
  fromUserId!: string;

  @Prop({ required: true })
  toUserId!: string;

  @Prop({ default: 'ringing', index: true })
  state!: 'ringing' | 'active' | 'ended' | 'missed' | 'rejected';

  @Prop()
  endedReason?: string;

  @Prop({ min: 0 })
  startedAtMs?: number;

  @Prop({ min: 0 })
  endedAtMs?: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export const CallSessionSchema = SchemaFactory.createForClass(CallSession);
CallSessionSchema.index({ conversationId: 1, callId: 1 }, { unique: true });
CallSessionSchema.index({ conversationId: 1, createdAt: -1 });
