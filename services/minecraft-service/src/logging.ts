import { pino } from 'pino'

// Structured JSON to stdout, same shape discipline as the Java services:
// every line carries service; command handling adds correlationId via child().
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: { service: 'minecraft-service' },
  timestamp: pino.stdTimeFunctions.isoTime,
})
