import { Injectable, UnauthorizedException } from '@nestjs/common';
import axios, { AxiosError } from 'axios';
import https from 'https';

export type AuthPrincipal = {
  userId: string;
  username: string;
  isPremium: boolean;
  deviceId?: string;
  scopes?: string[];
};

function redact(token: string) {
  if (!token) return '';
  return token.length <= 10 ? '***' : token.slice(0, 6) + '…' + token.slice(-4);
}

function ensureTrailingSlash(u: string) {
  return u.endsWith('/') ? u : u + '/';
}

@Injectable()
export class DjangoAuthService {
  async introspect(token: string): Promise<AuthPrincipal> {
    const rawUrl = process.env.DJANGO_INTROSPECT_URL!;
    const url = ensureTrailingSlash(rawUrl); // avoid 301 hops
    const internal = process.env.DJANGO_INTERNAL_TOKEN!;
    const scheme = (process.env.DJANGO_AUTH_SCHEME ?? 'Bearer').trim(); // Bearer or JWT
    const allowSelfSigned = (process.env.DJANGO_TLS_INSECURE ?? '0') === '1';

    const httpsAgent = url.startsWith('https')
      ? new https.Agent({ rejectUnauthorized: !allowSelfSigned })
      : undefined;

    try {
      const { data, status } = await axios.get(url, {
        headers: {
          Authorization: `${scheme} ${token}`,
          'X-Internal-Auth': internal,
          Accept: 'application/json',
        },
        timeout: 4000,
        httpsAgent,
      });

      // ---- Map Django payload -> AuthPrincipal ----
      // Your Django returns: { id, email, username, display_name, tier, entitlements, ... }
      const userId = String(data?.userId ?? data?.id ?? '');
      if (!userId) {
        // Log once with details to help debugging schemas
        console.error('Introspection success 200 but no user id field found', {
          status,
          keys: data ? Object.keys(data) : [],
        });
        throw new UnauthorizedException('Invalid token payload');
      }

      const username =
        String(
          data?.username ??
          data?.display_name ??
          (data?.email ? data.email.split('@')[0] : '') ??
          'user'
        );

      // Basic heuristic for premium
      const isPremium =
        Boolean(
          data?.isPremium ??
          (typeof data?.tier === 'string' && data.tier.toLowerCase() !== 'basic') ??
          data?.entitlements?.premium === true
        );

      const scopes =
        Array.isArray(data?.scopes)
          ? data.scopes
          : (data?.entitlements && typeof data.entitlements === 'object')
            ? Object.keys(data.entitlements).filter(k => data.entitlements[k] === true)
            : [];

      const deviceId = data?.device_id ?? data?.deviceId ?? undefined;

      return { userId, username, isPremium, deviceId: deviceId ? String(deviceId) : undefined, scopes };
    } catch (e) {
      const err = e as AxiosError;
      const status = err.response?.status;
      const body = err.response?.data;
      console.error('❌ Introspection error', {
        url,
        status,
        body,
        scheme,
        token: redact(token),
      });
      throw new UnauthorizedException('Invalid token');
    }
  }
}
