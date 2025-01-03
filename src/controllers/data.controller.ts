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
import { DataService } from '../services/data.service';
import { ApiKeyGuard } from '../guards/api-key.guard';
import { WriteDataDto, WriteResult } from '../interfaces/data.interface';

@Controller('data')
export class DataController {
  constructor(private readonly dataService: DataService) {}

  @Post()
  @UseGuards(ApiKeyGuard)
  async writeData(@Body() data: WriteDataDto): Promise<{
    success: boolean;
    writtenTo: number;
    totalNodes: number;
    results: WriteResult[];
  }> {
    const results = await this.dataService.write(data.key, data.value);
    const successfulWrites = results.filter((r) => r.success).length;

    if (successfulWrites === 0) {
      throw new HttpException(
        'Failed to write to any node',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }

    return {
      success: true,
      writtenTo: successfulWrites,
      totalNodes: results.length,
      results,
    };
  }

  @Get(':key')
  @UseGuards(ApiKeyGuard)
  async readData(@Param('key') key: string) {
    const result = await this.dataService.read(key);
    if (!result) {
      throw new HttpException('Key not found', HttpStatus.NOT_FOUND);
    }
    return result;
  }
}
