import 'socket.io';

declare module 'socket.io' {
  interface Socket {
    principal?: { userId: string; username: string; isPremium: boolean; scopes?: string[] };
  }
}
