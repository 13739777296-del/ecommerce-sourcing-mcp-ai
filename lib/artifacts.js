import { mkdirSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

export async function capturePageScreenshot(ctx, db, runId, page, { platform, label, productId = "" }) {
  try {
    const filePath = join(artifactDir(ctx, runId), `${Date.now()}-${platform || "page"}-${safeName(label)}.png`);
    await page.screenshot({ path: filePath, fullPage: false, timeout: 8000 });
    db.saveArtifact(runId, {
      platform: platform || "",
      productId,
      artifactType: "page_screenshot",
      label,
      filePath,
      sourceUrl: page.url()
    });
    return filePath;
  } catch (error) {
    db.addLog(runId, "warning", `页面截图保存失败：${errorMessage(error)}`);
    return "";
  }
}

export async function captureLocatorScreenshot(ctx, db, runId, locator, { platform, label, productId = "", artifactType = "visual_crop", sourceUrl = "" }) {
  try {
    const filePath = join(artifactDir(ctx, runId), `${Date.now()}-${platform || "page"}-${safeName(label)}.png`);
    await locator.screenshot({ path: filePath, timeout: 8000 });
    db.saveArtifact(runId, {
      platform: platform || "",
      productId,
      artifactType,
      label,
      filePath,
      sourceUrl
    });
    return filePath;
  } catch (error) {
    db.addLog(runId, "warning", `${label}局部截图保存失败：${errorMessage(error)}`);
    return "";
  }
}

export async function captureClipScreenshot(ctx, db, runId, page, clip, { platform, label, productId = "", artifactType = "visual_crop" }) {
  try {
    const safeClip = normalizeClip(clip, page.viewportSize());
    if (!safeClip) throw new Error("截图区域无效");
    const filePath = join(artifactDir(ctx, runId), `${Date.now()}-${platform || "page"}-${safeName(label)}.png`);
    await page.screenshot({ path: filePath, clip: safeClip, timeout: 8000 });
    db.saveArtifact(runId, {
      platform: platform || "",
      productId,
      artifactType,
      label,
      filePath,
      sourceUrl: page.url()
    });
    return filePath;
  } catch (error) {
    db.addLog(runId, "warning", `${label}区域截图保存失败：${errorMessage(error)}`);
    return "";
  }
}

export async function saveProductImage(ctx, db, runId, product, label = "商品主图") {
  const imageUrl = product?.mainImageUrl || "";
  if (!imageUrl) return "";
  try {
    const response = await fetch(imageUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": product.platform === "jd" ? "https://www.jd.com/" : "https://www.taobao.com/"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length <= 0) throw new Error("空图片内容");
    const extension = imageExtension(imageUrl, response.headers.get("content-type"));
    const filePath = join(artifactDir(ctx, runId), `${product.platform}-${safeName(product.productId)}-${Date.now()}${extension}`);
    writeFileSync(filePath, buffer);
    db.saveArtifact(runId, {
      platform: product.platform,
      productId: product.productId,
      artifactType: "product_image",
      label,
      filePath,
      sourceUrl: imageUrl
    });
    return filePath;
  } catch (error) {
    db.addLog(runId, "warning", `${label}下载失败：${errorMessage(error)}`);
    return "";
  }
}

function artifactDir(ctx, runId) {
  const dir = join(ctx?.dataDir || process.cwd(), "artifacts", runId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function normalizeClip(clip, viewport) {
  if (!clip || clip.width <= 5 || clip.height <= 5) return null;
  const maxWidth = viewport?.width || 1920;
  const maxHeight = viewport?.height || 1080;
  const x = Math.max(0, Math.floor(clip.x));
  const y = Math.max(0, Math.floor(clip.y));
  const width = Math.min(maxWidth - x, Math.ceil(clip.width));
  const height = Math.min(maxHeight - y, Math.ceil(clip.height));
  if (width <= 5 || height <= 5) return null;
  return { x, y, width, height };
}

function imageExtension(url, contentType = "") {
  const fromType = String(contentType || "").toLowerCase();
  if (fromType.includes("png")) return ".png";
  if (fromType.includes("webp")) return ".webp";
  if (fromType.includes("avif")) return ".avif";
  if (fromType.includes("jpeg") || fromType.includes("jpg")) return ".jpg";
  const ext = extname(String(url).split("?")[0]).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp", ".avif"].includes(ext)) return ext;
  return ".jpg";
}

function safeName(value) {
  return String(value || "artifact").replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]+/g, "-").slice(0, 80) || "artifact";
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
