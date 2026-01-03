// src/uploads/uploads.controller.ts
import { Controller, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';   // ✅ type-only import fixes TS1272
import '@fastify/multipart';                     // ✅ bring in .file() augmentation (types-side effect)
import { LocalStorageService } from '../storage/local-storage.service';

@Controller('uploads')
export class UploadsController {
  constructor(private readonly local: LocalStorageService) {}

  @Post('file')
  async upload(@Req() req: FastifyRequest) {
    // Parse a single file via @fastify/multipart
    // (FastifyRequest doesn't know .file() unless you wire generics; simplest is cast)
    const mp: any = await (req as any).file();
    if (!mp) return { error: 'No file provided' };

    // Collect buffer
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      mp.file.on('data', (c: Buffer) => chunks.push(c));
      mp.file.on('end', () => resolve());
      mp.file.on('error', reject);
    });
    const buffer = Buffer.concat(chunks);

    // Size guard
    const size = buffer.length;
    if (size > 50 * 1024 * 1024) {
      return { error: 'File too large' };
    }

    const host = req.headers?.host;
    const proto =
      (req.headers?.['x-forwarded-proto'] as string) ||
      (req as any).protocol ||
      'http';
    const publicBase = host ? `${proto}://${host}/uploads` : undefined;

    const stored = await this.local.storeLocal({
      buffer,
      filename: mp.filename,
      mime: mp.mimetype || 'application/octet-stream',
      size,
      publicBase,
    });

    const kind = (() => {
      const mime = stored.mime || '';
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.includes('pdf') || mime.includes('msword') || mime.includes('officedocument'))
        return 'document';
      return 'other';
    })();

    return {
      ok: true,
      attachment: {
        id: stored.key,
        url: stored.url,
        name: stored.name,
        mime: stored.mime,
        originalName: stored.name,
        mimeType: stored.mime,
        size: stored.size,
        kind,
      },
    };
  }
}
