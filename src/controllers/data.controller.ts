import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpException,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { DataSyncService } from '../services/data-sync.service';
import { ApiKeyGuard } from '../guards/api-key.guard';

class WriteDataDto {
  key: string;
  value: string;
}

@Controller('data')
export class DataController {
  constructor(private readonly dataSyncService: DataSyncService) {}

  @Post()
  @UseGuards(ApiKeyGuard)
  async writeData(@Body() data: WriteDataDto) {
    try {
      await this.dataSyncService.write(data.key, data.value);
      return { success: true, message: 'Data written successfully' };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to write data',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get(':key')
  @UseGuards(ApiKeyGuard)
  async readData(@Param('key') key: string) {
    try {
      const value = await this.dataSyncService.read(key);
      if (value === null) {
        throw new HttpException('Key not found', HttpStatus.NOT_FOUND);
      }
      return { key, value };
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to read data',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('sync/status')
  @UseGuards(ApiKeyGuard)
  async getSyncStatus() {
    await this.dataSyncService.monitorReplicationStatus();
    return { message: 'Replication status monitored' };
  }
}
