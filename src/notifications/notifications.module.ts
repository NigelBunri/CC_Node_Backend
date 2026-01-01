import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { NotificationsService } from './notifications.service';
import { DeviceTokensService } from './device-tokens.service';
import { DeviceToken, DeviceTokenSchema } from './schemas/device-token.schema';

@Module({
  imports: [MongooseModule.forFeature([{ name: DeviceToken.name, schema: DeviceTokenSchema }])],
  providers: [NotificationsService, DeviceTokensService],
  exports: [NotificationsService, DeviceTokensService],
})
export class NotificationsModule {}
