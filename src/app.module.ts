import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';

import { AuthModule } from './auth/auth.module';
import { GatewayModule } from './realtime/gateway.module';
import { MessagesModule } from './messages/messages.module';
import { PresenceModule } from './presence/presence.module';
import { UploadsModule } from './uploads/uploads.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),

    MongooseModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (cfg: ConfigService) => {
        const uri = cfg.get<string>('MONGODB_URI') ?? '';
        const env = (cfg.get<string>('NODE_ENV') || 'development').toLowerCase();

        const isSrv = uri.startsWith('mongodb+srv://');     // Atlas-style SRV
        const directConnection = !isSrv;                    // single host (local, docker, VM, etc.)
        const dbFromUri = (() => {
          try {
            // If URI looks like mongodb://host:port/dbname extract dbname
            const m = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/i);
            return m?.[1];
          } catch { return undefined; }
        })();
        const dbName = dbFromUri || cfg.get<string>('MONGODB_DB') || 'kis';

        // Masked URI for logs (avoid printing secrets)
        const masked = uri.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:*****@');
        if (env !== 'production') {
          console.log('[BOOT] MONGODB_URI =', masked);
        }

        return {
          uri,
          dbName,
          // Timeouts
          serverSelectionTimeoutMS: 8000,

          // Local/single-node fast path; driver skips replica discovery
          directConnection,

          // TLS only for SRV/Atlas (local dev is usually non-TLS)
          tls: isSrv,
          ssl: isSrv, // alias; harmless

          // Reasonable pool for dev; tune as needed
          maxPoolSize: 10,

          // Nice for dev, safer off in prod
          autoIndex: env !== 'production',

          // Helps identify your app in server logs/Atlas
          appName: 'kis-backend',
        };
      },
    }),

    AuthModule,
    PresenceModule,
    MessagesModule,
    GatewayModule,
    UploadsModule,
  ],
})
export class AppModule {}
