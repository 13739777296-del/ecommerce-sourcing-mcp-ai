#!/usr/bin/env node
import { homedir } from 'node:os';
import { openAiSession, aiJdHarvest } from '../lib/ai-controller.js';

const JD1 = homedir() + '/Library/Application Support/电商选品智能体/browser-profiles/accounts/jd/0b8e87b1-d8c1-4910-a176-e0aa474576f7';

async function main() {
  const s = await openAiSession(JD1);
  console.log('=== 京东选品(新逻辑:收店名→搜店→进详情) ===');
  const r = await aiJdHarvest(s.page, 'swisse', {
    targetCount: 5,
    maxPagesPerShop: 1,
    screenshotDir: '/tmp/jd-test/shots'
  });
  console.log('通过(评价>2):', r.candidates.length, '| 共拉:', r.stats.totalHarvested);
  r.candidates.slice(0, 5).forEach((c, i) =>
    console.log((i + 1) + '. ' + (c.title || '').slice(0, 22) + ' ¥' + c.price + ' 评' + c.commentsNum + ' ' + c.shop)
  );
  const fs = await import('node:fs');
  const dir = '/tmp/jd-test/shots';
  if (fs.existsSync(dir)) console.log('截图:', fs.readdirSync(dir).length, '个');
  process.exit(0);
}
main().catch(e => { console.error('异常:', e.message); process.exit(1); });
