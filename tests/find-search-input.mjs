#!/usr/bin/env node

import { createContext } from "../mcp/runtime.mjs";
import { openSourcingDb } from "../lib/db.js";
import { openAiSessionWithAccount } from "../lib/ai-controller.js";
import { profileSummary } from "../lib/accounts.js";

async function findSearchBox() {
  const ctx = createContext();
  const db = openSourcingDb(ctx);
  profileSummary(ctx, db);

  const session = await openAiSessionWithAccount(ctx, db, "jd");
  const page = session.page;

  await page.goto("https://www.jd.com");
  await page.waitForTimeout(3000);

  // 找所有input
  const inputs = await page.evaluate(() => {
    const allInputs = document.querySelectorAll('input');
    return Array.from(allInputs).map((input, i) => ({
      index: i,
      id: input.id,
      name: input.name,
      type: input.type,
      className: input.className,
      placeholder: input.placeholder,
      visible: input.offsetWidth > 0 && input.offsetHeight > 0,
      value: input.value
    }));
  });

  console.log("=== 所有input元素 ===\n");
  console.log(JSON.stringify(inputs.filter(i => i.visible || i.id || i.name), null, 2));

  await page.waitForTimeout(30000);
  process.exit(0);
}

findSearchBox();
