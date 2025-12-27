import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Thread, ThreadSchema } from './thread.schema';
import { ThreadsService } from './threads.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Thread.name, schema: ThreadSchema }])],
  providers: [ThreadsService],
  exports: [ThreadsService],
})
export class ThreadsModule {}
