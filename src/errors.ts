export type ErrorCode =
  | 'PROVISIONING_FAILED'
  | 'SERVER_UNREACHABLE'
  | 'AUTHENTICATION_FAILED'
  | 'FILE_NOT_FOUND'
  | 'TOOL_UNAVAILABLE'
  | 'EXECUTION_FAILED'
  | 'EXECUTION_TIMEOUT'
  | 'DOWNLOAD_FAILED';

export class NbverifyError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string
  ) {
    super(`${code}: ${message}`);
  }
}

/** Map an error to the process exit code defined in SPEC.md. */
export function exitCodeFor(err: unknown): number {
  const code = err instanceof NbverifyError ? err.code : undefined;
  switch (code) {
    case 'PROVISIONING_FAILED':
      return 3;
    case 'SERVER_UNREACHABLE':
    case 'AUTHENTICATION_FAILED':
    case 'DOWNLOAD_FAILED':
      return 4;
    case 'TOOL_UNAVAILABLE':
      return 5;
    default:
      return 1;
  }
}
