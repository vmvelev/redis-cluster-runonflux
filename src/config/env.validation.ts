import { plainToClass, Transform } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsEnum,
  IsOptional,
  validateSync,
} from 'class-validator';

enum ReplicationMode {
  SYNC = 'sync',
  ASYNC = 'async',
}

enum ConsistencyLevel {
  ONE = 'one',
  QUORUM = 'quorum',
  ALL = 'all',
}

export class EnvironmentVariables {
  @IsString()
  @IsOptional()
  FLUX_API_URL?: string;

  @IsString()
  @IsOptional()
  APP_NAME?: string;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  REDIS_PORT?: number;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  POLL_INTERVAL?: number;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  HEALTH_CHECK_INTERVAL?: number;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  FAILOVER_TIMEOUT?: number;

  @IsEnum(ReplicationMode)
  @IsOptional()
  REPLICATION_MODE?: ReplicationMode;

  @IsEnum(ConsistencyLevel)
  @IsOptional()
  CONSISTENCY_LEVEL?: ConsistencyLevel;

  @IsString()
  @IsOptional()
  API_KEY?: string;

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToClass(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: true, // This is important!
    whitelist: true,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validatedConfig;
}

export interface AppConfig {
  fluxApiUrl: string;
  appName: string;
  redisPort: number;
  redisPassword: string;
  pollInterval: number;
  healthCheckInterval: number;
  failoverTimeout: number;
  replicationMode: ReplicationMode;
  consistencyLevel: ConsistencyLevel;
  syncWaitTime: number;
  apiKey: string;
}

// Helper function to get default configuration
export function getDefaultConfig(): AppConfig {
  return {
    fluxApiUrl: process.env.FLUX_API_URL || 'https://api.runonflux.io',
    appName: process.env.APP_NAME || 'redis-cluster',
    redisPort: parseInt(process.env.REDIS_PORT, 10) || 6379,
    redisPassword: process.env.REDIS_PASSWORD || '',
    pollInterval: parseInt(process.env.POLL_INTERVAL, 10) || 10000,
    healthCheckInterval:
      parseInt(process.env.HEALTH_CHECK_INTERVAL, 10) || 5000,
    failoverTimeout: parseInt(process.env.FAILOVER_TIMEOUT, 10) || 30000,
    replicationMode:
      (process.env.REPLICATION_MODE as ReplicationMode) ||
      ReplicationMode.ASYNC,
    consistencyLevel:
      (process.env.CONSISTENCY_LEVEL as ConsistencyLevel) ||
      ConsistencyLevel.ONE,
    syncWaitTime: parseInt(process.env.SYNC_WAIT_TIME, 10) || 5000,
    apiKey: process.env.API_KEY || '',
  };
}
