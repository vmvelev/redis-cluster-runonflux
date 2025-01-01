import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { RedisNode } from '../interfaces/redis-node.interface';
import { NodeDiscoveryService } from './node-discovery.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

@Injectable()
export class HealthCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthCheckService.name);
  private healthCheckInterval: NodeJS.Timer;
  private redisConnections: Map<string, Redis> = new Map();
  private previousStatus: Map<string, 'active' | 'inactive'> = new Map();

  constructor(
    private configService: ConfigService,
    private nodeDiscoveryService: NodeDiscoveryService,
    private eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    const interval = this.configService.get<number>('healthCheckInterval');
    this.healthCheckInterval = setInterval(
      () => this.checkNodesHealth(),
      interval,
    );
    await this.checkNodesHealth(); // Initial health check
  }

  onModuleDestroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval as NodeJS.Timeout);
    }
    // Clean up Redis connections
    for (const connection of this.redisConnections.values()) {
      connection.disconnect();
    }
  }

  private getRedisConnection(node: RedisNode): Redis {
    const key = `${node.ip}:${node.port}`;
    if (!this.redisConnections.has(key)) {
      const connection = new Redis({
        host: node.ip,
        port: node.port,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null, // Disable retries
      });
      this.redisConnections.set(key, connection);
    }
    return this.redisConnections.get(key);
  }

  private async checkNodeHealth(node: RedisNode): Promise<boolean> {
    const redis = this.getRedisConnection(node);
    try {
      const startTime = Date.now();
      await redis.ping();
      const latency = Date.now() - startTime;

      this.logger.debug(
        `Node ${node.ip}:${node.port} responded in ${latency}ms`,
      );
      return true;
    } catch (error) {
      this.logger.warn(
        `Failed to ping node ${node.ip}:${node.port}: ${error.message}`,
      );
      // Clean up failed connection
      const key = `${node.ip}:${node.port}`;
      if (this.redisConnections.has(key)) {
        this.redisConnections.get(key).disconnect();
        this.redisConnections.delete(key);
      }
      return false;
    }
  }

  async checkNodesHealth(): Promise<void> {
    const nodes = await this.nodeDiscoveryService.discoverNodes();
    const healthCheckPromises = nodes.map(async (node) => {
      const isHealthy = await this.checkNodeHealth(node);
      // Get the previous status from our tracking Map
      const previousStatus = this.previousStatus.get(node.ip) || 'inactive';
      node.status = isHealthy ? 'active' : 'inactive';
      node.lastSeen = isHealthy ? new Date() : node.lastSeen;

      // Emit event if status changed
      if (previousStatus !== node.status) {
        this.logger.debug(`Node ${node.ip} status changed from ${previousStatus} to ${node.status}`);
        this.eventEmitter.emit('node.health.changed', {
          node,
          isHealthy: node.status === 'active'
        });
      }
      
      // Update the status in our tracking Map
      this.previousStatus.set(node.ip, node.status);
      
      return node;
    });

    try {
      await Promise.all(healthCheckPromises);
      const activeNodes = nodes.filter((node) => node.status === 'active');
      const inactiveNodes = nodes.filter((node) => node.status === 'inactive');
      
      this.logger.log(
        `Health check completed. Active: ${activeNodes.length}, Inactive: ${inactiveNodes.length}`,
      );

      // Emit overall health status
      this.eventEmitter.emit('nodes.health.updated', nodes);
    } catch (error) {
      this.logger.error(`Error during health check: ${error.message}`);
    }
}

  private emitHealthStatus(nodes: RedisNode[]): void {
    nodes.forEach(node => {
      const previousStatus = this.previousStatus.get(node.ip);
      if (previousStatus !== node.status) {
        this.eventEmitter.emit('node.health.changed', {
          node,
          isHealthy: node.status === 'active'
        });
        this.previousStatus.set(node.ip, node.status);
      }
    });
  }

  getNodeHealth(nodeIp: string): RedisNode | null {
    const nodes = this.nodeDiscoveryService.getNodes();
    return nodes.find((node) => node.ip === nodeIp) || null;
  }

  getAllNodesHealth(): RedisNode[] {
    return this.nodeDiscoveryService.getNodes();
  }
}
