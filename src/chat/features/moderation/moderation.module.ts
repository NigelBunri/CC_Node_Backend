import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Report, ReportSchema } from './report.schema';
import { ModerationService } from './moderation.service';

@Module({
  imports: [MongooseModule.forFeature([{ name: Report.name, schema: ReportSchema }])],
  providers: [ModerationService],
  exports: [ModerationService],
})
export class ModerationModule {}
