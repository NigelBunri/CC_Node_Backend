import { Server, Socket } from 'socket.io';

import { EVT, rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { ReceiptsService } from '../../chat/features/receipts/receipts.service';

import { requirePrincipal, resolveDeviceId } from './utils';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export type WsReceiptPayload = {
  conversationId: string;
  messageId: string;
  type: 'delivered' | 'read' | 'played';
  atMs?: number;
};

function toReceiptDTO(message: any) {
  return {
    deliveredTo: message.deliveredTo ?? [],
    readBy: message.readBy ?? [],
    playedBy: message.playedBy ?? [],
  };
}

export async function onReceipt(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsReceiptPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  receipts: ReceiptsService;
}) {
  const principal = requirePrincipal(ctx.client);
  const deviceId = resolveDeviceId(ctx.client);

  ctx.limiter.assert(principal.userId, 'receipt');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const updated = await ctx.receipts.addReceipt({
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    userId: principal.userId,
    deviceId,
    type: ctx.payload.type,
    atMs: ctx.payload.atMs,
  });

  const dto = toReceiptDTO(updated);

  const eventPayload = {
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    deliveredTo: dto.deliveredTo,
    readBy: dto.readBy,
    playedBy: dto.playedBy,
  };

  ctx.server.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.MESSAGE_RECEIPT, eventPayload);
  ctx.server.to(rooms.userRoom(principal.userId)).emit(EVT.MESSAGE_RECEIPT, eventPayload);

  return { ok: true };
}
