export interface WriteResult {
  nodeIp: string;
  success: boolean;
  error?: string;
}

export interface WriteDataDto {
  key: string;
  value: string;
}

export interface ReadResult {
  value: string;
  timestamp: number;
}
