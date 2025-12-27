// src/chat/integrations/django/django-conversation.client.ts
import { Injectable, ForbiddenException } from '@nestjs/common';
import axios from 'axios';
import https from 'https';
import { ConversationPermission } from '../../chat.types';

/**
 * DjangoConversationClient
 *
 * Purpose:
 * - Membership/blocked/role checks for a conversation.
 * - Keeps ChatGateway/services clean.
 *
 * You MUST wire this to your Django API.
 *
 * Environment variables (example):
 * - DJANGO_CONV_PERMS_URL="https://django/api/chat/conversations/{conversationId}/ws-perms/"
 * - DJANGO_INTERNAL_TOKEN="..."
 * - DJANGO_TLS_INSECURE="1" (optional dev only)
 */
function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

@Injectable()
export class DjangoConversationClient {
  async assertConversationMemberOrThrow(userId: string, conversationId: string): Promise<ConversationPermission> {
    const raw = process.env.DJANGO_CONV_PERMS_URL;
    if (!raw) {
      // Hard-fail if you prefer; for now, assume allowed in dev.
      return { isMember: true, isBlocked: false, role: 'member' };
    }

    const url = ensureTrailingSlash(raw.replace('{conversationId}', encodeURIComponent(conversationId)));
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;
    const allowSelfSigned = (process.env.DJANGO_TLS_INSECURE ?? '0') === '1';

    const httpsAgent = url.startsWith('https')
      ? new https.Agent({ rejectUnauthorized: !allowSelfSigned })
      : undefined;

    const { data } = await axios.get(url, {
      params: { userId },
      headers: {
        'X-Internal-Auth': internal,
        Accept: 'application/json',
      },
      timeout: 4000,
      httpsAgent,
    });

    const perm: ConversationPermission = {
      isMember: !!data?.isMember,
      isBlocked: !!data?.isBlocked,
      role: (data?.role as any) ?? 'member',
      scopes: Array.isArray(data?.scopes) ? data.scopes : undefined,
    };

    if (!perm.isMember) throw new ForbiddenException('Not a conversation member');
    if (perm.isBlocked) throw new ForbiddenException('You are blocked from this conversation');

    return perm;
  }
}
