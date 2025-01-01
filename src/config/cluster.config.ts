import { registerAs } from '@nestjs/config';

export interface ClusterConfig {
  fluxApi: string;
  appName: string;
  redisPort: number;
  pollInterval: number;
  healthCheckInterval: number;
  failoverTimeout: number;
  replicationMode: 'sync' | 'async';
  consistencyLevel: 'one' | 'quorum' | 'all';
  syncWaitTime: number; // in milliseconds
  apiKey: string;
}

export const clusterConfig = registerAs('cluster', (): ClusterConfig => ({
  fluxApi: process.env.FLUX_API_URL || 'https://api.runonflux.io',
  appName: process.env.APP_NAME || 'redis-cluster',
  redisPort: parseInt(process.env.REDIS_PORT, 10) || 6379,
  pollInterval: parseInt(process.env.POLL_INTERVAL, 10) || 10000,
  healthCheckInterval: parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 5000,
  failoverTimeout: parseInt(process.env.FAILOVER_TIMEOUT, 10) || 30000,
  replicationMode: (process.env.REPLICATION_MODE as 'sync' | 'async') || 'async',
  consistencyLevel: (process.env.CONSISTENCY_LEVEL as 'one' | 'quorum' | 'all') || 'one',
  syncWaitTime: parseInt(process.env.SYNC_WAIT_TIME, 10) || 5000,
  apiKey: process.env.API_KEY || '',
}));