import { Socket } from 'socket.io';
import { rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { requirePrincipal } from './utils';

export type JoinPayload = { conversationId: string };
export type LeavePayload = { conversationId: string };

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export async function onJoin(ctx: {
  client: AuthedSocket;
  payload: JoinPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);
  ctx.limiter.assert(principal.userId, 'join');

  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.client.join(rooms.convRoom(ctx.payload.conversationId));
  return { ok: true };
}

export async function onLeave(ctx: {
  client: AuthedSocket;
  payload: LeavePayload;
  limiter: RateLimitService;
}) {
  const principal = requirePrincipal(ctx.client);
  ctx.limiter.assert(principal.userId, 'leave');

  ctx.client.leave(rooms.convRoom(ctx.payload.conversationId));
  return { ok: true };
}
