import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeMcpTool } from "../mcp/runtime.mjs";

const originalDataDir = process.env.ECOMMERCE_SOURCING_DATA_DIR;
const dataDir = originalDataDir || mkdtempSync(join(tmpdir(), "ecommerce-sourcing-smoke-"));
process.env.ECOMMERCE_SOURCING_DATA_DIR = dataDir;

try {
  console.log(await executeMcpTool("ecommerce_sourcing", { action: "usage_guide" }));
  console.log(await executeMcpTool("ecommerce_sourcing", { action: "warmup" }));
} finally {
  if (originalDataDir) {
    process.env.ECOMMERCE_SOURCING_DATA_DIR = originalDataDir;
  } else {
    delete process.env.ECOMMERCE_SOURCING_DATA_DIR;
    rmSync(dataDir, { recursive: true, force: true });
  }
}
