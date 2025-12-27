// src/chat/chat.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from '../auth/auth.module';
import { WsAuthGuard } from '../auth/ws-auth.guard';

import { Message, MessageSchema } from './features/messages/schemas/message.schema';

import { MessagesService } from './features/messages/messages.service';
import { ReactionsService } from './features/reactions/reactions.service';
import { ReceiptsService } from './features/receipts/receipts.service';
import { SyncService } from './features/sync/sync.service';
import { PresenceService } from './features/presence/presence.service';

import { DjangoConversationClient } from './integrations/django/django-conversation.client';
import { DjangoSeqClient } from './integrations/django/django-seq.client';

import { RateLimitService } from './infra/rate-limit/rate-limit.service';

import { ChatGateway } from '../realtime/chat.gateway';

// ✅ Batch B modules (they export their services AND include their own Mongoose models)
import { ThreadsModule } from './features/threads/threads.module';
import { PinsModule } from './features/pins/pins.module';
import { StarsModule } from './features/stars/stars.module';
import { ModerationModule } from './features/moderation/moderation.module';
import { CallStateModule } from './features/calls/call-state.module';

@Module({
  imports: [
    AuthModule,

    // Batch A message model
    MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }]),

    // ✅ Batch B feature modules
    ThreadsModule,
    PinsModule,
    StarsModule,
    ModerationModule,
    CallStateModule,
  ],
  providers: [
    // Gateway + guard
    ChatGateway,
    WsAuthGuard,

    // Batch A services
    MessagesService,
    ReactionsService,
    ReceiptsService,
    SyncService,
    PresenceService,

    // Django integrations + infra
    DjangoConversationClient,
    DjangoSeqClient,
    RateLimitService,
  ],
})
export class ChatModule {}
