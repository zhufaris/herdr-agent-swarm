import { SqliteStoreKernel } from "./sqlite-store-kernel.js";

/**
 * Broad compatibility surface retained for migration and integration tests.
 * Production composition uses the capability bundle backed by SqliteStoreKernel.
 */
export class SqliteBindingStore extends SqliteStoreKernel {}
