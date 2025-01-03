import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';
import { ClusterConfig } from '../config/cluster.config';
import { SyncStatus } from '../interfaces/sync.interface';

@Injectable()
export class SyncService {
  private readonly logger = new Logger(SyncService.name);
  private readonly SYNC_KEY = '__node_sync_status';
  private readonly SYNC_LOCK_KEY = '__node_sync_lock';
  private readonly instanceId: string;
  private readonly LOCK_TIMEOUT = 60000; // 1 minute lock timeout

  constructor(private readonly configService: ConfigService<ClusterConfig>) {
    // Generate unique ID for this app instance
    this.instanceId = uuidv4();
  }

  private async acquireSyncLock(
    redis: Redis,
    nodeIp: string,
  ): Promise<boolean> {
    const lockKey = `${this.SYNC_LOCK_KEY}:${nodeIp}`;

    // Try to set lock with our instance ID and expiry
    const result = await redis.set(
      lockKey,
      this.instanceId,
      'PX', // Set expiry in milliseconds
      this.LOCK_TIMEOUT,
      'NX', // Only set if not exists
    );

    return result === 'OK';
  }

  private async releaseSyncLock(redis: Redis, nodeIp: string): Promise<void> {
    const lockKey = `${this.SYNC_LOCK_KEY}:${nodeIp}`;

    // Only delete if we own the lock
    const script = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      else
        return 0
      end
    `;

    await redis.eval(script, 1, lockKey, this.instanceId);
  }

  async getSyncStatus(redis: Redis): Promise<SyncStatus> {
    try {
      const status = await redis.get(this.SYNC_KEY);
      if (!status) return { status: 'pending' };

      const syncStatus: SyncStatus = JSON.parse(status);

      // Check if sync is stuck (in progress for too long)
      if (
        syncStatus.status === 'in_progress' &&
        syncStatus.syncStarted &&
        Date.now() - syncStatus.syncStarted > this.LOCK_TIMEOUT
      ) {
        return { status: 'pending' };
      }

      return syncStatus;
    } catch (error) {
      this.logger.error(`Failed to get sync status: ${error.message}`);
      return { status: 'failed', error: error.message };
    }
  }

  async setSyncStatus(redis: Redis, status: SyncStatus): Promise<void> {
    try {
      await redis.set(
        this.SYNC_KEY,
        JSON.stringify({
          ...status,
          lastSync: Date.now(),
          syncBy: this.instanceId,
        }),
      );
    } catch (error) {
      this.logger.error(`Failed to set sync status: ${error.message}`);
      throw error;
    }
  }

  async copyDataFromSource(
    source: Redis,
    target: Redis,
    nodeIp: string,
  ): Promise<void> {
    const scanCount = this.configService.get('syncScanCount');
    let cursor = '0';

    try {
      // Acquire lock before starting sync
      if (!(await this.acquireSyncLock(target, nodeIp))) {
        throw new Error(
          'Could not acquire sync lock - another instance may be syncing',
        );
      }

      // Update status to in_progress
      await this.setSyncStatus(target, {
        status: 'in_progress',
        syncStarted: Date.now(),
      });

      do {
        // Scan keys in batches
        const [newCursor, keys] = await source.scan(cursor, 'COUNT', scanCount);
        cursor = newCursor;

        // Skip internal sync and lock keys
        const filteredKeys = keys.filter(
          (key) => !key.startsWith('__node_sync'),
        );

        if (filteredKeys.length > 0) {
          // Get all values for the current batch of keys
          const values = await source.mget(filteredKeys);

          // Create pipeline for batch writing
          const pipeline = target.pipeline();
          filteredKeys.forEach((key, index) => {
            if (values[index]) {
              pipeline.set(key, values[index]);
            }
          });

          await pipeline.exec();
          this.logger.debug(`Synchronized ${filteredKeys.length} keys`);
        }
      } while (cursor !== '0');

      // Mark as synchronized
      await this.setSyncStatus(target, { status: 'synchronized' });
    } catch (error) {
      this.logger.error(`Data synchronization failed: ${error.message}`);
      await this.setSyncStatus(target, {
        status: 'failed',
        error: error.message,
      });
      throw error;
    } finally {
      // Always release the lock when done
      await this.releaseSyncLock(target, nodeIp);
    }
  }
}
