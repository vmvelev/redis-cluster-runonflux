import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { RedisNode } from '../interfaces/redis-node.interface';
import { MasterElectionService } from './master-election.service';
import { ClusterConfig } from '../config/cluster.config';

@Injectable()
export class DataSyncService {
  private readonly logger = new Logger(DataSyncService.name);
  private redisConnections: Map<string, Redis> = new Map();

  constructor(
    private readonly configService: ConfigService<ClusterConfig>,
    private readonly masterElectionService: MasterElectionService,
    private readonly eventEmitter: EventEmitter2,
  ) {
    // Subscribe to health change events to cleanup connections
    this.eventEmitter.on('node.health.changed', ({ node, isHealthy }) => {
      if (!isHealthy) {
        this.cleanupNodeConnection(node);
      }
    });
  }

  private cleanupNodeConnection(node: RedisNode): void {
    const key = `${node.ip}:${node.port}`;
    if (this.redisConnections.has(key)) {
      const connection = this.redisConnections.get(key);
      connection.disconnect();
      this.redisConnections.delete(key);
      this.logger.log(`Cleaned up connection to ${key}`);
    }
  }

  private isNodeActive(node: RedisNode): boolean {
    return (
      node.status === 'active' &&
      (node === this.masterElectionService.getCurrentMaster() ||
        this.masterElectionService.getReplicas().includes(node))
    );
  }

  private getRedisConnection(node: RedisNode): Redis | null {
    if (!this.isNodeActive(node)) {
      this.logger.debug(`Skipping connection to inactive node ${node.ip}`);
      return null;
    }

    const key = `${node.ip}:${node.port}`;
    if (!this.redisConnections.has(key)) {
      const connection = new Redis({
        host: node.ip,
        port: node.port,
        connectTimeout: 5000,
        retryStrategy: (times) => {
          const delay = Math.min(times * 50, 2000);
          return delay;
        },
      });

      connection.on('error', (error) => {
        this.logger.error(
          `Redis connection error for ${node.ip}: ${error.message}`,
        );
        if (!this.isNodeActive(node)) {
          this.cleanupNodeConnection(node);
        }
      });

      this.redisConnections.set(key, connection);
    }
    return this.redisConnections.get(key);
  }

  async write(key: string, value: string): Promise<boolean> {
    const master = this.masterElectionService.getCurrentMaster();
    if (!master) {
      throw new Error('No master node available');
    }

    const masterConnection = this.getRedisConnection(master);
    if (!masterConnection) {
      throw new Error('Cannot establish connection to master node');
    }

    const replicationMode = this.configService.get('replicationMode');
    const consistencyLevel = this.configService.get('consistencyLevel');
    const syncWaitTime = this.configService.get('syncWaitTime');
    const replicas = this.masterElectionService.getReplicas();

    try {
      // Write to master
      await masterConnection.set(key, value);

      if (replicationMode === 'sync') {
        // Only wait for active replicas
        const activeReplicas = replicas.filter((replica) =>
          this.isNodeActive(replica),
        );
        const replicaPromises = activeReplicas.map(async (replica) => {
          const redis = this.getRedisConnection(replica);
          if (!redis) return null;

          const result = await Promise.race([
            redis.wait(1, syncWaitTime),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error('Sync timeout')), syncWaitTime),
            ),
          ]);
          return { replica, result };
        });

        switch (consistencyLevel) {
          case 'all':
            await Promise.all(replicaPromises);
            break;
          case 'quorum':
            const quorum = Math.floor(activeReplicas.length / 2) + 1;
            await Promise.all(replicaPromises.slice(0, quorum));
            break;
          case 'one':
            if (activeReplicas.length > 0) {
              await Promise.race(replicaPromises);
            }
            break;
        }
      }

      this.eventEmitter.emit('data.sync.completed', { key, value });
      return true;
    } catch (error) {
      this.logger.error(`Write operation failed: ${error.message}`);
      this.eventEmitter.emit('data.sync.failed', { key, error: error.message });
      throw error;
    }
  }

  async read(key: string): Promise<string | null> {
    const consistencyLevel = this.configService.get('consistencyLevel');
    const master = this.masterElectionService.getCurrentMaster();
    const replicas = this.masterElectionService.getReplicas();

    if (!master) {
      throw new Error('No master node available');
    }

    const nodes = [master, ...replicas];

    switch (consistencyLevel) {
      case 'one':
        // Try master first, then replicas
        for (const node of nodes) {
          try {
            const redis = this.getRedisConnection(node);
            const value = await redis.get(key);
            return value;
          } catch (error) {
            this.logger.warn(`Read failed from ${node.ip}: ${error.message}`);
            continue;
          }
        }
        throw new Error('No nodes available for read operation');

      case 'quorum':
        const quorum = Math.floor(nodes.length / 2) + 1;
        const values = await Promise.allSettled(
          nodes.slice(0, quorum).map(async (node) => {
            const redis = this.getRedisConnection(node);
            return redis.get(key);
          }),
        );

        const successfulValues = values
          .filter(
            (result): result is PromiseFulfilledResult<string> =>
              result.status === 'fulfilled' && result.value !== null,
          )
          .map((result) => result.value);

        if (successfulValues.length < quorum) {
          throw new Error('Failed to achieve quorum for read operation');
        }

        // Return the most common value
        const valueMap = new Map<string, number>();
        successfulValues.forEach((value) => {
          valueMap.set(value, (valueMap.get(value) || 0) + 1);
        });

        let maxCount = 0;
        let mostCommonValue = null;
        valueMap.forEach((count, value) => {
          if (count > maxCount) {
            maxCount = count;
            mostCommonValue = value;
          }
        });

        return mostCommonValue;

      case 'all':
        const allValues = await Promise.all(
          nodes.map(async (node) => {
            const redis = this.getRedisConnection(node);
            return redis.get(key);
          }),
        );

        // Check if all values are consistent
        const uniqueValues = new Set(allValues.filter(Boolean));
        if (uniqueValues.size > 1) {
          throw new Error('Inconsistent values across nodes');
        }

        return allValues[0];

      default:
        throw new Error(`Unsupported consistency level: ${consistencyLevel}`);
    }
  }

  async monitorReplicationStatus(): Promise<void> {
    const master = this.masterElectionService.getCurrentMaster();
    const replicas = this.masterElectionService.getReplicas();

    if (!master) {
      return;
    }

    try {
      const masterRedis = this.getRedisConnection(master);
      const replicationInfo = await masterRedis.info('replication');

      // Parse replication info and emit status
      this.eventEmitter.emit('replication.status.updated', {
        master: master.ip,
        replicas: replicas.map((r) => r.ip),
        info: replicationInfo,
      });
    } catch (error) {
      this.logger.error(`Failed to monitor replication: ${error.message}`);
    }
  }

  // Clean up connections when service is destroyed
  async onModuleDestroy() {
    for (const connection of this.redisConnections.values()) {
      connection.disconnect();
    }
    this.redisConnections.clear();
  }
}
