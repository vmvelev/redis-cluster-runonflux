// src/services/master-election.service.ts

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { RedisNode } from '../interfaces/redis-node.interface';
import { NodeDiscoveryService } from './node-discovery.service';
import { HealthCheckService } from './health-check.service';
import { AppConfig } from '../config/env.validation';

@Injectable()
export class MasterElectionService implements OnModuleInit {
  private readonly logger = new Logger(MasterElectionService.name);
  private currentMaster: RedisNode | null = null;
  private redisConnections: Map<string, Redis> = new Map();
  private failoverInProgress = false;
  private lastFailoverAttempt: number = 0;
  private failoverTimeout: number = 10000;
  private configuredNodes: Set<string> = new Set();

  constructor(
    private readonly configService: ConfigService<AppConfig>,
    private readonly nodeDiscoveryService: NodeDiscoveryService,
    private readonly healthCheckService: HealthCheckService,
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
        // Check for new healthy nodes that need to be configured
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
        // New healthy node detected, configure it as replica
        await this.configureNodeAsReplica(node, this.currentMaster);
      }
    });
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

  private async configureNodeAsReplica(node: RedisNode, master: RedisNode) {
    try {
      this.logger.debug(
        `Configuring new node ${node.ip} as replica of ${master.ip}`,
      );
      const redis = this.getRedisConnection(node);
      await redis.slaveof(master.ip, master.port.toString());
      node.role = 'replica';
      this.configuredNodes.add(node.ip);
      this.logger.log(`Configured ${node.ip} as replica of ${master.ip}`);
    } catch (error) {
      this.logger.error(
        `Failed to configure new replica ${node.ip}: ${error.message}`,
      );
    }
  }

  private getRedisConnection(node: RedisNode): Redis {
    const key = `${node.ip}:${node.port}`;
    if (!this.redisConnections.has(key)) {
      this.logger.debug(
        `Creating new Redis connection to ${node.ip}:${node.port}`,
      );
      const connection = new Redis({
        host: node.ip,
        port: node.port,
        connectTimeout: 5000,
        maxRetriesPerRequest: 1,
        retryStrategy: () => null,
      });

      connection.on('error', (error) => {
        this.logger.error(
          `Redis connection error for ${node.ip}: ${error.message}`,
        );
        if (this.currentMaster?.ip === node.ip) {
          this.handleFailover().catch((err) => {
            this.logger.error(`Failed to handle failover: ${err.message}`);
          });
        }
      });

      this.redisConnections.set(key, connection);
    }
    return this.redisConnections.get(key);
  }

  private async electMaster(): Promise<RedisNode | null> {
    if (this.failoverInProgress) {
      this.logger.warn('Failover in progress during election attempt');
      // Continue with election if we have no master
      if (this.currentMaster) {
        this.logger.warn('Current master exists, skipping election');
        return null;
      }
    }

    const nodes = this.nodeDiscoveryService.getNodes();
    this.logger.debug(
      `Available nodes for election: ${nodes
        .map((n) => `${n.ip}(${n.status})`)
        .join(', ')}`,
    );
    const healthyNodes = nodes.filter((node) => node.status === 'active');
    this.logger.debug(`Healthy nodes for election: ${healthyNodes.length}`);

    if (healthyNodes.length === 0) {
      this.logger.error('No healthy nodes available for master election');
      return null;
    }

    // Select the node that has been up the longest as master
    const newMaster = healthyNodes.reduce((a, b) => {
      this.logger.debug(
        `Comparing nodes for master election: ${a.ip}(${a.lastSeen}) vs ${b.ip}(${b.lastSeen})`,
      );
      return a.lastSeen > b.lastSeen ? a : b;
    });

    if (!this.currentMaster || this.currentMaster.ip !== newMaster.ip) {
      try {
        this.logger.debug(
          `Attempting to configure new master: ${newMaster.ip}`,
        );
        await this.configureMaster(newMaster);

        // Update roles
        newMaster.role = 'master';
        this.currentMaster = newMaster;
        this.logger.debug(
          `New master configuration successful: ${newMaster.ip}`,
        );

        // Configure replicas
        const replicas = healthyNodes.filter(
          (node) => node.ip !== newMaster.ip,
        );
        this.logger.debug(
          `Configuring replicas: ${replicas.map((r) => r.ip).join(', ')}`,
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

  private async configureMaster(node: RedisNode): Promise<void> {
    try {
      this.logger.debug(`Starting master configuration for ${node.ip}`);
      const redis = this.getRedisConnection(node);

      // Check if connection is valid
      try {
        await redis.ping();
      } catch (error) {
        throw new Error(`Cannot ping potential master node: ${error.message}`);
      }

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

      // Clean up old connections
      this.logger.debug('Cleaning up old Redis connections');
      for (const [key, connection] of this.redisConnections.entries()) {
        this.logger.debug(`Disconnecting from ${key}`);
        connection.disconnect();
        this.redisConnections.delete(key);
      }

      // Wait a short time for health checks to update
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
      // Reset failover flag on error
      this.failoverInProgress = false;
      throw error;
    } finally {
      this.failoverInProgress = false;
    }
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

  // Clean up when module is destroyed
  async onModuleDestroy() {
    for (const connection of this.redisConnections.values()) {
      connection.disconnect();
    }
  }
}
