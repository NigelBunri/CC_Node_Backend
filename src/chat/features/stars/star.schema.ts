// src/chat/features/stars/star.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type StarDocument = HydratedDocument<Star>;

@Schema({ timestamps: true })
export class Star {
  @Prop({ required: true, index: true })
  userId!: string;

  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true })
  messageId!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const StarSchema = SchemaFactory.createForClass(Star);
StarSchema.index({ userId: 1, conversationId: 1, messageId: 1 }, { unique: true });
StarSchema.index({ userId: 1, createdAt: -1 });
