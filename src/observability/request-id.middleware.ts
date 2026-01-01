import { randomUUID } from 'crypto';
import type { FastifyRequest, FastifyReply } from 'fastify';

export function requestIdMiddleware(req: FastifyRequest, res: FastifyReply, next: () => void) {
  const incoming = (req.headers['x-request-id'] as string | undefined) ?? '';
  const id = incoming || randomUUID();
  (req as any).requestId = id;
  res.header('x-request-id', id);
  next();
}
