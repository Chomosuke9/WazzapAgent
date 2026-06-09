import pino from 'pino';
import config from './config.js';

const logger = pino({
  level: config.logLevel,
  base: { instanceId: config.instanceId },
});

export default logger;
