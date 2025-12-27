// src/chat/features/pins/pin.schema.ts

import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type PinDocument = HydratedDocument<Pin>;

@Schema({ timestamps: true })
export class Pin {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true })
  messageId!: string;

  @Prop({ required: true })
  pinnedBy!: string;

  createdAt!: Date;
  updatedAt!: Date;
}

export const PinSchema = SchemaFactory.createForClass(Pin);
PinSchema.index({ conversationId: 1, messageId: 1 }, { unique: true });
PinSchema.index({ conversationId: 1, createdAt: -1 });
