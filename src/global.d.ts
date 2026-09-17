/// <reference types="vite/client" />

import type { GitAuditApi } from './types';

declare global {
  interface Window {
    gitAudit: GitAuditApi;
  }
}

export {};
