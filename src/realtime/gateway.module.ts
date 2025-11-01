import { Module } from '@nestjs/common';
import { ChatGateway } from './chat.gateway';
import { AuthModule } from '../auth/auth.module';
import { MessagesModule } from '../messages/messages.module';
import { PresenceModule } from '../presence/presence.module';

@Module({
  imports: [AuthModule, MessagesModule, PresenceModule],
  providers: [ChatGateway],
})
export class GatewayModule {}
