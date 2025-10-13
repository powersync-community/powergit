import type {
  AbstractPowerSyncDatabase,
  PowerSyncBackendConnector,
  PowerSyncCredentials,
} from '@powersync/node';

export interface DaemonConnectorOptions {
  endpoint?: string;
  token?: string;
  credentialsProvider?: () => Promise<PowerSyncCredentials | null>;
  uploadHandler?: (db: AbstractPowerSyncDatabase) => Promise<void>;
}

export class DaemonPowerSyncConnector implements PowerSyncBackendConnector {
  private readonly endpoint?: string;
  private readonly token?: string;
  private readonly credentialsProvider?: () => Promise<PowerSyncCredentials | null>;
  private readonly uploadHandler?: (db: AbstractPowerSyncDatabase) => Promise<void>;
  private warnedMissingUpload = false;

  constructor(options: DaemonConnectorOptions = {}) {
    this.endpoint = options.endpoint;
    this.token = options.token;
    this.credentialsProvider = options.credentialsProvider;
    this.uploadHandler = options.uploadHandler;
  }

  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    if (this.endpoint && this.token) {
      return { endpoint: this.endpoint, token: this.token };
    }

    if (this.credentialsProvider) {
      const credentials = await this.credentialsProvider().catch((error) => {
        console.warn('[powersync-daemon] credential provider rejected', error);
        return null;
      });
      if (credentials) {
        return credentials;
      }
    }

    console.error('[powersync-daemon] missing PowerSync credentials; set POWERSYNC_DAEMON_ENDPOINT and POWERSYNC_DAEMON_TOKEN');
    return null;
  }

  async uploadData(db: AbstractPowerSyncDatabase): Promise<void> {
    if (this.uploadHandler) {
      await this.uploadHandler(db);
      return;
    }

    if (!this.warnedMissingUpload) {
      console.warn('[powersync-daemon] upload handler not configured; CRUD batches will remain queued');
      this.warnedMissingUpload = true;
    }
  }
}
