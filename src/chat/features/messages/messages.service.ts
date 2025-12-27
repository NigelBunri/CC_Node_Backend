// src/chat/features/messages/messages.service.ts

import { Injectable, BadRequestException, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Message, MessageDocument, MessageKind } from './schemas/message.schema';
import { SendMessageDto } from './messages.dto';

@Injectable()
export class MessagesService {
  constructor(
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
  ) {}

  /**
   * Batch A: Idempotent create (retry-safe)
   * - If (conversationId, clientId) exists -> return it
   * - Else create new message with given seq
   */
  async createIdempotent(params: {
    senderId: string;
    senderName?: string;
    seq: number;
    input: SendMessageDto;
  }): Promise<MessageDocument> {
    const { senderId, seq, input } = params;

    this.assertKindPayloadConsistency(input);

    const existing = await this.messageModel.findOne({
      conversationId: input.conversationId,
      clientId: input.clientId,
    });
    if (existing) return existing;

    const previewText = this.buildPreview(input);

    const created = new this.messageModel({
      conversationId: input.conversationId,
      senderId,
      clientId: input.clientId,
      seq,

      kind: input.kind as MessageKind,

      text: input.text,
      styledText: input.styledText,
      voice: input.voice,
      sticker: input.sticker,

      attachments: input.attachments,
      contacts: input.contacts,
      poll: input.poll,
      event: input.event,

      replyToId: input.replyToId,

      previewText,
    });

    try {
      return await created.save();
    } catch (e: any) {
      if (e?.code === 11000) {
        const again = await this.messageModel.findOne({
          conversationId: input.conversationId,
          clientId: input.clientId,
        });
        if (again) return again;
      }
      throw e;
    }
  }

  /* ==========================================================================
   * COMPAT WRAPPER (existing gateway calls this)
   * ========================================================================== */

  async sendIdempotent(input: any) {
    const { senderId, seq, ...rest } = input;
    return this.createIdempotent({
      senderId,
      seq,
      input: rest,
    } as any);
  }

  /* ==========================================================================
   * EDIT + DELETE (minimal working implementations)
   * ========================================================================== */

