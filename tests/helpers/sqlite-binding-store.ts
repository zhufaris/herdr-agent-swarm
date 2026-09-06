import { SqliteStoreKernel } from "../../src/store/sqlite-store-kernel.js";

/** Legacy broad test driver. Production code must depend on named store capabilities. */
export class SqliteBindingStore extends SqliteStoreKernel {}
