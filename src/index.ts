import {
  NexxusConfigManager,
  NexxusBaseLogger,
  FatalErrorException,
  type INexxusBaseServices,
} from '@mayhem93/nexxus-core-lib';
import { NexxusRedis } from '@mayhem93/nexxus-redis';
import { NexxusWebsocketsTransportWorker, NexxusWebsocketsTransportWorkerConfig } from '@mayhem93/nexxus-worker-lib';
import type { NexxusDatabaseAdapter } from '@mayhem93/nexxus-database-lib';
import type { NexxusMessageQueueAdapter } from '@mayhem93/nexxus-message-queue-lib';

let logger: NexxusBaseLogger<any> | undefined;
let configManager: NexxusConfigManager | undefined;

(async () => {
  configManager = new NexxusConfigManager();

  // Register the framework-fixed services (API + Redis are not pluggable)
  // so we can read `app.logger` / `app.database` / `app.message_queue`.
  await configManager.validateServices([NexxusWebsocketsTransportWorker, NexxusRedis]);

  const workerConfig = configManager.getConfig('app') as NexxusWebsocketsTransportWorkerConfig; //TODO: fix nexxus-lib NexxusWebsocketsTransportWorkerConfig export

  const LoggerClass = await NexxusWebsocketsTransportWorker.resolveFactoryService(configManager, workerConfig.logger);
  const DbClass     = await NexxusWebsocketsTransportWorker.resolveConstructableService(configManager, workerConfig.database);
  const MqClass     = await NexxusWebsocketsTransportWorker.resolveConstructableService(configManager, workerConfig.message_queue);

  // Validate the rest of the services that were added thourgh the resolveService calls above
  await configManager.validateServices();

  // Logger services intentionally have no `logger` field — a logger can't
  // depend on itself. `NexxusFactoryServiceClass.create` types services as
  // full `INexxusBaseServices`, so cast at this one call site.
  const loggerInstance = await LoggerClass.create({ configManager } as INexxusBaseServices);

  if (!(loggerInstance instanceof NexxusBaseLogger)) {
    throw new FatalErrorException(
      `Class resolved for "${workerConfig.logger}" did not produce a NexxusBaseLogger instance.`
    );
  }

  logger = loggerInstance;

  const db    = new DbClass({ configManager, logger }) as NexxusDatabaseAdapter<any, any>;
  const mq    = new MqClass({ configManager, logger }) as NexxusMessageQueueAdapter<any, any, any>;
  const redis = new NexxusRedis({ configManager, logger });
  const worker   = new NexxusWebsocketsTransportWorker({ configManager, logger, database: db, messageQueue: mq, redis });

  await worker.init();

  const shutdown = (): void => {
    worker.close();
  };

  process.once('SIGTERM', shutdown);
  process.once('SIGINT',  shutdown);
})().catch((err: unknown) => {
  const message = err instanceof Error ? (err.stack ?? err.message) : String(err);

  if (logger) {
    logger.emerg(message, 'NxxWebsocketsTransport');
  } else {
    configManager!.fallbackLogger.emerg(`Fatal error: ${message}`, { error: message }, 'NxxWebsocketsTransport');
  }

  if (err instanceof FatalErrorException) {
    process.exit(1);
  }

  throw err;
});
