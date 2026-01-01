import { Injectable } from '@nestjs/common';
import { DeviceTokensService } from './device-tokens.service';
import { DummyPushProvider, PushMessage, PushProvider } from './push.provider';

export type PushTarget = { userId: string; deviceTokens?: string[] };

@Injectable()
export class NotificationsService {
  private readonly provider: PushProvider = new DummyPushProvider();

  constructor(
    private readonly tokens: DeviceTokensService,
  ) {}

  async notify(target: PushTarget, msg: PushMessage) {
    const tokens = target.deviceTokens?.length
      ? target.deviceTokens
      : await this.tokens.listActiveTokens(target.userId);

    if (!tokens.length) return { ok: true, delivered: 0, userId: target.userId };

    const res = await this.provider.send(tokens, msg);
    return { ok: true, delivered: res.delivered, userId: target.userId };
  }

  async notifyIncomingCall(input: { toUserId: string; fromUserId: string; conversationId: string; callId: string }) {
    return this.notify(
      { userId: input.toUserId },
      {
        title: 'Incoming call',
        body: `Call from ${input.fromUserId}`,
        data: { conversationId: input.conversationId, callId: input.callId },
      },
    );
  }

  async notifyNewMessage(input: { toUserId: string; conversationId: string; messageId: string; preview?: string }) {
    return this.notify(
      { userId: input.toUserId },
      {
        title: 'New message',
        body: input.preview ?? 'New message',
        data: { conversationId: input.conversationId, messageId: input.messageId },
      },
    );
  }
}
