import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NodeDiscoveryService } from './services/node-discovery.service';
import { DataService } from './services/data.service';
import { SyncService } from './services/sync.service';
import { DataController } from './controllers/data.controller';
import { validate, getDefaultConfig } from './config/env.validation';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      load: [getDefaultConfig],
    }),
  ],
  controllers: [DataController],
  providers: [NodeDiscoveryService, DataService, SyncService],
})
export class AppModule {}
