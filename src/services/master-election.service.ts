import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { RedisNode } from '../interfaces/redis-node.interface';
import { NodeDiscoveryService } from './node-discovery.service';
import { HealthCheckService } from './health-check.service';
import { RedisConnectionHandler } from './redis-connection.handler';
import { AppConfig } from '../config/env.validation';

@Injectable()
export class MasterElectionService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(MasterElectionService.name);
  private currentMaster: RedisNode | null = null;
  private failoverInProgress = false;
  private lastFailoverAttempt: number = 0;
  private failoverTimeout: number = 10000;
  private configuredNodes: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService<AppConfig>,
    private readonly nodeDiscoveryService: NodeDiscoveryService,
    private readonly healthCheckService: HealthCheckService,
    private readonly redisConnectionHandler: RedisConnectionHandler,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async onModuleInit() {
    this.eventEmitter.on('nodes.health.updated', async (nodes: RedisNode[]) => {
      this.logger.debug(
        `Health update received. Master status: ${
          this.currentMaster ? 'present' : 'absent'
        }`,
      );

      if (!this.currentMaster) {
        await this.electMaster();
      } else {
        await this.configureNewNodes(nodes);
      }
    });

    this.eventEmitter.on('node.health.changed', async ({ node, isHealthy }) => {
      this.logger.debug(
        `Node ${node.ip} health changed to ${
          isHealthy ? 'healthy' : 'unhealthy'
        }. Current master: ${this.currentMaster?.ip}`,
      );

      if (!isHealthy && node.ip === this.currentMaster?.ip) {
        this.logger.warn(
          `Master node ${node.ip} is down, initiating failover...`,
        );
        await this.handleFailover();
      } else if (
        isHealthy &&
        this.currentMaster &&
        node.ip !== this.currentMaster.ip
      ) {
        await this.configureNodeAsReplica(node, this.currentMaster);
      }
    });
  }

  async onModuleDestroy() {
    // Cleanup handled by RedisConnectionHandler
  }

  private async configureNewNodes(nodes: RedisNode[]) {
    if (!this.currentMaster) return;

    const healthyNodes = nodes.filter((node) => node.status === 'active');
    const unconfiguredNodes = healthyNodes.filter(
      (node) =>
        node.ip !== this.currentMaster.ip && !this.configuredNodes.has(node.ip),
    );

    if (unconfiguredNodes.length > 0) {
      this.logger.debug(
        `Found ${unconfiguredNodes.length} new nodes to configure as replicas`,
      );
      await this.configureReplicas(unconfiguredNodes, this.currentMaster);
    }
  }

  private async configureMaster(node: RedisNode): Promise<void> {
    try {
      this.logger.debug(`Starting master configuration for ${node.ip}`);
      const redis = this.redisConnectionHandler.getConnection(node);
      if (!redis) {
        throw new Error(
          `Cannot establish connection to potential master node ${node.ip}`,
        );
      }

      // Check if connection is valid
      await redis.ping();

      // Remove replication if node was previously a replica
      await redis.slaveof('NO', 'ONE');
      this.logger.log(`Configured ${node.ip} as master`);
    } catch (error) {
      this.logger.error(
        `Failed to configure master ${node.ip}: ${error.message}`,
      );
      throw error;
    }
  }

  private async configureNodeAsReplica(node: RedisNode, master: RedisNode) {
    try {
      this.logger.debug(
        `Configuring node ${node.ip} as replica of ${master.ip}`,
      );
      const redis = this.redisConnectionHandler.getConnection(node);
      if (!redis) {
        throw new Error(
          `Cannot establish connection to replica node ${node.ip}`,
        );
      }

      await redis.slaveof(master.ip, master.port.toString());
      node.role = 'replica';
      this.configuredNodes.add(node.ip);
      this.logger.log(`Configured ${node.ip} as replica of ${master.ip}`);
    } catch (error) {
      this.logger.error(
        `Failed to configure replica ${node.ip}: ${error.message}`,
      );
    }
  }

  private async configureReplicas(
    replicas: RedisNode[],
    master: RedisNode,
  ): Promise<void> {
    const promises = replicas.map(async (replica) => {
      try {
        await this.configureNodeAsReplica(replica, master);
      } catch (error) {
        this.logger.error(
          `Failed to configure replica ${replica.ip}: ${error.message}`,
        );
      }
    });

    await Promise.allSettled(promises);
  }

  async handleFailover(): Promise<void> {
    const now = Date.now();
    if (this.failoverInProgress) {
      if (now - this.lastFailoverAttempt > this.failoverTimeout) {
        this.logger.warn('Failover timeout reached, resetting failover flag');
        this.failoverInProgress = false;
      } else {
        this.logger.warn('Failover already in progress');
        return;
      }
    }

    try {
      this.failoverInProgress = true;
      this.lastFailoverAttempt = now;
      this.logger.log('Initiating failover process...');

      // Clear current master
      const oldMaster = this.currentMaster;
      this.logger.debug(`Clearing current master: ${oldMaster?.ip}`);
      this.currentMaster = null;

      // Wait for health checks to update
      this.logger.debug('Waiting for health checks to update...');
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Force a health check
      this.logger.debug('Forcing immediate health check');
      await this.healthCheckService.checkNodesHealth();

      // Get latest nodes
      const nodes = this.nodeDiscoveryService.getNodes();
      const healthyNodes = nodes.filter((node) => node.status === 'active');
      this.logger.debug(
        `Available healthy nodes: ${healthyNodes.map((n) => n.ip).join(', ')}`,
      );

      if (healthyNodes.length === 0) {
        throw new Error('No healthy nodes available for master election');
      }

      // Temporarily disable failoverInProgress to allow election
      this.failoverInProgress = false;

      // Elect new master
      this.logger.debug('Starting new master election');
      const newMaster = await this.electMaster();

      if (!newMaster) {
        throw new Error('Failed to elect new master');
      }

      this.logger.debug(
        `Failover completed successfully. New master: ${newMaster.ip}`,
      );
    } catch (error) {
      this.logger.error(`Failover failed: ${error.message}`);
      this.failoverInProgress = false;
      throw error;
    }
  }

  async electMaster(): Promise<RedisNode | null> {
    if (this.failoverInProgress && this.currentMaster) {
      this.logger.warn('Failover in progress, skipping election');
      return null;
    }

    const nodes = this.nodeDiscoveryService.getNodes();
    const healthyNodes = nodes.filter((node) => node.status === 'active');

    if (healthyNodes.length === 0) {
      this.logger.error('No healthy nodes available for master election');
      return null;
    }

    const newMaster = healthyNodes.reduce((a, b) =>
      a.lastSeen > b.lastSeen ? a : b,
    );

    if (!this.currentMaster || this.currentMaster.ip !== newMaster.ip) {
      try {
        await this.configureMaster(newMaster);
        newMaster.role = 'master';
        this.currentMaster = newMaster;

        const replicas = healthyNodes.filter(
          (node) => node.ip !== newMaster.ip,
        );
        await this.configureReplicas(replicas, newMaster);

        this.logger.log(
          `Elected new master: ${newMaster.ip}:${newMaster.port}`,
        );
        this.eventEmitter.emit('master.elected', { master: newMaster });
      } catch (error) {
        this.logger.error(`Failed to configure master: ${error.message}`);
        return null;
      }
    }

    return newMaster;
  }

  getCurrentMaster(): RedisNode | null {
    return this.currentMaster;
  }

  getReplicas(): RedisNode[] {
    const nodes = this.nodeDiscoveryService.getNodes();
    return nodes.filter(
      (node) => node.role === 'replica' && node.status === 'active',
    );
  }

  getClusterStatus() {
    return {
      master: this.currentMaster,
      replicas: this.getReplicas(),
      healthy: !!this.currentMaster,
    };
  }
}
