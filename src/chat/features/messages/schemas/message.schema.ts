// src/chat/schemas/message.schema.ts
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type MessageDocument = HydratedDocument<Message>;

export enum MessageKind {
  TEXT = 'text',
  MEDIA = 'media',
  VOICE = 'voice',
  STICKER = 'sticker',
  CONTACT = 'contact',
  LOCATION = 'location',
  POLL = 'poll',
  EVENT = 'event',
  SYSTEM = 'system',
}

export class ReceiptEntry {
  @Prop({ type: String, required: true }) userId!: string;
  @Prop({ type: String, required: true }) deviceId!: string;
  @Prop({ type: Number }) at?: number;
}

export class ReactionEntry {
  @Prop({ type: String, required: true }) userId!: string;
  @Prop({ type: String, required: true }) emoji!: string;
  @Prop({ type: Number, required: true }) at!: number;
}

export class AttachmentMeta {
  @Prop({ type: String, required: true }) id!: string;
  @Prop({ type: String, required: true }) type!: string;
  @Prop({ type: String }) mime?: string;
  @Prop({ type: String }) name?: string;
  @Prop({ type: Number }) size?: number;
  @Prop({ type: Number }) width?: number;
  @Prop({ type: Number }) height?: number;
  @Prop({ type: Number }) durationMs?: number;
  @Prop({ type: String }) sha256?: string;
  @Prop({ type: String }) thumbnailId?: string;
  @Prop({ type: Object }) extra?: Record<string, any>;
}

export class ReplyMeta {
  @Prop({ type: String }) toMessageId?: string;
  @Prop({ type: Number }) toSeq?: number;
  @Prop({ type: String }) toUserId?: string;
  @Prop({ type: String }) previewText?: string;
}

export class ForwardMeta {
  @Prop({ type: Boolean, default: false }) isForwarded!: boolean;
  @Prop({ type: Number, default: 0 }) forwardCount!: number;
  @Prop({ type: String }) originalMessageId?: string;
  @Prop({ type: String }) originalConversationId?: string;
}

export class MentionMeta {
  @Prop({ type: [String], default: [] }) userIds!: string[];
}

export class EphemeralMeta {
  @Prop({ type: Boolean, default: false }) enabled!: boolean;
  @Prop({ type: Number }) ttlSeconds?: number;
  @Prop({ type: Boolean, default: false }) startAfterRead!: boolean;
  @Prop({ type: Number }) expireAt?: number;
}

export class LinkPreviewMeta {
  @Prop({ type: String }) url?: string;
  @Prop({ type: String }) title?: string;
  @Prop({ type: String }) description?: string;
  @Prop({ type: String }) imageUrl?: string;
}

export class PollMeta {
  @Prop({ type: String }) question?: string;
  @Prop({ type: [String], default: [] }) options!: string[];
  @Prop({ type: Boolean, default: false }) multiple!: boolean;
  @Prop({ type: Object }) votes?: Record<string, number[]>;
}

@Schema({ timestamps: true, collection: 'messages' })
export class Message {
  @Prop({ type: String, required: true, index: true }) conversationId!: string;
  @Prop({ type: Number, required: true, index: true }) seq!: number;
  @Prop({ type: String, required: true, index: true }) clientId!: string;

  @Prop({ type: String, required: true, index: true }) senderId!: string;
  @Prop({ type: String, required: true }) senderDeviceId!: string;

  @Prop({ type: String, enum: MessageKind, required: true, index: true })
  kind!: MessageKind;

  @Prop({ type: String }) ciphertext?: string;
  @Prop({ type: Object }) encryptionMeta?: Record<string, any>;

  @Prop({ type: String }) text?: string;

  @Prop({ type: [AttachmentMeta], default: [] }) attachments!: AttachmentMeta[];

  @Prop({ type: ReplyMeta }) reply?: ReplyMeta;
  @Prop({ type: ForwardMeta }) forward?: ForwardMeta;
  @Prop({ type: MentionMeta }) mentions?: MentionMeta;

  @Prop({ type: LinkPreviewMeta }) linkPreview?: LinkPreviewMeta;
  @Prop({ type: PollMeta }) poll?: PollMeta;
  @Prop({ type: EphemeralMeta }) ephemeral?: EphemeralMeta;

  @Prop({ type: Boolean, default: false }) edited!: boolean;
  @Prop({ type: Number }) editedAt?: number;

  @Prop({
    type: String,
    enum: ['none', 'deleted_for_me', 'deleted_for_everyone'],
    default: 'none',
    index: true,
  })
  deleteState!: 'none' | 'deleted_for_me' | 'deleted_for_everyone';

  @Prop({ type: Number }) deletedAt?: number;
  @Prop({ type: String }) deletedBy?: string;

  @Prop({ type: [ReactionEntry], default: [] }) reactions!: ReactionEntry[];
  @Prop({ type: [ReceiptEntry], default: [] }) deliveredTo!: ReceiptEntry[];
  @Prop({ type: [ReceiptEntry], default: [] }) readBy!: ReceiptEntry[];
  @Prop({ type: [ReceiptEntry], default: [] }) playedBy!: ReceiptEntry[];

  @Prop({ type: [String], default: [] }) flags!: string[];

  @Prop({ type: String }) searchText?: string;
}

export const MessageSchema = SchemaFactory.createForClass(Message);
MessageSchema.index({ conversationId: 1, seq: 1 }, { unique: true });
MessageSchema.index({ conversationId: 1, clientId: 1 }, { unique: true });
MessageSchema.index({ conversationId: 1, createdAt: -1 });
