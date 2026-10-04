/** Who a piece of work is for. Set per request (and per task run) and read anywhere below. */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface Ctx { userId: string }
const als = new AsyncLocalStorage<Ctx>();
export const OWNER_ID = 'user_owner';

export const runAs = <T>(userId: string, fn: () => T): T => als.run({ userId }, fn);
/** The current user, or the instance owner for background work started by AUDA itself. */
export const currentUserId = (): string => als.getStore()?.userId ?? OWNER_ID;
