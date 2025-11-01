import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DjangoAuthService } from './django-auth.service';

@Injectable()
export class WsAuthGuard implements CanActivate {
  constructor(private readonly auth: DjangoAuthService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const client: any = ctx.switchToWs().getClient();
    const fromHeader = client?.handshake?.headers?.authorization;
    const bearer = fromHeader?.startsWith('Bearer ') ? fromHeader.slice(7) : undefined;
    const token: string | undefined = client?.handshake?.auth?.token || bearer;
    if (!token) return false;
    console.log("check token 1: ", token)
    const principal = await this.auth.introspect(token);
    client.principal = principal; // attach to socket
    return true;
  }
}
