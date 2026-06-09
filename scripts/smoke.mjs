import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execute as status } from "../tools/status.js";
import { execute as checkAccounts } from "../tools/check-accounts.js";

const dataDir = process.env.ECOMMERCE_SOURCING_DATA_DIR || mkdtempSync(join(tmpdir(), "ecommerce-sourcing-smoke-"));
const ctx = {
  dataDir,
  pluginId: "ecommerce-sourcing",
  config: {
    get() {
      return "";
    }
  },
  log: {
    info: console.log,
    warn: console.warn,
    error: console.error
  }
};

try {
  console.log(await status({ limit: 3 }, ctx));
  console.log(await checkAccounts({ platform: "all", probeLogin: false }, ctx));
} finally {
  if (!process.env.ECOMMERCE_SOURCING_DATA_DIR) {
    rmSync(dataDir, { recursive: true, force: true });
  }
}
