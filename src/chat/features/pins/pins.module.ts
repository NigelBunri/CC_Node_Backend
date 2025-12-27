import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Pin, PinSchema } from './pin.schema';
import { PinsService } from './pins.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Pin.name, schema: PinSchema }])],
  providers: [PinsService],
  exports: [PinsService],
})
export class PinsModule {}
