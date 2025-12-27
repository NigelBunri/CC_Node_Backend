// src/chat/features/presence/presence.module.ts
import { Module } from '@nestjs/common';
import { PresenceModule as RootPresenceModule } from 'src/presence/presence.module';

@Module({
  imports: [RootPresenceModule],
  exports: [RootPresenceModule],
})
export class PresenceModule {}
