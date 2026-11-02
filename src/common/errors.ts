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

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
