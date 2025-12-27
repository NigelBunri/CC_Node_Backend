import { Server, Socket } from 'socket.io';

import { EVT, rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { DjangoSeqClient } from '../../chat/integrations/django/django-seq.client';

import { MessagesService } from '../../chat/features/messages/messages.service';

import { SendPayload as DomainSendPayload, EditPayload as DomainEditPayload, DeletePayload as DomainDeletePayload } from '../../chat/features/messages/messages.dto';
import { requirePrincipal, resolveDeviceId } from './utils';
import { MessageKind } from 'src/chat/features/messages/schemas/message.schema';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export type WsSendPayload = DomainSendPayload;

export type WsEditPayload = DomainEditPayload;

export type WsDeletePayload = DomainDeletePayload;

function toMessageDTO(message: any) {
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

export async function onSend(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsSendPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  seqClient: DjangoSeqClient;
  messages: MessagesService;
}) {
  const principal = requirePrincipal(ctx.client);
  const deviceId = resolveDeviceId(ctx.client);

  ctx.limiter.assert(principal.userId, 'send');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const seq = await ctx.seqClient.allocateSeq(ctx.payload.conversationId);

  const message = await ctx.messages.sendIdempotent({
    conversationId: ctx.payload.conversationId,
    clientId: ctx.payload.clientId,
    senderId: principal.userId,
    senderDeviceId: deviceId,
    kind: ctx.payload.kind as unknown as MessageKind,
    seq,
    ciphertext: ctx.payload.ciphertext,
    encryptionMeta: ctx.payload.encryptionMeta,
    text: ctx.payload.text,
    attachments: ctx.payload.attachments,
    reply: ctx.payload.reply,
    forward: ctx.payload.forward,
    mentions: ctx.payload.mentions,
    ephemeral: ctx.payload.ephemeral,
    linkPreview: ctx.payload.linkPreview,
    poll: ctx.payload.poll,
    nowMs: Date.now(),
  });

  const dto = toMessageDTO(message);

  ctx.server.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.MESSAGE, dto);
  ctx.server.to(rooms.userRoom(principal.userId)).emit(EVT.MESSAGE, dto);

  return { ok: true, message: dto };
}

export async function onEdit(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsEditPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  messages: MessagesService;
}) {
  const principal = requirePrincipal(ctx.client);
  const deviceId = resolveDeviceId(ctx.client);

  ctx.limiter.assert(principal.userId, 'edit');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const updated = await ctx.messages.editMessage({
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    editorId: principal.userId,
    editorDeviceId: deviceId,
    ciphertext: ctx.payload.ciphertext,
    encryptionMeta: ctx.payload.encryptionMeta,
    text: ctx.payload.text,
    attachments: ctx.payload.attachments,
    nowMs: Date.now(),
  });

  const dto = toMessageDTO(updated);

  ctx.server.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.MESSAGE_EDITED, dto);
  ctx.server.to(rooms.userRoom(principal.userId)).emit(EVT.MESSAGE_EDITED, dto);

  return { ok: true, message: dto };
}

export async function onDelete(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsDeletePayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  messages: MessagesService;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'delete');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const updated = await ctx.messages.deleteMessage({
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    requesterId: principal.userId,
    mode: ctx.payload.mode,
    nowMs: Date.now(),
  });

  const dto = toMessageDTO(updated);

  const eventPayload = {
    messageId: ctx.payload.messageId,
    conversationId: ctx.payload.conversationId,
    mode: ctx.payload.mode,
    deletedAt: updated.deletedAt ?? Date.now(),
    deletedBy: updated.deletedBy ?? principal.userId,
    message: dto,
  };

  ctx.server.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.MESSAGE_DELETED, eventPayload);
  ctx.server.to(rooms.userRoom(principal.userId)).emit(EVT.MESSAGE_DELETED, eventPayload);

  return { ok: true };
}
