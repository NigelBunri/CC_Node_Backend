import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Star, StarSchema } from './star.schema';
import { StarsService } from './stars.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Star.name, schema: StarSchema }])],
  providers: [StarsService],
  exports: [StarsService],
})
export class StarsModule {}
