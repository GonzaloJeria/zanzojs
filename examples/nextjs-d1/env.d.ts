import type { D1Database } from '@cloudflare/workers-types';

declare global {
  interface CloudflareEnv {
    DB: D1Database;
  }
  
  namespace NodeJS {
    interface ProcessEnv extends CloudflareEnv {}
  }
}

export {};
