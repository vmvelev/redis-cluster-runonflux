import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClusterConfig } from '../config/cluster.config';

@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly configService: ConfigService<ClusterConfig>) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];
    const configuredApiKey = this.configService.get('apiKey');

    if (!configuredApiKey) {
      throw new UnauthorizedException(
        'API key is not configured on the server',
      );
    }

    if (!apiKey) {
      throw new UnauthorizedException('API key is missing');
    }

    if (apiKey !== configuredApiKey) {
      throw new UnauthorizedException('Invalid API key');
    }

    return true;
  }
}
