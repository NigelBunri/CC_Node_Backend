// src/chat/features/messages/messages.service.ts
import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, FilterQuery, Types } from 'mongoose';
import { Message, MessageDocument, MessageKind } from 'src/chat/features/messages/schemas/message.schema';

export type SendMessageInput = {
  conversationId: string;
  clientId: string;

  senderId: string;
  senderDeviceId: string;

  kind: MessageKind;
  seq: number;

  ciphertext?: string;
  encryptionMeta?: Record<string, any>;
  text?: string;

  attachments?: any[];
  reply?: any;
  forward?: any;
  mentions?: any;
  ephemeral?: any;
  linkPreview?: any;
  poll?: any;

  nowMs?: number;
};

export type EditMessageInput = {
  conversationId: string;
  messageId: string;
  editorId: string;
  editorDeviceId: string;

  ciphertext?: string;
  encryptionMeta?: Record<string, any>;
  text?: string;
  attachments?: any[];

  nowMs?: number;
};

export type DeleteMessageInput = {
  conversationId: string;
  messageId: string;
  requesterId: string;
  mode: 'deleted_for_me' | 'deleted_for_everyone';
  nowMs?: number;
};

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);

  constructor(@InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>) {}

  /**
   * Idempotent send: (conversationId, clientId) unique.
   * seq must be allocated atomically by Django (or by Nest if you later move it).
   */
  async sendIdempotent(input: SendMessageInput): Promise<MessageDocument> {
    const now = input.nowMs ?? Date.now();
    this.validateSendInput(input);

    const existing = await this.messageModel.findOne({
      conversationId: input.conversationId,
      clientId: input.clientId,
    });
    if (existing) return existing;

    const doc: Partial<Message> = {
      conversationId: input.conversationId,
      seq: input.seq,
      clientId: input.clientId,
      senderId: input.senderId,
      senderDeviceId: input.senderDeviceId,
      kind: input.kind,

      ciphertext: input.ciphertext,
      encryptionMeta: input.encryptionMeta,
      text: input.text,

      attachments: input.attachments ?? [],
      reply: input.reply,
      forward: input.forward,
      mentions: input.mentions,
      linkPreview: input.linkPreview,
      poll: input.poll ? { ...input.poll, votes: {} } : undefined,

      ephemeral: input.ephemeral ? this.computeEphemeral(input.ephemeral, now) : undefined,

      edited: false,
      deleteState: 'none',
      reactions: [],
      deliveredTo: [],
      readBy: [],
      playedBy: [],
      flags: [],
      searchText: this.computeSearchText(input),
    };

    try {
      return await this.messageModel.create(doc);
    } catch (err: any) {
      // Handle retry races gracefully
      const maybe = await this.messageModel.findOne({
        conversationId: input.conversationId,
        clientId: input.clientId,
      });
      if (maybe) return maybe;

      this.logger.error(`sendIdempotent failed: ${err?.message ?? err}`, err?.stack);
      throw err;
    }
  }

  async editMessage(input: EditMessageInput): Promise<MessageDocument> {
    const now = input.nowMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(input.messageId),
      conversationId: input.conversationId,
    });
    if (!msg) throw new NotFoundException('Message not found');

    if (msg.senderId !== input.editorId) throw new ForbiddenException('Only sender can edit');
    if (msg.deleteState === 'deleted_for_everyone') throw new BadRequestException('Cannot edit deleted message');

    if (input.ciphertext !== undefined) msg.ciphertext = input.ciphertext;
    if (input.encryptionMeta !== undefined) msg.encryptionMeta = input.encryptionMeta;
    if (input.text !== undefined) msg.text = input.text;
    if (input.attachments !== undefined) msg.attachments = input.attachments as any;

    msg.edited = true;
    msg.editedAt = now;
    msg.searchText = this.computeSearchText({ ciphertext: msg.ciphertext, text: msg.text } as any);

    await msg.save();
    return msg;
  }

  async deleteMessage(input: DeleteMessageInput): Promise<MessageDocument> {
    const now = input.nowMs ?? Date.now();

    const msg = await this.messageModel.findOne({
      _id: new Types.ObjectId(input.messageId),
      conversationId: input.conversationId,
    });
    if (!msg) throw new NotFoundException('Message not found');

    if (input.mode === 'deleted_for_everyone') {
      if (msg.senderId !== input.requesterId) throw new ForbiddenException('Only sender can delete for everyone');

      msg.deleteState = 'deleted_for_everyone';
      msg.deletedAt = now;
      msg.deletedBy = input.requesterId;

      // Tombstone
      msg.text = undefined;
      msg.ciphertext = undefined;
      msg.attachments = [];
      msg.linkPreview = undefined;
      msg.poll = undefined;
      msg.reply = undefined;
      msg.mentions = undefined;
      msg.forward = undefined;
      msg.searchText = undefined;

      await msg.save();
      return msg;
    }

    // deleted_for_me is per-user; implement later via UserMessageState feature.
    return msg;
  }

  async getRange(conversationId: string, fromSeq: number, toSeq: number) {
    if (fromSeq > toSeq) throw new BadRequestException('Invalid range');
    return this.messageModel
      .find({ conversationId, seq: { $gte: fromSeq, $lte: toSeq } })
      .sort({ seq: 1 });
  }

  async findMissingSeqs(conversationId: string, fromSeq: number, toSeq: number): Promise<number[]> {
    const msgs = await this.getRange(conversationId, fromSeq, toSeq);
    const present = new Set(msgs.map((m) => m.seq));
    const missing: number[] = [];
    for (let s = fromSeq; s <= toSeq; s++) if (!present.has(s)) missing.push(s);
    return missing;
  }

  // -------- helpers --------

  private validateSendInput(input: SendMessageInput) {
    if (!input.conversationId) throw new BadRequestException('conversationId required');
    if (!input.clientId) throw new BadRequestException('clientId required');
    if (!input.senderId) throw new BadRequestException('senderId required');
    if (!input.senderDeviceId) throw new BadRequestException('senderDeviceId required');
    if (!input.kind) throw new BadRequestException('kind required');
    if (typeof input.seq !== 'number') throw new BadRequestException('seq required');

    if (input.kind === MessageKind.TEXT) {
      if (!input.ciphertext && !input.text) throw new BadRequestException('Text requires ciphertext or text');
    }

    if (
      input.kind === MessageKind.MEDIA ||
      input.kind === MessageKind.VOICE ||
      input.kind === MessageKind.STICKER
    ) {
      if (!input.attachments?.length && !input.ciphertext) {
        throw new BadRequestException('Media-like requires attachments or ciphertext');
      }
    }

    if (input.kind === MessageKind.POLL) {
      if (!input.poll?.question || !input.poll.options?.length) {
        throw new BadRequestException('Poll requires question and options');
      }
    }
  }

  private computeEphemeral(ephemeral: any, now: number) {
    const enabled = !!ephemeral.enabled;
    const ttlSeconds = ephemeral.ttlSeconds;
    const startAfterRead = !!ephemeral.startAfterRead;

    const out = { enabled, ttlSeconds, startAfterRead, expireAt: undefined as number | undefined };
    if (enabled && ttlSeconds && !startAfterRead) out.expireAt = now + ttlSeconds * 1000;
    return out;
  }

  private computeSearchText(input: Partial<SendMessageInput>): string | undefined {
    // If ciphertext exists (E2EE), do not store searchable content.
    if (input.ciphertext) return undefined;
    const raw = (input.text ?? '').trim();
    if (!raw) return undefined;
    return raw.toLowerCase();
  }
}
