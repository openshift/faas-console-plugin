export class HttpError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`HTTP ${status}: ${statusText}`);
  }
}

export interface AppError {
  message: string;
  code?: number;
}

export class ClusterError extends Error {
  constructor(
    readonly reason: string,
    readonly fullMessage: string,
  ) {
    super(`Deployment error. Reason: ${reason}.`);
  }
}
