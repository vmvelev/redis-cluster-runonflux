export interface RedisNode {
  ip: string;
  port: number;
  role: 'master' | 'replica';
  status: 'active' | 'inactive';
  lastSeen: Date;
}

export interface ClusterStatus {
  master: RedisNode | null;
  replicas: RedisNode[];
  healthy: boolean;
}
