// src/chat/integrations/django/django-conversation.client.ts

import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import { ConversationPermission, SocketPrincipal } from '../../chat.types';

function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

@Injectable()
export class DjangoConversationClient {
  async assertConversationMemberOrThrow(userId: string, conversationId: string) {
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;
    const rawUrl = process.env.DJANGO_CONV_PERMS_URL!;
    const url = ensureTrailingSlash(rawUrl).replace('{conversationId}', conversationId);

    const { data } = await axios.get(url, {
      headers: { 'X-Internal-Auth': internal, Accept: 'application/json', 'X-User-Id': userId },
      timeout: 4000,
    });

    // Accept either {isMember:true} or Django-like payload
    const isMember = Boolean(data?.isMember ?? data?.member ?? data?.ok);
    const isBlocked = Boolean(data?.isBlocked ?? data?.blocked);
    const dmState = (data?.dmState ?? data?.dm_state) as ConversationPermission['dmState'] | undefined;

    if (!isMember || isBlocked || dmState === 'pending') {
      throw new UnauthorizedException('Not allowed');
    }
  }

  // ✅ handlers/messages.ts expects wsPerms(...)
  async wsPerms(conversationId: string, principal: SocketPrincipal): Promise<ConversationPermission> {
    try {
      await this.assertConversationMemberOrThrow(principal.userId, conversationId);
      return { isMember: true, isBlocked: false, dmState: 'accepted', scopes: principal.scopes };
    } catch {
      return { isMember: false, isBlocked: true };
    }
  }
}
