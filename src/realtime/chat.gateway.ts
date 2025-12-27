import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Logger, UseGuards } from '@nestjs/common';
import { WsException } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';

import { WsAuthGuard } from '../auth/ws-auth.guard';
import { SocketPrincipal, EVT, rooms } from '../chat/chat.types';

import { ReactionsService } from '../chat/features/reactions/reactions.service';
import { ReceiptsService } from '../chat/features/receipts/receipts.service';
import { SyncService } from '../chat/features/sync/sync.service';

import { DjangoConversationClient } from '../chat/integrations/django/django-conversation.client';
import { DjangoSeqClient } from '../chat/integrations/django/django-seq.client';
import { RateLimitService } from '../chat/infra/rate-limit/rate-limit.service';
import { PresenceService } from '../presence/presence.service';
import { MessageKind } from 'src/chat/features/messages/schemas/message.schema';
import { MessagesService } from 'src/chat/features/messages/messages.service';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

type JoinPayload = { conversationId: string };
type LeavePayload = { conversationId: string };

type SendPayload = {
  conversationId: string;
  clientId: string;
  kind: MessageKind;

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
};

type EditPayload = {
  conversationId: string;
  messageId: string;

  ciphertext?: string;
  encryptionMeta?: Record<string, any>;
  text?: string;
  attachments?: any[];
};

type DeletePayload = {
  conversationId: string;
  messageId: string;
  mode: 'deleted_for_me' | 'deleted_for_everyone';
};

type ReactionPayload = {
  conversationId: string;
  messageId: string;
  emoji: string;
  mode: 'add' | 'remove';
};

type ReceiptPayload = {
  conversationId: string;
  messageId: string;
  type: 'delivered' | 'read' | 'played';
  atMs?: number;
};

type TypingPayload = {
  conversationId: string;
  isTyping: boolean;
};

type GapCheckPayload = {
  conversationId: string;
  fromSeq: number;
  toSeq: number;
};

type CallOfferPayload = { conversationId: string; callId: string; toUserId: string; sdp: any };
type CallAnswerPayload = { conversationId: string; callId: string; toUserId: string; sdp: any };
type CallIcePayload = { conversationId: string; callId: string; toUserId: string; candidate: any };
type CallHangupPayload = { conversationId: string; callId: string; toUserId: string; reason?: string };

