import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { AttachmentKind } from '../dto/send-message.dto';

export type MessageDocument = HydratedDocument<MessageEntity>;

@Schema({ timestamps: { createdAt: true, updatedAt: false } })
export class MessageEntity {
  @Prop({ required: true, index: true })
  conversationId!: string;

  @Prop({ required: true })
  senderId!: string;

  /**
   * Optional display name for the sender.
   * This is useful to avoid extra lookups when broadcasting to clients.
   */
  @Prop({ type: String, default: null })
  senderName?: string | null;

  /**
   * Plaintext content; frontend calls this `text`, backend stores in `ciphertext`
   * so you can later swap to real encryption if needed.
   */
  @Prop()
  ciphertext?: string;

  @Prop({ type: String, default: null })
  replyToId?: string | null;

  @Prop({
    type: Array,
    default: [],
  })
  attachments!: Array<{
    id: string;          // key/filename
    url: string;         // public URL
    originalName: string;
    mimeType: string;
    size: number;

    kind?: AttachmentKind | string;

    width?: number;
    height?: number;
    durationMs?: number;
    thumbUrl?: string;
  }>;

  /**
   * Idempotency key from the client.
   * Same (conversationId, senderId, clientId) => same logical message.
   * Optional so older messages without clientId still work.
   */
  @Prop({ type: String, default: null })
  clientId?: string | null;

  /* ---------------------- Rich content fields ---------------------- */

  @Prop({
    enum: [
      'text',
      'voice',
      'styled_text',
      'sticker',
      'contacts',
      'poll',
      'event',
      'system',
    ],
    default: 'text',
  })
  kind?: string;

  @Prop({
    type: Object,
    default: null,
  })
  voice?: {
    uri: string;
    durationMs: number;
    waveform?: number[];
  } | null;

  @Prop({
    type: Object,
    default: null,
  })
  styledText?: {
    text: string;
    backgroundColor: string;
    fontSize: number;
    fontColor: string;
    fontFamily?: string | null;
  } | null;

  @Prop({
    type: Object,
    default: null,
  })
  sticker?: {
    id: string;
    uri: string;
    text?: string;
    width?: number;
    height?: number;
  } | null;

  @Prop({
    type: Array,
    default: [],
  })
  contacts?: Array<{
    id: string;
    name: string;
    phone: string;
  }>;

  @Prop({
    type: Object,
    default: null,
  })
  poll?: any;

  @Prop({
    type: Object,
    default: null,
  })
  event?: any;

  // Optional flags if you want them later
  @Prop({ default: false })
  isDeleted?: boolean;

  @Prop({ default: false })
  isPinned?: boolean;

  @Prop({ default: 'sent' })
  status?: string;

  /**
   * True if this message is the first message in the conversation.
   * Computed server-side; never trusted from the client.
   */
  @Prop({ default: false })
  isFirstMessage?: boolean;
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
