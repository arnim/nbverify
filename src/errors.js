export class NbverifyError extends Error {
  /**
   * @param {string} code one of PROVISIONING_FAILED, SERVER_UNREACHABLE,
   *   AUTHENTICATION_FAILED, FILE_NOT_FOUND, TOOL_UNAVAILABLE,
   *   EXECUTION_FAILED, EXECUTION_TIMEOUT, DOWNLOAD_FAILED
   * @param {string} message
   */
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

/** Map an error to the process exit code defined in docs/specification.md. */
export function exitCodeFor(err) {
  switch (err?.code) {
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
