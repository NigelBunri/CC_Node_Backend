import { Server, Socket } from 'socket.io';

import { rooms, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { requirePrincipal } from './utils';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export const CALL_EVT = {
  CALL_OFFER: 'call.offer',
  CALL_ANSWER: 'call.answer',
  CALL_ICE: 'call.ice',
  CALL_HANGUP: 'call.hangup',
} as const;

export type CallOfferPayload = {
  conversationId: string;
  callId: string;
  toUserId: string;
  sdp: any;
};

export type CallAnswerPayload = {
  conversationId: string;
  callId: string;
  toUserId: string;
  sdp: any;
};

export type CallIcePayload = {
  conversationId: string;
  callId: string;
  toUserId: string;
  candidate: any;
};

export type CallHangupPayload = {
  conversationId: string;
  callId: string;
  toUserId: string;
  reason?: string;
};

export async function onCallOffer(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: CallOfferPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'call');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.server.to(rooms.userRoom(ctx.payload.toUserId)).emit(CALL_EVT.CALL_OFFER, {
    fromUserId: principal.userId,
    conversationId: ctx.payload.conversationId,
    callId: ctx.payload.callId,
    sdp: ctx.payload.sdp,
    at: Date.now(),
  });

  return { ok: true };
}

export async function onCallAnswer(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: CallAnswerPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'call');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.server.to(rooms.userRoom(ctx.payload.toUserId)).emit(CALL_EVT.CALL_ANSWER, {
    fromUserId: principal.userId,
    conversationId: ctx.payload.conversationId,
    callId: ctx.payload.callId,
    sdp: ctx.payload.sdp,
    at: Date.now(),
  });

  return { ok: true };
}

export async function onCallIce(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: CallIcePayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'call');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.server.to(rooms.userRoom(ctx.payload.toUserId)).emit(CALL_EVT.CALL_ICE, {
    fromUserId: principal.userId,
    conversationId: ctx.payload.conversationId,
    callId: ctx.payload.callId,
    candidate: ctx.payload.candidate,
    at: Date.now(),
  });

  return { ok: true };
}

export async function onCallHangup(ctx: {
  server: Server;
  client: AuthedSocket;
  payload: CallHangupPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'call');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  ctx.server.to(rooms.userRoom(ctx.payload.toUserId)).emit(CALL_EVT.CALL_HANGUP, {
    fromUserId: principal.userId,
    conversationId: ctx.payload.conversationId,
    callId: ctx.payload.callId,
    reason: ctx.payload.reason ?? 'hangup',
    at: Date.now(),
  });

  return { ok: true };
}
