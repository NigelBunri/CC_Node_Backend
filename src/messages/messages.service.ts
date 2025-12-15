// src/messages/messages.service.ts

import {
  Injectable,
  Logger,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
  AttachmentDto,
  SendMessageDto,
  VoiceDto,
  StyledTextDto,
  StickerDto,
  ContactDto,
} from './dto/send-message.dto';

import {
  MessageEntity,
  MessageDocument,
} from './schemas/message.schema';

import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

/* ========================================================================== */
/*                              PUBLIC MESSAGE TYPE                            */
/* ========================================================================== */

export type Message = {
  id: string;
  conversationId: string;
  senderId: string;
  senderName?: string | null;
  ciphertext?: string;
  createdAt: string;
  replyToId?: string | null;
  attachments?: AttachmentDto[];
  clientId?: string | null;

  kind?:
    | 'text'
    | 'voice'
    | 'styled_text'
    | 'sticker'
    | 'contacts'
    | 'poll'
    | 'event'
    | 'system';

  voice?: VoiceDto | null;
  styledText?: StyledTextDto | null;
  sticker?: StickerDto | null;
  contacts?: ContactDto[];
  poll?: any;
  event?: any;

  isDeleted?: boolean;
  isPinned?: boolean;
  status?: string;

  /**
   * TRUE only for the very first message in a conversation
   * (MongoDB is the authority)
   */
  isFirstMessage?: boolean;
};

/* ========================================================================== */
/*                               SERVICE CLASS                                 */
/* ========================================================================== */

@Injectable()
export class MessagesService {
  private readonly log = new Logger(MessagesService.name);

  constructor(
    @InjectModel(MessageEntity.name)
    private readonly model: Model<MessageDocument>,
    private readonly http: HttpService,
  ) {}

  /* ======================================================================== */
  /*                               UTILITIES                                   */
  /* ======================================================================== */

  /**
   * Generates a guaranteed unique server-side clientId
   * Used ONLY when the frontend fails to send one.
   */
  private generateServerClientId(): string {
    const id = `srv_${Date.now()}_${Math.random()
      .toString(36)
      .slice(2, 10)}`;

    this.log.warn(
      `[clientId] missing → generated server clientId=${id}`,
    );

    return id;
  }

  /**
   * Safely converts Mongo document to public Message type
   */
  private mapDocToMessage(doc: any): Message {
    const createdAtIso =
      doc.createdAt instanceof Date
        ? doc.createdAt.toISOString()
        : new Date().toISOString();

    return {
      id: doc._id.toString(),
      conversationId: doc.conversationId,
      senderId: doc.senderId,
      senderName: doc.senderName ?? null,
      ciphertext: doc.ciphertext,
      createdAt: createdAtIso,
      replyToId: doc.replyToId ?? null,
      attachments: doc.attachments ?? [],
      clientId: doc.clientId ?? null,
      kind: doc.kind,
      voice: doc.voice ?? null,
      styledText: doc.styledText ?? null,
      sticker: doc.sticker ?? null,
      contacts: doc.contacts ?? [],
      poll: doc.poll ?? null,
      event: doc.event ?? null,
      isDeleted: doc.isDeleted ?? false,
      isPinned: doc.isPinned ?? false,
      status: doc.status,
      isFirstMessage: doc.isFirstMessage ?? false,
    };
  }

  /* ======================================================================== */
  /*                           COUNTING / HELPERS                               */
  /* ======================================================================== */

  /**
   * Authoritative count of messages in a conversation.
   * MongoDB is the source of truth.
   */
  async countByConversation(
    conversationId: string,
  ): Promise<number> {
    const count = await this.model
      .countDocuments({
        conversationId,
        isDeleted: { $ne: true },
      })
      .exec();

    this.log.debug(
      `[count] conv=${conversationId} count=${count}`,
    );

    return count;
  }

  /* ======================================================================== */
  /*                         DJANGO LAST MESSAGE SYNC                           */
  /* ======================================================================== */

  /**
   * Builds a safe preview string for Django
   */
  private buildLastMessagePreview(
    message: Message,
  ): string {
    if (message.isDeleted) return '';

    const text = (message.ciphertext ?? '').trim();
    if (text) {
      return text.length > 240
        ? text.slice(0, 240) + '…'
        : text;
    }

    switch (message.kind) {
      case 'voice':
        return '[Voice message]';
      case 'styled_text':
        return '[Styled message]';
      case 'sticker':
        return '[Sticker]';
      case 'contacts':
        return '[Contact]';
      case 'poll':
        return '[Poll]';
      case 'event':
        return '[Event]';
      case 'system':
        return '[System]';
      default:
        return '[Message]';
    }
  }

