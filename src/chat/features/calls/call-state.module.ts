import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { CallSession, CallSessionSchema } from './call-session.schema';
import { CallStateService } from './call-state.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: CallSession.name, schema: CallSessionSchema }])],
  providers: [CallStateService],
  exports: [CallStateService],
})
export class CallStateModule {}
