// gateway.module.ts
import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';

import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { PresenceModule } from '../presence/presence.module';

@Module({
  imports: [
    AuthModule,
    MessagesModule,
    PresenceModule,

    // NEW: used by ChatGateway to call Django chat API
    HttpModule,
  ],
  providers: [ChatGateway],
})
export class GatewayModule {}