  /**
   * Fire-and-forget sync to Django
   */
  private async updateConversationLastMessage(
    message: Message,
    userToken?: string | null,
  ): Promise<void> {
    const base = process.env.DJANGO_BASE_URL;

    if (!base || !userToken) {
      this.log.debug(
        `[django-sync] skipped conv=${message.conversationId}`,
      );
      return;
    }

    const url = `${base.replace(/\/+$/, '')}/api/v1/chat/conversations/${
      message.conversationId
    }/update-last-message/`;

    try {
      this.log.debug(
        `[django-sync] PATCH conv=${message.conversationId} msg=${message.id}`,
      );

      await firstValueFrom(
        this.http.patch(
          url,
          {
            last_message_at: message.createdAt,
            last_message_preview:
              this.buildLastMessagePreview(message),
          },
          {
            headers: {
              Authorization: `Bearer ${userToken}`,
              'Content-Type': 'application/json',
            },
            timeout: 7000,
          },
        ),
      );

      this.log.debug(
        `[django-sync] success conv=${message.conversationId}`,
      );
    } catch (err) {
      this.log.warn(
        `[django-sync] failed conv=${message.conversationId} err=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  /* ======================================================================== */
  /*                                   SAVE                                    */
  /* ======================================================================== */

  /**
   * Saves a message with:
   *  - hard idempotency
   *  - race-condition safety
   *  - guaranteed clientId
   *  - exhaustive logging
   */
  async save(
    userId: string,
    dto: SendMessageDto,
    userToken?: string | null,
  ): Promise<Message> {
    /* -------------------------------------------------------------------- */
    /* STEP 0: NORMALIZE INPUT                                               */
    /* -------------------------------------------------------------------- */

    const clientId =
      dto.clientId ?? this.generateServerClientId();

    this.log.debug(
      `[save:start] user=${userId} conv=${dto.conversationId} clientId=${clientId}`,
    );

    /* -------------------------------------------------------------------- */
    /* STEP 1: FIRST-MESSAGE DETECTION (AUTHORITATIVE)                       */
    /* -------------------------------------------------------------------- */

    const existingCount =
      await this.countByConversation(
        dto.conversationId,
      );

    const isFirstMessage = existingCount === 0;

    this.log.debug(
      `[save:state] conv=${dto.conversationId} count=${existingCount} isFirstMessage=${isFirstMessage}`,
    );

    /* -------------------------------------------------------------------- */
    /* STEP 2: IDEMPOTENCY CHECK                                             */
    /* -------------------------------------------------------------------- */

    this.log.debug(
      `[save:idempotency] checking existing clientId=${clientId}`,
    );

    const existing = await this.model.findOne({
      conversationId: dto.conversationId,
      senderId: userId,
      clientId,
    });

    if (existing) {
      this.log.warn(
        `[save:idempotency] HIT existing msg=${existing._id}`,
      );

      return this.mapDocToMessage(existing);
    }

    /* -------------------------------------------------------------------- */
    /* STEP 3: CREATE MESSAGE                                                */
    /* -------------------------------------------------------------------- */

    this.log.debug(
      `[save:create] inserting new message conv=${dto.conversationId}`,
    );

    try {
      const doc = await this.model.create({
        conversationId: dto.conversationId,
        senderId: userId,
        senderName: dto.senderName ?? null,
        ciphertext: dto.ciphertext ?? '',
        replyToId: dto.replyToId ?? null,
        attachments: dto.attachments ?? [],
        clientId,
        kind: dto.kind ?? 'text',
        voice: dto.voice ?? null,
        styledText: dto.styledText ?? null,
        sticker: dto.sticker ?? null,
        contacts: dto.contacts ?? [],
        poll: dto.poll ?? null,
        event: dto.event ?? null,
        createdAt: new Date(),
        isFirstMessage,
      });

      this.log.log(
        `[save:success] msg=${doc._id.toString()} conv=${dto.conversationId}`,
      );

      const message = this.mapDocToMessage(doc);

      // Async side-effect
      this.updateConversationLastMessage(
        message,
        userToken,
      ).catch(() => {});

      return message;
    } catch (err: any) {
      /* ------------------------------------------------------------------ */
      /* STEP 4: DUPLICATE SAFETY (RACE CONDITION)                           */
      /* ------------------------------------------------------------------ */

      if (err?.code === 11000) {
        this.log.error(
          `[save:race] duplicate key detected → refetching clientId=${clientId}`,
        );

        const retry = await this.model.findOne({
          conversationId: dto.conversationId,
          senderId: userId,
          clientId,
        });

        if (retry) {
          this.log.warn(
            `[save:race] recovered existing msg=${retry._id}`,
          );
          return this.mapDocToMessage(retry);
        }
      }

      this.log.error(
        `[save:fatal] failed to save message`,
        err,
      );

      throw new InternalServerErrorException(
        'Failed to save message',
      );
    }
  }

  /* ======================================================================== */
  /*                                  HISTORY                                  */
  /* ======================================================================== */

  async history(
    conversationId: string,
    limit = 30,
  ): Promise<Message[]> {
    this.log.debug(
      `[history:start] conv=${conversationId} limit=${limit}`,
    );

    const safeLimit = Math.min(
      Math.max(limit, 1),
      200,
    );

    const docs = await this.model
      .find({ conversationId })
      .sort({ _id: -1 })
      .limit(safeLimit)
      .lean()
      .exec();

    this.log.debug(
      `[history:done] conv=${conversationId} returned=${docs.length}`,
    );

    return docs
      .reverse()
      .map((d: any) => this.mapDocToMessage(d));
  }
}
