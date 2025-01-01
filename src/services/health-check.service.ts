import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisNode } from '../interfaces/redis-node.interface';
import { NodeDiscoveryService } from './node-discovery.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisConnectionHandler } from './redis-connection.handler';

@Injectable()
export class HealthCheckService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HealthCheckService.name);
  private healthCheckInterval: NodeJS.Timeout;
  private previousStatus: Map<string, 'active' | 'inactive'> = new Map();

  constructor(
    private configService: ConfigService,
    private nodeDiscoveryService: NodeDiscoveryService,
    private eventEmitter: EventEmitter2,
    private redisConnectionHandler: RedisConnectionHandler,
  ) {}

  async onModuleInit() {
    const interval = this.configService.get<number>('healthCheckInterval');
    this.healthCheckInterval = setInterval(() => this.checkNodesHealth(), interval);
    await this.checkNodesHealth(); // Initial health check
  }

  onModuleDestroy() {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval);
    }
    this.redisConnectionHandler.closeAll();
  }

  private async checkNodeHealth(node: RedisNode): Promise<boolean> {
    const redis = this.redisConnectionHandler.getConnection(node);
    if (!redis) return false;

    try {
      const startTime = Date.now();
      await redis.ping();
      const latency = Date.now() - startTime;

      this.logger.debug(`Node ${node.ip}:${node.port} responded in ${latency}ms`);
      return true;
    } catch (error) {
      // Only log if it's not a connection refused error
      if (!error.message.includes('ECONNREFUSED')) {
        this.logger.warn(`Failed to ping node ${node.ip}:${node.port}: ${error.message}`);
      }
      return false;
    }
  }

  async checkNodesHealth(): Promise<void> {
    const nodes = await this.nodeDiscoveryService.discoverNodes();
    const healthCheckPromises = nodes.map(async (node) => {
      const isHealthy = await this.checkNodeHealth(node);
      const previousStatus = this.previousStatus.get(node.ip) || 'inactive';
      node.status = isHealthy ? 'active' : 'inactive';
      node.lastSeen = isHealthy ? new Date() : node.lastSeen;

      if (previousStatus !== node.status) {
        this.logger.debug(`Node ${node.ip} status changed from ${previousStatus} to ${node.status}`);
        this.eventEmitter.emit('node.health.changed', {
          node,
          isHealthy: node.status === 'active'
        });
      }

      this.previousStatus.set(node.ip, node.status);
      return node;
    });

    try {
      await Promise.all(healthCheckPromises);
      const activeNodes = nodes.filter((node) => node.status === 'active');
      const inactiveNodes = nodes.filter((node) => node.status === 'inactive');
      
      this.logger.log(`Health check completed. Active: ${activeNodes.length}, Inactive: ${inactiveNodes.length}`);
      this.eventEmitter.emit('nodes.health.updated', nodes);
    } catch (error) {
      this.logger.error(`Error during health check: ${error.message}`);
    }
  }

  getNodeHealth(nodeIp: string): RedisNode | null {
    const nodes = this.nodeDiscoveryService.getNodes();
    return nodes.find((node) => node.ip === nodeIp) || null;
  }

  getAllNodesHealth(): RedisNode[] {
    return this.nodeDiscoveryService.getNodes();
  }
}