import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import Redis from 'ioredis';
import { RedisNode } from '../interfaces/redis-node.interface';
import { ClusterConfig } from '../config/cluster.config';

@Injectable()
export class RedisConnectionHandler {
  private readonly logger = new Logger(RedisConnectionHandler.name);
  private connections: Map<string, Redis> = new Map();
  private failedNodes: Set<string> = new Set();
  private connectionAttempts: Map<string, number> = new Map();
  private readonly MAX_RETRY_ATTEMPTS = 3;
  private readonly RETRY_RESET_TIME = 60000; // 1 minute

  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService<ClusterConfig>,
  ) {}

  getConnection(node: RedisNode): Redis | null {
    const key = `${node.ip}:${node.port}`;
    const redisPassword = this.configService.get('redisPassword');

    // If node is marked as failed and hasn't waited enough time, don't try to connect
    if (this.failedNodes.has(key)) {
      const attempts = this.connectionAttempts.get(key) || 0;
      if (attempts >= this.MAX_RETRY_ATTEMPTS) {
        return null;
      }
    }

    if (!this.connections.has(key)) {
      try {
        const connection = new Redis({
          host: node.ip,
          port: node.port,
          password: redisPassword,
          connectTimeout: 5000,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => {
            if (times > 3) return null; // Stop retrying after 3 attempts
            return Math.min(times * 100, 3000); // Exponential backoff
          },
          lazyConnect: true, // Don't connect immediately
        });

        // Handle connection errors
        connection.on('error', (error) => {
          // Only log if it's not a connection refused error
          if (!error.message.includes('ECONNREFUSED')) {
            this.logger.error(
              `Redis connection error for ${key}: ${error.message}`,
            );
          }

          // Track failed attempts
          const attempts = (this.connectionAttempts.get(key) || 0) + 1;
          this.connectionAttempts.set(key, attempts);

          if (attempts >= this.MAX_RETRY_ATTEMPTS) {
            this.failedNodes.add(key);
            this.removeConnection(key);

            // Schedule retry reset
            setTimeout(() => {
              this.failedNodes.delete(key);
              this.connectionAttempts.delete(key);
            }, this.RETRY_RESET_TIME);
          }
        });

        // Clear failed status on successful connection
        connection.on('connect', () => {
          this.failedNodes.delete(key);
          this.connectionAttempts.delete(key);
        });

        this.connections.set(key, connection);
      } catch (error) {
        this.logger.error(
          `Failed to create Redis connection for ${key}: ${error.message}`,
        );
        return null;
      }
    }

    return this.connections.get(key);
  }

  removeConnection(key: string) {
    const connection = this.connections.get(key);
    if (connection) {
      connection.disconnect();
      this.connections.delete(key);
    }
  }

  async closeAll() {
    for (const [key, connection] of this.connections.entries()) {
      try {
        await connection.quit();
      } catch (error) {
        this.logger.error(
          `Error closing Redis connection for ${key}: ${error.message}`,
        );
      } finally {
        connection.disconnect();
      }
    }
    this.connections.clear();
    this.failedNodes.clear();
    this.connectionAttempts.clear();
  }
}
