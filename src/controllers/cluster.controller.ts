import {
  Controller,
  Get,
  Post,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { MasterElectionService } from '../services/master-election.service';
import { HealthCheckService } from '../services/health-check.service';
import { RedisNode, ClusterStatus } from '../interfaces/redis-node.interface';

@Controller('cluster')
export class ClusterController {
  constructor(
    private readonly masterElectionService: MasterElectionService,
    private readonly healthCheckService: HealthCheckService,
  ) {}

  @Get('status')
  getClusterStatus(): ClusterStatus {
    return this.masterElectionService.getClusterStatus();
  }

  @Get('nodes')
  getAllNodes(): RedisNode[] {
    return this.healthCheckService.getAllNodesHealth();
  }

  @Get('master')
  getMaster(): RedisNode {
    const master = this.masterElectionService.getCurrentMaster();
    if (!master) {
      throw new HttpException('No master node available', HttpStatus.NOT_FOUND);
    }
    return master;
  }

  @Get('replicas')
  getReplicas(): RedisNode[] {
    return this.masterElectionService.getReplicas();
  }

  @Post('failover')
  async triggerFailover(): Promise<ClusterStatus> {
    await this.masterElectionService.handleFailover();
    return this.masterElectionService.getClusterStatus();
  }
}
