// src/messages/messages.module.ts

import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { HttpModule } from '@nestjs/axios';

import { MessagesService } from './messages.service';
import { MessageEntity, MessageSchema } from './schemas/message.schema';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: MessageEntity.name, schema: MessageSchema },
    ]),
    HttpModule,
  ],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
