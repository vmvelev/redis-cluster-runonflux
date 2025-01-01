import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { NodeDiscoveryService } from './services/node-discovery.service';
import { HealthCheckService } from './services/health-check.service';
import { MasterElectionService } from './services/master-election.service';
import { DataSyncService } from './services/data-sync.service';
import { ClusterController } from './controllers/cluster.controller';
import { DataController } from './controllers/data.controller';
import { validate, getDefaultConfig } from './config/env.validation';
import { SyncMonitorService } from './services/sync-monitor.service';
import { RedisConnectionHandler } from './services/redis-connection.handler';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate,
      load: [getDefaultConfig],
    }),
    EventEmitterModule.forRoot(),
  ],
  controllers: [ClusterController, DataController],
  providers: [
    RedisConnectionHandler,
    NodeDiscoveryService,
    HealthCheckService,
    MasterElectionService,
    DataSyncService,
    SyncMonitorService,
  ],
})
export class AppModule {}