@WebSocketGateway({
  path: process.env.WS_PATH || '/ws',
  cors: { origin: (process.env.ORIGINS ?? '*').split(',') },
})
@UseGuards(WsAuthGuard)
export class ChatGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(ChatGateway.name);

  constructor(
    private readonly messages: MessagesService,
    private readonly reactions: ReactionsService,
    private readonly receipts: ReceiptsService,
    private readonly sync: SyncService,
    private readonly perms: DjangoConversationClient,
    private readonly seqClient: DjangoSeqClient,
    private readonly rate: RateLimitService,
    private readonly presence: PresenceService,
  ) {}

  async handleConnection(client: AuthedSocket) {
    const p = client.principal;
    if (!p?.userId) {
      client.disconnect(true);
      return;
    }

    client.join(rooms.userRoom(p.userId));
    this.presence.markOnline(p.userId);

    this.server.emit(EVT.PRESENCE, { userId: p.userId, state: 'online', at: Date.now() });
    this.logger.log(`connected user=${p.userId}`);
  }

  async handleDisconnect(client: AuthedSocket) {
    const p = client.principal;
    if (!p?.userId) return;

    this.presence.markOffline(p.userId);
    this.server.emit(EVT.PRESENCE, { userId: p.userId, state: 'offline', at: Date.now() });
    this.logger.log(`disconnected user=${p.userId}`);
  }

  @SubscribeMessage(EVT.JOIN)
  async onJoin(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: JoinPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'join');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);
      client.join(rooms.convRoom(payload.conversationId));

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.LEAVE)
  async onLeave(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: LeavePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'leave');

      client.leave(rooms.convRoom(payload.conversationId));
      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.SEND)
  async onSend(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: SendPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'send');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const seq = await this.seqClient.allocateSeq(payload.conversationId);

      const message = await this.messages.sendIdempotent({
        ...payload,
        senderId: p.userId,
        senderDeviceId: p.deviceId ?? 'device',
        seq,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(message);

      this.server.to(rooms.convRoom(payload.conversationId)).emit(EVT.MESSAGE, dto);
      this.server.to(rooms.userRoom(p.userId)).emit(EVT.MESSAGE, dto);

      return { ok: true, message: dto };
    });
  }

  @SubscribeMessage(EVT.EDIT)
  async onEdit(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: EditPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'edit');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.messages.editMessage({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        editorId: p.userId,
        editorDeviceId: p.deviceId ?? 'device',
        ciphertext: payload.ciphertext,
        encryptionMeta: payload.encryptionMeta,
        text: payload.text,
        attachments: payload.attachments,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      this.server.to(rooms.convRoom(payload.conversationId)).emit(EVT.MESSAGE_EDITED, dto);
      this.server.to(rooms.userRoom(p.userId)).emit(EVT.MESSAGE_EDITED, dto);

      return { ok: true, message: dto };
    });
  }

  @SubscribeMessage(EVT.DELETE)
  async onDelete(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: DeletePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'delete');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.messages.deleteMessage({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        requesterId: p.userId,
        mode: payload.mode,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      const eventPayload = {
        messageId: payload.messageId,
        conversationId: payload.conversationId,
        mode: payload.mode,
        deletedAt: updated.deletedAt ?? Date.now(),
        deletedBy: updated.deletedBy ?? p.userId,
        message: dto,
      };

      this.server.to(rooms.convRoom(payload.conversationId)).emit(EVT.MESSAGE_DELETED, eventPayload);
      this.server.to(rooms.userRoom(p.userId)).emit(EVT.MESSAGE_DELETED, eventPayload);

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.REACT)
  async onReact(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: ReactionPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'react');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.reactions.react({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        userId: p.userId,
        emoji: payload.emoji,
        mode: payload.mode,
        nowMs: Date.now(),
      });

      const dto = this.toMessageDTO(updated);

      const eventPayload = {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        reactions: dto.reactions ?? [],
      };

      this.server.to(rooms.convRoom(payload.conversationId)).emit(EVT.MESSAGE_REACTION, eventPayload);
      this.server.to(rooms.userRoom(p.userId)).emit(EVT.MESSAGE_REACTION, eventPayload);

      return { ok: true, reactions: dto.reactions ?? [] };
    });
  }

  @SubscribeMessage(EVT.RECEIPT)
  async onReceipt(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: ReceiptPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'receipt');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const updated = await this.receipts.addReceipt({
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        userId: p.userId,
        deviceId: p.deviceId ?? 'device',
        type: payload.type,
        atMs: payload.atMs,
      });

      const dto = this.toMessageDTO(updated);

      const eventPayload = {
        conversationId: payload.conversationId,
        messageId: payload.messageId,
        deliveredTo: dto.deliveredTo ?? [],
        readBy: dto.readBy ?? [],
        playedBy: dto.playedBy ?? [],
      };

      this.server.to(rooms.convRoom(payload.conversationId)).emit(EVT.MESSAGE_RECEIPT, eventPayload);
      this.server.to(rooms.userRoom(p.userId)).emit(EVT.MESSAGE_RECEIPT, eventPayload);

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.TYPING)
  async onTyping(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: TypingPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'typing');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      client.to(rooms.convRoom(payload.conversationId)).emit(EVT.TYPING, {
        conversationId: payload.conversationId,
        userId: p.userId,
        isTyping: !!payload.isTyping,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.GAP_CHECK)
  async onGapCheck(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: GapCheckPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'gap');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      const { missing, messages } = await this.sync.gapCheck(payload.conversationId, payload.fromSeq, payload.toSeq);
      const dtos = (messages ?? []).map((m: any) => this.toMessageDTO(m));

      if (dtos.length) {
        client.emit(EVT.GAP_FILL, {
          conversationId: payload.conversationId,
          fromSeq: payload.fromSeq,
          toSeq: payload.toSeq,
          messages: dtos,
        });
      }

      return { ok: true, missing: missing ?? [] };
    });
  }

  @SubscribeMessage(EVT.CALL_OFFER)
  async onCallOffer(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallOfferPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      this.server.to(rooms.userRoom(payload.toUserId)).emit(EVT.CALL_OFFER, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        sdp: payload.sdp,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.CALL_ANSWER)
  async onCallAnswer(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallAnswerPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      this.server.to(rooms.userRoom(payload.toUserId)).emit(EVT.CALL_ANSWER, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        sdp: payload.sdp,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.CALL_ICE)
  async onCallIce(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallIcePayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      this.server.to(rooms.userRoom(payload.toUserId)).emit(EVT.CALL_ICE, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        candidate: payload.candidate,
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  @SubscribeMessage(EVT.CALL_HANGUP)
  async onCallHangup(@ConnectedSocket() client: AuthedSocket, @MessageBody() payload: CallHangupPayload) {
    return this.safeAck(async () => {
      const p = this.requirePrincipal(client);
      this.rate.assert(p.userId, 'call');

      await this.perms.assertConversationMemberOrThrow(p.userId, payload.conversationId);

      this.server.to(rooms.userRoom(payload.toUserId)).emit(EVT.CALL_HANGUP, {
        fromUserId: p.userId,
        conversationId: payload.conversationId,
        callId: payload.callId,
        reason: payload.reason ?? 'hangup',
        at: Date.now(),
      });

      return { ok: true };
    });
  }

  private requirePrincipal(client: AuthedSocket): SocketPrincipal {
    const p = client.principal;
    if (!p?.userId) throw new WsException('unauthorized');
    return p;
  }

  private async safeAck<T>(fn: () => Promise<T>): Promise<T | { ok: false; code: string; message: string }> {
    try {
      return await fn();
    } catch (e: any) {
      const msg = typeof e?.message === 'string' ? e.message : 'error';
      const code = typeof e?.name === 'string' ? e.name : 'Error';
      return { ok: false, code, message: msg };
    }
  }

  private toMessageDTO(message: any) {
    return {
      id: String(message._id ?? message.id ?? message.serverId),
      conversationId: message.conversationId,
      seq: message.seq,
      clientId: message.clientId,
      senderId: message.senderId,
      senderDeviceId: message.senderDeviceId,
      kind: message.kind,

      ciphertext: message.ciphertext,
      encryptionMeta: message.encryptionMeta,

      text: message.text,
      attachments: message.attachments ?? [],

      reply: message.reply,
      forward: message.forward,
      mentions: message.mentions,
      linkPreview: message.linkPreview,
      poll: message.poll,
      ephemeral: message.ephemeral,

      edited: !!message.edited,
      editedAt: message.editedAt,
      deleteState: message.deleteState,
      deletedAt: message.deletedAt,
      deletedBy: message.deletedBy,

      reactions: message.reactions ?? [],
      deliveredTo: message.deliveredTo ?? [],
      readBy: message.readBy ?? [],
      playedBy: message.playedBy ?? [],

      createdAt: message.createdAt,
      updatedAt: message.updatedAt,
    };
  }
}
