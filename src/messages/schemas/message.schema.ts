import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MessageDocument = HydratedDocument<MessageEntity>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class MessageEntity {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true })
  senderId!: string;

  @Prop()
  ciphertext?: string;

  @Prop()
  replyToId?: string;

  @Prop({
    type: Array,
    default: [],
  })
  attachments!: Array<{
    id: string;       // key/filename
    url: string;      // public URL (local or S3)
    name: string;     // original file name
    mime: string;     // content-type
    size: number;     // bytes
    width?: number;   // future: images/videos
    height?: number;
    duration?: number;// future: audio/video
    thumbUrl?: string;// future
  }>;

  /**
   * Idempotency key from the client.
   * Same (conversationId, senderId, clientId) => same logical message.
   * Optional so older messages without clientId still work.
   */
  @Prop()
  clientId?: string;
}

export const MessageSchema = SchemaFactory.createForClass(MessageEntity);

// Efficient history queries per room using _id cursor later if needed
MessageSchema.index({ conversationId: 1, _id: 1 });

// Prevent duplicate messages for the same logical send when clientId is present
MessageSchema.index(
  { conversationId: 1, senderId: 1, clientId: 1 },
  {
    unique: true,
    sparse: true, // only enforced when clientId exists
  },
);
