import { registerAs } from '@nestjs/config';

export interface ClusterConfig {
  fluxApi: string;
  appName: string;
  redisPort: number;
  redisPassword: string | null;
  apiKey: string;
  writeTimeout: number;
  syncScanCount: number;
  nodeDiscoveryInterval: number;
}

export const clusterConfig = registerAs(
  'cluster',
  (): ClusterConfig => ({
    fluxApi: process.env.FLUX_API_URL || 'https://api.runonflux.io',
    appName: process.env.APP_NAME || 'redis-cluster',
    redisPort: parseInt(process.env.REDIS_PORT, 10) || 6379,
    redisPassword: process.env.REDIS_PASSWORD || null,
    apiKey: process.env.API_KEY || '',
    writeTimeout: parseInt(process.env.WRITE_TIMEOUT, 10) || 5000,
    syncScanCount: parseInt(process.env.SYNC_SCAN_COUNT, 10) || 100,
    nodeDiscoveryInterval:
      parseInt(process.env.NODE_DISCOVERY_INTERVAL, 10) || 30000,
  }),
);
