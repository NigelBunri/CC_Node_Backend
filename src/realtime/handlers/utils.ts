import { Server, Socket } from 'socket.io';
import { SocketPrincipal, EVT } from '../../chat/chat.types';

export function requirePrincipal(client: Socket & { principal?: SocketPrincipal }): SocketPrincipal {
  if (!client.principal?.userId) throw new Error('Unauthenticated socket');
  return client.principal;
}

export function resolveDeviceId(client: Socket & { principal?: SocketPrincipal }): string {
  const fromAuth = (client.handshake as any)?.auth?.deviceId;
  const fromPrincipal = client.principal?.deviceId;
  const deviceId = String(fromAuth ?? fromPrincipal ?? 'unknown');
  return deviceId || 'unknown';
}

export function emitPresence(server: Server, userId: string, state: 'online' | 'offline') {
  server.emit(EVT.PRESENCE, { userId, state, at: Date.now() });
}
