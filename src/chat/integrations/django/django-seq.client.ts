// src/chat/integrations/django/django-seq.client.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import https from 'https';

/**
 * DjangoSeqClient
 *
 * Purpose:
 * - Allocate monotonic seq numbers per conversation via Django (atomic).
 *
 * Environment variables (example):
 * - DJANGO_ALLOCATE_SEQ_URL="https://django/api/chat/conversations/{conversationId}/allocate-seq/"
 * - DJANGO_INTERNAL_TOKEN="..."
 * - DJANGO_TLS_INSECURE="1" (optional dev only)
 */
function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

@Injectable()
export class DjangoSeqClient {
  async allocateSeq(conversationId: string): Promise<number> {
    const raw = process.env.DJANGO_ALLOCATE_SEQ_URL;
    if (!raw) {
      // Fail loudly so you never ship with a placeholder.
      throw new Error('DJANGO_ALLOCATE_SEQ_URL is not set');
    }

    const url = ensureTrailingSlash(raw.replace('{conversationId}', encodeURIComponent(conversationId)));
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;
    const allowSelfSigned = (process.env.DJANGO_TLS_INSECURE ?? '0') === '1';

    const httpsAgent = url.startsWith('https')
      ? new https.Agent({ rejectUnauthorized: !allowSelfSigned })
      : undefined;

    const { data } = await axios.post(url, null, {
      headers: {
        'X-Internal-Auth': internal,
        Accept: 'application/json',
      },
      timeout: 4000,
      httpsAgent,
    });

    const seq = Number(data?.seq);
    if (!Number.isFinite(seq) || seq <= 0) {
      throw new Error(`Invalid seq from Django: ${JSON.stringify(data)}`);
    }
    return seq;
  }
}
