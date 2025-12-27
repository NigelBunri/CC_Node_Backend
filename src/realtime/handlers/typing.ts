import { Server, Socket } from 'socket.io';

import { EVT, rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';

import { requirePrincipal } from './utils';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export type WsTypingPayload = {
  conversationId: string;
  isTyping: boolean;
};

export async function onTyping(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsTypingPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'typing');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.client.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.TYPING, {
    conversationId: ctx.payload.conversationId,
    userId: principal.userId,
    isTyping: !!ctx.payload.isTyping,
    at: Date.now(),
  });

  return { ok: true };
}
