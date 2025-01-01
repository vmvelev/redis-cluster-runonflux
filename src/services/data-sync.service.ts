import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MasterElectionService } from './master-election.service';
import { RedisConnectionHandler } from './redis-connection.handler';
import { ClusterConfig } from '../config/cluster.config';

@Injectable()
export class DataSyncService {
  private readonly logger = new Logger(DataSyncService.name);

  constructor(
    private readonly configService: ConfigService<ClusterConfig>,
    private readonly masterElectionService: MasterElectionService,
    private readonly redisConnectionHandler: RedisConnectionHandler,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async write(key: string, value: string): Promise<boolean> {
    const master = this.masterElectionService.getCurrentMaster();
    if (!master) {
      throw new Error('No master node available');
    }

    const masterConnection = this.redisConnectionHandler.getConnection(master);
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
        const replicaPromises = replicas.map(async (replica) => {
          const redis = this.redisConnectionHandler.getConnection(replica);
          if (!redis) {
            this.logger.warn(
              `Cannot establish connection to replica ${replica.ip}`,
            );
            return null;
          }

          try {
            const result = await Promise.race([
              redis.wait(1, syncWaitTime),
              new Promise((_, reject) =>
                setTimeout(
                  () => reject(new Error('Sync timeout')),
                  syncWaitTime,
                ),
              ),
            ]);
            return { replica, result };
          } catch (error) {
            this.logger.error(
              `Sync failed for replica ${replica.ip}: ${error.message}`,
            );
            return null;
          }
        });

        const validPromises = replicaPromises.filter((p) => p !== null);

        switch (consistencyLevel) {
          case 'all':
            await Promise.all(validPromises);
            break;
          case 'quorum':
            const quorum = Math.floor(replicas.length / 2) + 1;
            await Promise.all(validPromises.slice(0, quorum));
            break;
          case 'one':
            if (validPromises.length > 0) {
              await Promise.race(validPromises);
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
      case 'one': {
        // Try master first, then replicas
        for (const node of nodes) {
          const redis = this.redisConnectionHandler.getConnection(node);
          if (!redis) continue;

          try {
            const value = await redis.get(key);
            return value;
          } catch (error) {
            this.logger.warn(`Read failed from ${node.ip}: ${error.message}`);
            continue;
          }
        }
        throw new Error('No nodes available for read operation');
      }

      case 'quorum': {
        const quorum = Math.floor(nodes.length / 2) + 1;
        const readPromises = nodes.slice(0, quorum).map(async (node) => {
          const redis = this.redisConnectionHandler.getConnection(node);
          if (!redis) return null;

          try {
            return await redis.get(key);
          } catch (error) {
            this.logger.warn(`Read failed from ${node.ip}: ${error.message}`);
            return null;
          }
        });

        const results = await Promise.all(readPromises);
        const validResults = results.filter((result) => result !== null);

        if (validResults.length < quorum) {
          throw new Error('Failed to achieve quorum for read operation');
        }

        // Return the most common value
        const valueMap = new Map<string, number>();
        validResults.forEach((value) => {
          if (value) {
            valueMap.set(value, (valueMap.get(value) || 0) + 1);
          }
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
      }

      case 'all': {
        const readPromises = nodes.map(async (node) => {
          const redis = this.redisConnectionHandler.getConnection(node);
          if (!redis) return null;

          try {
            return await redis.get(key);
          } catch (error) {
            this.logger.warn(`Read failed from ${node.ip}: ${error.message}`);
            return null;
          }
        });

        const results = await Promise.all(readPromises);
        const validResults = results.filter((result) => result !== null);

        if (validResults.length !== nodes.length) {
          throw new Error('Failed to read from all nodes');
        }

        // Check if all values are consistent
        const uniqueValues = new Set(validResults.filter(Boolean));
        if (uniqueValues.size > 1) {
          throw new Error('Inconsistent values across nodes');
        }

        return validResults[0];
      }

      default:
        throw new Error(`Unsupported consistency level: ${consistencyLevel}`);
    }
  }

  async monitorReplicationStatus(): Promise<void> {
    const master = this.masterElectionService.getCurrentMaster();
    if (!master) {
      return;
    }

    try {
      const masterConnection =
        this.redisConnectionHandler.getConnection(master);
      if (!masterConnection) {
        throw new Error('Cannot establish connection to master node');
      }

      const replicationInfo = await masterConnection.info('replication');
      const replicas = this.masterElectionService.getReplicas();

      this.eventEmitter.emit('replication.status.updated', {
        master: master.ip,
        replicas: replicas.map((r) => r.ip),
        info: replicationInfo,
      });
    } catch (error) {
      this.logger.error(`Failed to monitor replication: ${error.message}`);
    }
  }
}
