import { plainToClass, Transform } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsOptional,
  validateSync,
  Min,
} from 'class-validator';

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

  @IsString()
  @IsOptional()
  REDIS_PASSWORD?: string;

  @IsString()
  @IsOptional()
  API_KEY?: string;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  WRITE_TIMEOUT?: number;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  @Min(5000)
  NODE_DISCOVERY_INTERVAL?: number;

  @IsNumber()
  @IsOptional()
  @Transform(({ value }) => (value ? parseInt(value, 10) : undefined))
  @Min(10)
  SYNC_SCAN_COUNT?: number;
}

export function validate(config: Record<string, unknown>) {
  const validatedConfig = plainToClass(EnvironmentVariables, config, {
    enableImplicitConversion: true,
  });

  const errors = validateSync(validatedConfig, {
    skipMissingProperties: true,
    whitelist: true,
  });

  if (errors.length > 0) {
    throw new Error(errors.toString());
  }
  return validatedConfig;
}

export interface AppConfig {
  fluxApi: string;
  appName: string;
  redisPort: number;
  redisPassword: string;
  apiKey: string;
  writeTimeout: number;
  nodeDiscoveryInterval: number;
  syncScanCount: number;
}

// Helper function to get default configuration
export function getDefaultConfig(): AppConfig {
  return {
    fluxApi: process.env.FLUX_API_URL || 'https://api.runonflux.io',
    appName: process.env.APP_NAME || 'redis-cluster',
    redisPort: parseInt(process.env.REDIS_PORT, 10) || 6379,
    redisPassword: process.env.REDIS_PASSWORD || '',
    apiKey: process.env.API_KEY || '',
    writeTimeout: parseInt(process.env.WRITE_TIMEOUT, 10) || 5000,
    nodeDiscoveryInterval:
      parseInt(process.env.NODE_DISCOVERY_INTERVAL, 10) || 30000,
    syncScanCount: parseInt(process.env.SYNC_SCAN_COUNT, 10) || 100,
  };
}
