import { createApp } from './app';
import { config } from './config';
import { prisma } from './db';
import { logger } from './logger';

async function main() {
  await prisma.$connect();
  const { app, redis } = createApp();

  const server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.nodeEnv },
      `URL Shortener listening on http://localhost:${config.port}`,
    );
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    server.close();
    await redis.quit();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch(async (err) => {
  logger.error({ err }, 'Failed to start server');
  await prisma.$disconnect();
  process.exit(1);
});
