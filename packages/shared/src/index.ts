export const PRODUCT_NAME = 'OpenBot';

export type PackageName = `@openbot/${string}`;

export function packageName(name: string): PackageName {
  return `@openbot/${name}`;
}

export * from './limits.js';
export * from './events.js';
export * from './notices.js';
export * from './queue.js';
export * from './bots.js';
export * from './parts.js';
export * from './providers.js';
export * from './policy.js';
export * from './artifacts.js';
export * from './computer.js';
export * from './routines.js';
export * from './skills.js';
export * from './webhooks.js';
