type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, context?: LogContext) {
  const payload = {
    level,
    message,
    ...context,
    timestamp: new Date().toISOString(),
  };
  console.log(JSON.stringify(payload));
}

export const logger = {
  debug: (message: string, context?: LogContext) => log("debug", message, context),
  info: (message: string, context?: LogContext) => log("info", message, context),
  warn: (message: string, context?: LogContext) => log("warn", message, context),
  error: (message: string, context?: LogContext) => log("error", message, context),
};
