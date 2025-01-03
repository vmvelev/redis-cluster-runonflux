import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ClusterConfig } from '../config/cluster.config';
import { ReadResult, WriteResult } from '../interfaces/data.interface';
import { NodeDiscoveryService } from './node-discovery.service';
import { SyncService } from './sync.service';

@Injectable()
export class DataService {
  private readonly logger = new Logger(DataService.name);
  private redisConnections: Map<string, Redis> = new Map();
  private nodeDiscoveryInterval: NodeJS.Timeout;

  constructor(
    private readonly configService: ConfigService<ClusterConfig>,
    private readonly nodeDiscoveryService: NodeDiscoveryService,
    private readonly syncService: SyncService,
  ) {
    this.initializeConnections();
  }

  private async initializeConnections() {
    const nodes = await this.nodeDiscoveryService.discoverNodes();

    for (const node of nodes) {
      await this.connectToNode(node.ip);
    }

    // Start periodic node discovery
    const interval = this.configService.get('nodeDiscoveryInterval');
    this.nodeDiscoveryInterval = setInterval(async () => {
      const currentNodes = await this.nodeDiscoveryService.discoverNodes();
      await this.handleNodeChanges(currentNodes);
    }, interval);
  }

  private async connectToNode(nodeIp: string) {
    const redis = new Redis({
      host: nodeIp,
      port: this.configService.get('redisPort'),
      password: this.configService.get('redisPassword'),
      connectTimeout: 5000,
      maxRetriesPerRequest: 2,
      retryStrategy: (times) => {
        if (times > 3) return null;
        return Math.min(times * 100, 2000);
      },
    });

    redis.on('error', (error) => {
      this.logger.error(
        `Redis connection error for ${nodeIp}: ${error.message}`,
      );
    });

    redis.on('connect', async () => {
      this.logger.log(`Connected to Redis node ${nodeIp}`);
      await this.synchronizeNode(nodeIp, redis);
    });

    this.redisConnections.set(nodeIp, redis);
  }

  private async handleNodeChanges(currentNodes: Array<{ ip: string }>) {
    // Remove connections to nodes that no longer exist
    for (const [nodeIp, connection] of this.redisConnections.entries()) {
      if (!currentNodes.find((node) => node.ip === nodeIp)) {
        connection.disconnect();
        this.redisConnections.delete(nodeIp);
        this.logger.log(`Removed connection to node ${nodeIp}`);
      }
    }

    // Add connections to new nodes
    for (const node of currentNodes) {
      if (!this.redisConnections.has(node.ip)) {
        await this.connectToNode(node.ip);
        this.logger.log(`Added connection to new node ${node.ip}`);
      }
    }
  }

  private async synchronizeNode(nodeIp: string, redis: Redis): Promise<void> {
    try {
      // Check if node needs synchronization
      const syncStatus = await this.syncService.getSyncStatus(redis);
      if (syncStatus.status === 'synchronized') {
        this.logger.log(`Node ${nodeIp} is already synchronized`);
        return;
      }

      // Find a source node for synchronization
      const sourceNode = await this.findSourceNode(nodeIp);
      if (!sourceNode) {
        this.logger.log(
          `No source node available for synchronization, marking as first node`,
        );
        await this.syncService.setSyncStatus(redis, { status: 'synchronized' });
        return;
      }

      // Perform data synchronization
      await this.syncService.copyDataFromSource(sourceNode, redis, nodeIp);
      await this.syncService.setSyncStatus(redis, { status: 'synchronized' });
      this.logger.log(`Node ${nodeIp} successfully synchronized`);
    } catch (error) {
      this.logger.error(
        `Synchronization failed for node ${nodeIp}: ${error.message}`,
      );
      await this.syncService.setSyncStatus(redis, {
        status: 'failed',
        error: error.message,
      });
      throw error;
    }
  }

  private async findSourceNode(excludeIp: string): Promise<Redis | null> {
    for (const [nodeIp, redis] of this.redisConnections.entries()) {
      if (nodeIp !== excludeIp) {
        try {
          const syncStatus = await this.syncService.getSyncStatus(redis);
          if (syncStatus.status === 'synchronized') {
            return redis;
          }
        } catch (error) {
          this.logger.warn(`Could not check sync status of node ${nodeIp}`);
        }
      }
    }
    return null;
  }

  async write(key: string, value: string): Promise<WriteResult[]> {
    const writePromises: Promise<WriteResult>[] = [];
    const timestamp = Date.now();
    const valueWithTimestamp = JSON.stringify({ value, timestamp });
    const writeTimeout = this.configService.get('writeTimeout');

    for (const [nodeIp, redis] of this.redisConnections.entries()) {
      const writePromise = Promise.race([
        redis
          .set(key, valueWithTimestamp)
          .then(() => ({ nodeIp, success: true }))
          .catch((error) => ({ nodeIp, success: false, error: error.message })),
        new Promise<WriteResult>((resolve) =>
          setTimeout(
            () => resolve({ nodeIp, success: false, error: 'Write timeout' }),
            writeTimeout,
          ),
        ),
      ]);

      writePromises.push(writePromise);
    }

    const results = await Promise.all(writePromises);

    results.forEach((result) => {
      if (!result.success) {
        this.logger.warn(
          `Write failed for node ${result.nodeIp}: ${result.error}`,
        );
      }
    });

    return results;
  }

  async read(key: string): Promise<ReadResult | null> {
    const readPromises: Promise<{ value: string; timestamp: number } | null>[] =
      [];

    for (const redis of this.redisConnections.values()) {
      const readPromise = redis
        .get(key)
        .then((result) => {
          if (!result) return null;
          return JSON.parse(result);
        })
        .catch(() => null);

      readPromises.push(readPromise);
    }

    const results = await Promise.all(readPromises);
    const validResults = results.filter((result) => result !== null);

    if (validResults.length === 0) {
      return null;
    }

    return validResults.reduce((latest, current) => {
      if (!latest || current.timestamp > latest.timestamp) {
        return current;
      }
      return latest;
    });
  }

  async onModuleDestroy() {
    if (this.nodeDiscoveryInterval) {
      clearInterval(this.nodeDiscoveryInterval);
    }

    for (const redis of this.redisConnections.values()) {
      redis.disconnect();
    }
  }
}
