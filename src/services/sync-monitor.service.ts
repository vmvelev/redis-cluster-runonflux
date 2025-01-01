import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisNode } from '../interfaces/redis-node.interface';
import { ClusterConfig } from '../config/cluster.config';
import Redis from 'ioredis';

interface SyncStatus {
  nodeIp: string;
  syncInProgress: boolean;
  masterLinkStatus: string;
  masterSyncLeftBytes: number;
  masterSyncLastIoSecondsAgo: number;
}

@Injectable()
export class SyncMonitorService {
  private readonly logger = new Logger(SyncMonitorService.name);
  private redisConnections: Map<string, Redis> = new Map();

  constructor(
    private readonly configService: ConfigService<ClusterConfig>,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private getRedisConnection(node: RedisNode): Redis {
    const key = `${node.ip}:${node.port}`;
    if (!this.redisConnections.has(key)) {
      const connection = new Redis({
        host: node.ip,
        port: node.port,
        connectTimeout: 5000,
      });
      this.redisConnections.set(key, connection);
    }
    return this.redisConnections.get(key);
  }

  async getSyncStatus(node: RedisNode): Promise<SyncStatus> {
    try {
      const redis = this.getRedisConnection(node);
      const info = await redis.info('replication');

      // Parse relevant information from info command
      const syncInProgress = info.includes('master_sync_in_progress:1');
      const masterLinkStatus = info.includes('master_link_status:up')
        ? 'up'
        : 'down';

      // Parse master_sync_left_bytes from info string
      const leftBytesMatch = info.match(/master_sync_left_bytes:(\d+)/);
      const masterSyncLeftBytes = leftBytesMatch
        ? parseInt(leftBytesMatch[1], 10)
        : 0;

      // Parse master_sync_last_io_seconds_ago
      const lastIoMatch = info.match(/master_sync_last_io_seconds_ago:(\d+)/);
      const masterSyncLastIoSecondsAgo = lastIoMatch
        ? parseInt(lastIoMatch[1], 10)
        : 0;

      const status: SyncStatus = {
        nodeIp: node.ip,
        syncInProgress,
        masterLinkStatus,
        masterSyncLeftBytes,
        masterSyncLastIoSecondsAgo,
      };

      this.eventEmitter.emit('sync.status.updated', status);
      return status;
    } catch (error) {
      this.logger.error(
        `Failed to get sync status for ${node.ip}: ${error.message}`,
      );
      throw error;
    }
  }

  async waitForSync(node: RedisNode): Promise<boolean> {
    const syncWaitTime = this.configService.get('syncWaitTime', {
      infer: true,
    });
    const startTime = Date.now();

    while (Date.now() - startTime < syncWaitTime) {
      try {
        const status = await this.getSyncStatus(node);

        if (!status.syncInProgress && status.masterLinkStatus === 'up') {
          return true;
        }

        // Wait before next check
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        this.logger.error(`Error checking sync status: ${error.message}`);
      }
    }

    return false;
  }

  async onModuleDestroy() {
    // Clean up Redis connections
    for (const connection of this.redisConnections.values()) {
      connection.disconnect();
    }
  }
}
