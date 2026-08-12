import { NbverifyError } from '../errors.js';

/** @param {string} repoUrl @returns {string} OWNER/REPO */
export function githubSpec(repoUrl) {
  const m = repoUrl.match(/^(?:https?:\/\/github\.com\/)?([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) {
    throw new NbverifyError('PROVISIONING_FAILED', `not a GitHub repository URL: ${repoUrl}`);
  }
  return `${m[1]}/${m[2]}`;
}
