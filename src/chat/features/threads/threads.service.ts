// src/chat/features/threads/threads.service.ts

import { Injectable, BadRequestException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Thread, ThreadDocument } from './thread.schema';

@Injectable()
export class ThreadsService {
  constructor(@InjectModel(Thread.name) private readonly model: Model<ThreadDocument>) {}

  async createThread(params: {
    conversationId: string;
    rootMessageId: string;
    createdBy: string;
    title?: string;
  }) {
    if (!params.conversationId || !params.rootMessageId) throw new BadRequestException('invalid thread params');

    try {
      return await this.model.create({
        conversationId: params.conversationId,
        rootMessageId: params.rootMessageId,
        createdBy: params.createdBy,
        title: params.title,
      });
    } catch (e: any) {
      // if already exists, return it
      const existing = await this.model.findOne({
        conversationId: params.conversationId,
        rootMessageId: params.rootMessageId,
      });
      if (existing) return existing;
      throw e;
    }
  }

  async listThreads(conversationId: string, limit = 30) {
    return this.model.find({ conversationId }).sort({ createdAt: -1 }).limit(limit).exec();
  }
}