  async editMessage(input: {
    conversationId: string;
    messageId: string;
    editorId: string;
    editorDeviceId?: string;
    ciphertext?: string;
    encryptionMeta?: Record<string, any>;
    text?: string;
    attachments?: any[];
    nowMs?: number;
  }): Promise<MessageDocument> {
    const nowMs = input.nowMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    });

    if (!msg) throw new NotFoundException('message not found');
    if (String(msg.senderId) !== String(input.editorId)) {
      throw new ForbiddenException('only sender can edit');
    }
    if (msg.isDeleted) throw new BadRequestException('cannot edit deleted message');

    // Apply updates (keep it conservative)
    if (typeof input.text === 'string') msg.text = input.text;
    if (Array.isArray(input.attachments)) msg.attachments = input.attachments as any;

    if (typeof input.ciphertext === 'string') msg.ciphertext = input.ciphertext;
    if (input.encryptionMeta && typeof input.encryptionMeta === 'object') msg.encryptionMeta = input.encryptionMeta;

    msg.isEdited = true;
    msg.editedAt = nowMs;

    // refresh preview text if relevant
    msg.previewText = this.buildPreview({
      conversationId: msg.conversationId,
      clientId: msg.clientId,
      kind: msg.kind as any,
      text: msg.text,
      styledText: msg.styledText as any,
      voice: msg.voice as any,
      sticker: msg.sticker as any,
      attachments: msg.attachments as any,
      contacts: msg.contacts as any,
      poll: msg.poll as any,
      event: msg.event as any,
      replyToId: msg.replyToId,
    } as any);

    await msg.save();
    return msg;
  }

  async deleteMessage(input: {
    conversationId: string;
    messageId: string;
    requesterId: string;
    mode: 'deleted_for_me' | 'deleted_for_everyone';
    nowMs?: number;
  }): Promise<MessageDocument> {
    const nowMs = input.nowMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: input.messageId,
      conversationId: input.conversationId,
    });

    if (!msg) throw new NotFoundException('message not found');

    // For now: only sender can delete for everyone. Anyone can delete for me.
    if (input.mode === 'deleted_for_everyone') {
      if (String(msg.senderId) !== String(input.requesterId)) {
        throw new ForbiddenException('only sender can delete for everyone');
      }
      msg.isDeleted = true;
    }

    msg.deleteState = input.mode;
    msg.deletedAt = nowMs;
    msg.deletedBy = input.requesterId;

    await msg.save();
    return msg;
  }

  /* ==========================================================================
   * SYNC HELPERS (required by sync.service.ts)
   * ========================================================================== */

  async getRange(conversationId: string, fromSeq: number, toSeq: number) {
    return this.messageModel
      .find({ conversationId, seq: { $gte: fromSeq, $lte: toSeq } })
      .sort({ seq: 1 })
      .exec();
  }

  async findMissingSeqs(conversationId: string, fromSeq: number, toSeq: number) {
    const docs = await this.messageModel
      .find({ conversationId, seq: { $gte: fromSeq, $lte: toSeq } }, { seq: 1 })
      .lean()
      .exec();

    const seen = new Set<number>((docs as any[]).map((d) => d.seq));
    const missing: number[] = [];
    for (let s = fromSeq; s <= toSeq; s++) if (!seen.has(s)) missing.push(s);
    return missing;
  }

  /* ==========================================================================
   * VALIDATION + PREVIEW
   * ========================================================================== */

  private assertKindPayloadConsistency(input: SendMessageDto) {
    const kind = input.kind;

    const hasText = !!(input.text && input.text.trim().length);
    const hasStyled = !!input.styledText;
    const hasVoice = !!input.voice;
    const hasSticker = !!input.sticker;
    const hasAttachments = !!(input.attachments && input.attachments.length);
    const hasContacts = !!(input.contacts && input.contacts.length);
    const hasPoll = !!input.poll;
    const hasEvent = !!input.event;

    switch (kind) {
      case 'text':
        if (!hasText && !hasAttachments) {
          throw new BadRequestException('text messages require text or attachments');
        }
        break;

      case 'styled_text':
        if (!hasStyled) throw new BadRequestException('styled_text requires styledText payload');
        break;

      case 'voice':
        if (!hasVoice) throw new BadRequestException('voice requires voice payload');
        if (!hasAttachments) throw new BadRequestException('voice messages require attachments');
        break;

      case 'sticker':
        if (!hasSticker) throw new BadRequestException('sticker requires sticker payload');
        break;

      case 'contacts':
        if (!hasContacts) throw new BadRequestException('contacts requires contacts[] payload');
        break;

      case 'poll':
        if (!hasPoll) throw new BadRequestException('poll requires poll payload');
        break;

      case 'event':
        if (!hasEvent) throw new BadRequestException('event requires event payload');
        break;

      case 'system':
        if (!hasText) throw new BadRequestException('system requires text');
        break;

      default:
        throw new BadRequestException(`Unsupported kind: ${String(kind)}`);
    }

    if (kind !== 'styled_text' && hasStyled) throw new BadRequestException('styledText not allowed for this kind');
    if (kind !== 'voice' && hasVoice) throw new BadRequestException('voice not allowed for this kind');
    if (kind !== 'sticker' && hasSticker) throw new BadRequestException('sticker not allowed for this kind');
    if (kind !== 'contacts' && hasContacts) throw new BadRequestException('contacts not allowed for this kind');
    if (kind !== 'poll' && hasPoll) throw new BadRequestException('poll not allowed for this kind');
    if (kind !== 'event' && hasEvent) throw new BadRequestException('event not allowed for this kind');
  }

  private buildPreview(input: SendMessageDto): string | undefined {
    switch (input.kind) {
      case 'text':
        return input.text?.slice(0, 200);
      case 'styled_text':
        return input.styledText?.text?.slice(0, 200);
      case 'voice':
        return '🎤 Voice message';
      case 'sticker':
        return 'Sticker';
      case 'contacts':
        return `👤 Contact${(input.contacts?.length ?? 0) > 1 ? 's' : ''}`;
      case 'poll':
        return `📊 ${input.poll?.question ?? 'Poll'}`;
      case 'event':
        return `📅 ${input.event?.title ?? 'Event'}`;
      case 'system':
        return input.text?.slice(0, 200);
      default:
        return undefined;
    }
  }
}
