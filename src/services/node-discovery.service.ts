import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { RedisNode } from '../interfaces/redis-node.interface';
import { ClusterConfig } from '../config/cluster.config';

@Injectable()
export class NodeDiscoveryService {
  private readonly logger = new Logger(NodeDiscoveryService.name);
  private nodes: RedisNode[] = [];

  constructor(private configService: ConfigService<ClusterConfig>) {}

  async discoverNodes(): Promise<RedisNode[]> {
    try {
      const fluxApiUrl = this.configService.get('fluxApi');
      const appName = this.configService.get('appName');
      const redisPort = this.configService.get('redisPort');

      const response = await axios.get(
        `${fluxApiUrl}/apps/location/${appName}`,
      );

      if (response.data.status === 'success') {
        this.nodes = response.data.data.map((node) => ({
          ip: node.ip.includes(':') ? node.ip.split(':')[0] : node.ip,
          port: redisPort,
        }));

        this.logger.log(`Discovered ${this.nodes.length} Redis nodes`);
        return this.nodes;
      }

      throw new Error('Failed to discover nodes');
    } catch (error) {
      this.logger.error(`Node discovery failed: ${error.message}`);
      throw error;
    }
  }

  getNodes(): RedisNode[] {
    return this.nodes;
  }
}
