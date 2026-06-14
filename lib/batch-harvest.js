// 淘宝批量比价拉取：Agent 一次性给一批 {jdProductId, keyword, brand}，脚本自动逐个淘宝搜，
// 把每个京东品的淘宝候选写成 review-task 文件(供 Agent 最后统一看图比价)。
// 全程脚本自动，撞风控由调用方注入的 rotateAccount 自动换号续跑；断点续跑靠"已写过 review-task 的跳过"。
import { existsSync, mkdirSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * @param {object} params
 * @param {object} params.ctx 含 dataDir
 * @param {object} params.db
 * @param {Array<{jdProductId:string, keyword:string, brand?:string}>} params.tasks
 * @param {(page:object, keyword:string, opts:object)=>Promise<{candidates:any[],rejected:any[],stats:any}>} params.runTaobaoHarvest
 *        实际跑一次淘宝抓取的函数（注入，便于测试）。返回 candidates。
 * @param {()=>Promise<{page:object, account:object}>} params.openTaobaoSession 打开/获取淘宝会话
 * @param {(jd:object, candidates:any[], keyword:string)=>object} params.buildTask 生成 review-task 内容
 * @param {(jdProductId:string)=>object|null} params.getJdRow 从库里取京东品行
 * @param {(row:object)=>object} params.toJdProduct 行转 jdProduct
 * @param {object} [params.harvestOpts] 透传给淘宝抓取的参数(maxList/maxDetail/minSales/...)
 * @param {(level:string,msg:string)=>void} [params.log]
 * @returns {Promise<{processed:number, written:number, skipped:number, failed:number, perTask:any[]}>}
 */
export async function runTaobaoBatch(params) {
  const {
    ctx, tasks, runTaobaoHarvest, openTaobaoSession,
    buildTask, getJdRow, toJdProduct, harvestOpts = {}, log = () => {}
  } = params;

  const reviewDir = join(ctx?.dataDir || ".", "review-tasks");
  mkdirSync(reviewDir, { recursive: true });
  const alreadyDone = listExistingTaskProductIds(reviewDir);

  let session = await openTaobaoSession();
  const perTask = [];
  let written = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] || {};
    const jdProductId = String(t.jdProductId || "");
    const keyword = String(t.keyword || "").trim();
    if (!jdProductId || !keyword) {
      failed += 1;
      perTask.push({ jdProductId, keyword, status: "bad_input" });
      continue;
    }
    if (alreadyDone.has(jdProductId)) {
      skipped += 1;
      perTask.push({ jdProductId, keyword, status: "skipped_done" });
      continue;
    }

    const jdRow = getJdRow(jdProductId);
    if (!jdRow) {
      failed += 1;
      perTask.push({ jdProductId, keyword, status: "jd_not_found" });
      continue;
    }
    const jdProduct = toJdProduct(jdRow);

    // 撞风控时换号重试本关键词（最多换到没有可用号）
    let result = null;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await runTaobaoHarvest(session.page, keyword, {
          ...harvestOpts,
          brand: t.brand || "",
          account: session.account
        });
        break;
      } catch (e) {
        if (e && e.code === "RISK_CONTROL" && typeof params.rotateAccount === "function") {
          log("warn", `淘宝批量：关键词「${keyword}」撞风控，切换账号重试`);
          session = await params.rotateAccount(session.account, e);
          continue;
        }
        // 全部账号冷却(ALL_ACCOUNTS_COOLING)或其它错误：中断批量，返回已完成的部分
        log("warn", `淘宝批量中断于「${keyword}」：${e?.message || e}`);
        return { processed: i, written, skipped, failed, perTask, interrupted: true, error: e?.code || e?.message };
      }
    }

    const candidates = result?.candidates || [];
    const task = buildTask(jdProduct, candidates, keyword);
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const outPath = join(reviewDir, `${ts}_${jdProductId}.json`);
    writeFileSync(outPath, JSON.stringify({ task }, null, 2));
    alreadyDone.add(jdProductId);
    written += 1;
    perTask.push({ jdProductId, keyword, status: "written", candidateCount: candidates.length, file: outPath });
    log("info", `淘宝批量：${keyword} 拉到 ${candidates.length} 个候选，已写审核包`);
  }

  return { processed: tasks.length, written, skipped, failed, perTask, interrupted: false };
}

/** 读 review-tasks 目录里已存在的 task 文件，收集其 jdProductId，用于断点续跑跳过。 */
export function listExistingTaskProductIds(reviewDir) {
  const ids = new Set();
  if (!existsSync(reviewDir)) return ids;
  for (const f of readdirSync(reviewDir)) {
    if (!f.endsWith(".json")) continue;
    // 文件名格式 <ts>_<jdProductId>.json
    const m = f.match(/_(\d+)\.json$/);
    if (m) ids.add(m[1]);
  }
  return ids;
}
