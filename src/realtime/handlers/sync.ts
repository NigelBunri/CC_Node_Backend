import { Socket } from 'socket.io';

import { EVT, SocketPrincipal } from '../../chat/chat.types';
import { RateLimitService } from '../../chat/infra/rate-limit/rate-limit.service';
import { DjangoConversationClient } from '../../chat/integrations/django/django-conversation.client';
import { SyncService } from '../../chat/features/sync/sync.service';

import { requirePrincipal } from './utils';

type AuthedSocket = Socket & { principal?: SocketPrincipal };

export type WsGapCheckPayload = {
  conversationId: string;
  fromSeq: number;
  toSeq: number;
};

export async function onGapCheck(ctx: {
  client: AuthedSocket;
  payload: WsGapCheckPayload;
  limiter: RateLimitService;
  convClient: DjangoConversationClient;
  sync: SyncService;
}) {
  const principal = requirePrincipal(ctx.client);

  ctx.limiter.assert(principal.userId, 'gap');
  await ctx.convClient.assertConversationMemberOrThrow(principal.userId, ctx.payload.conversationId);

  const out = await ctx.sync.gapCheck(ctx.payload.conversationId, ctx.payload.fromSeq, ctx.payload.toSeq);

  if (out.missing?.length) {
    const dtos = (out.messages ?? []).map((m: any) => ({
      id: String(m._id ?? m.id ?? m.serverId),
      conversationId: m.conversationId,
      seq: m.seq,
      clientId: m.clientId,
      senderId: m.senderId,
      senderDeviceId: m.senderDeviceId,
      kind: m.kind,
      ciphertext: m.ciphertext,
      encryptionMeta: m.encryptionMeta,
      text: m.text,
      attachments: m.attachments ?? [],
      reply: m.reply,
      forward: m.forward,
      mentions: m.mentions,
      linkPreview: m.linkPreview,
      poll: m.poll,
      ephemeral: m.ephemeral,
      edited: !!m.edited,
      editedAt: m.editedAt,
      deleteState: m.deleteState,
      deletedAt: m.deletedAt,
      deletedBy: m.deletedBy,
      reactions: m.reactions ?? [],
      deliveredTo: m.deliveredTo ?? [],
      readBy: m.readBy ?? [],
      playedBy: m.playedBy ?? [],
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    }));

    ctx.client.emit(EVT.GAP_FILL, {
      conversationId: ctx.payload.conversationId,
      fromSeq: ctx.payload.fromSeq,
      toSeq: ctx.payload.toSeq,
      messages: dtos,
    });
  }

  return { ok: true, missing: out.missing ?? [] };
}
