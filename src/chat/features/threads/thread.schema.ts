// src/chat/features/threads/thread.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type ThreadDocument = HydratedDocument<Thread>;

@Schema({ timestamps: true })
export class Thread {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true, index: true })
  rootMessageId!: string;

  @Prop()
  title?: string;

  @Prop({ required: true })
  createdBy!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const ThreadSchema = SchemaFactory.createForClass(Thread);

// One thread per rootMessage per conversation
ThreadSchema.index({ conversationId: 1, rootMessageId: 1 }, { unique: true });
ThreadSchema.index({ conversationId: 1, createdAt: -1 });
