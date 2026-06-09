#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount, aiTaobaoSearch } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function screenshot() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "taobao");
  await aiTaobaoSearch(session.page, "MYPROTEIN 1000g");

  await session.page.waitForTimeout(3000);
  await session.page.screenshot({ path: '/tmp/taobao-list.png', fullPage: true });

  console.log("截图已保存: /tmp/taobao-list.png");
  console.log(`URL: ${session.page.url()}`);

  await session.page.waitForTimeout(30000);
  process.exit(0);
}

screenshot();
