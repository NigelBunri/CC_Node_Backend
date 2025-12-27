// src/features/messages/messages.module.ts
import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Message, MessageSchema } from 'src/messages/schemas/message.schema';
import { MessagesService } from './messages.service';


@Module({
  imports: [MongooseModule.forFeature([{ name: Message.name, schema: MessageSchema }])],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
