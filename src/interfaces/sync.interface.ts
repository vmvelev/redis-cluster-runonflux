export interface SyncStatus {
  status: 'pending' | 'synchronized' | 'failed' | 'in_progress';
  lastSync?: number;
  error?: string;
  syncBy?: string; // Instance ID of the app performing sync
  syncStarted?: number;
}
