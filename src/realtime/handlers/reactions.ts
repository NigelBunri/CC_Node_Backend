import { Server, Socket } from 'socket.io';

import { EVT, rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { ReactionsService } from '../../chat/features/reactions/reactions.service';

import { requirePrincipal } from './utils';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export type WsReactionPayload = {
  conversationId: string;
  messageId: string;
  emoji: string;
  mode: 'add' | 'remove';
};

function toMessageDTO(message: any) {
  return {
    reactions: message.reactions ?? [],
  };
}

export async function onReact(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: WsReactionPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  reactions: ReactionsService;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'react');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const updated = await ctx.reactions.react({
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    userId: principal.userId,
    emoji: ctx.payload.emoji,
    mode: ctx.payload.mode,
    nowMs: Date.now(),
  });

  const dto = toMessageDTO(updated);

  const eventPayload = {
    conversationId: ctx.payload.conversationId,
    messageId: ctx.payload.messageId,
    reactions: dto.reactions,
  };

  ctx.server.to(rooms.convRoom(ctx.payload.conversationId)).emit(EVT.MESSAGE_REACTION, eventPayload);
  ctx.server.to(rooms.userRoom(principal.userId)).emit(EVT.MESSAGE_REACTION, eventPayload);

  return { ok: true, reactions: dto.reactions };
}
