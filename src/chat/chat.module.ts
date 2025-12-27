import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { DjangoAuthService } from '../auth/django-auth.service';
import { WsAuthGuard } from '../auth/ws-auth.guard';

import { Message, MessageSchema } from './features/messages/schemas/message.schema';

import { ReceiptsService } from '../chat/features/receipts/receipts.service';
import { ReactionsService } from '../chat/features/reactions/reactions.service';
import { SyncService } from '../chat/features/sync/sync.service';

import { DjangoConversationClient } from './integrations/django/django-conversation.client';
import { DjangoSeqClient } from './integrations/django/django-seq.client';

import { RateLimitService } from './infra/rate-limit/rate-limit.service';

import { ChatGateway } from '../realtime/chat.gateway';
import { PresenceService } from '../chat/features/presence/presence.service';
import { MessagesService } from '../chat/features/messages/messages.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),
  ],
  providers: [
    ChatGateway,

    DjangoAuthService,
    WsAuthGuard,

    MessagesService,
    ReceiptsService,
    ReactionsService,
    SyncService,

    PresenceService,

    DjangoConversationClient,
    DjangoSeqClient,

    RateLimitService,
  ],
})
export class ChatModule {}
