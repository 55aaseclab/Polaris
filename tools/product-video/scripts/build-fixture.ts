/**
 * Build a synthetic workspace + seed input for smoke-testing product-video.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createProduct, writeJsonFile, writeProductMeta } from "@polaris/business-core";
import { defaultVideoInput, parseVideoInput } from "../src/validate.js";
import { findFfmpeg } from "../src/paths.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = path.resolve(__dirname, "..");
const FIXTURE_ROOT = path.join(TOOL_ROOT, "test", "fixtures", "workspace");

function run(cmd: string, args: string[]): void {
  const r = spawnSync(cmd, args, { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`${cmd} failed: ${r.stderr || r.stdout}`);
  }
}

function makeImage(outPath: string, color: string, label: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  run("convert", [
    "-size",
    "1080x1920",
    `xc:${color}`,
    "-gravity",
    "center",
    "-pointsize",
    "72",
    "-fill",
    "white",
    "-annotate",
    "0",
    label,
    outPath,
  ]);
}

function makeBgm(outPath: string): void {
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const ffmpeg = findFfmpeg();
  // soft stereo pad tone ~20s
  run(ffmpeg, [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:duration=20",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=554.37:duration=20",
    "-filter_complex",
    "[0:a][1:a]amix=inputs=2:duration=first,volume=0.25",
    "-c:a",
    "aac",
    outPath,
  ]);
}

function main(): void {
  const productId = 90001;
  const sku = "SKU-3-2-001";
  fs.rmSync(path.join(FIXTURE_ROOT, "产品管理", "产品库", sku), {
    force: true,
    recursive: true,
  });
  const product = createProduct(FIXTURE_ROOT, {
    id: productId,
    name: "测试种子吊坠",
    sku,
    skuSubcategory: "pendants",
  });
  const productDir = product.path;
  const near = path.join(productDir, "01_单品近景", "near.jpg");
  const wear = path.join(productDir, "02_佩戴使用", "wear.jpg");
  const detail = path.join(productDir, "03_工艺细节", "detail.jpg");
  makeImage(near, "#2c3e50", "NEAR");
  makeImage(wear, "#8e44ad", "WEAR");
  makeImage(detail, "#16a085", "DETAIL");

  const figuresDir = path.posix.join(
    "产品管理",
    "产品库",
    sku,
  );
  const meta = {
    schema: "wanghai.promo.product-meta",
    schema_version: 5,
    sku,
    sku_category: "hang",
    sku_subcategory: "pendants",
    id: productId,
    name: "测试种子吊坠",
    name_en: "Seed Pendant Demo",
    status: "ready",
    inventory: 10,
    source: null,
    packaging: {
      normal: {
        dimensions_mm: { length: 40, width: 30, height: 10 },
        weight_with_packaging_kg: 0.05,
      },
      gift: {
        dimensions_mm: { length: 50, width: 40, height: 20 },
        weight_with_packaging_kg: 0.08,
      },
    },
    pricing: {
      default_market: "CN",
      costs: {
        currency: "CNY",
        purchase_price: 10,
        packaging_price: 2,
        labor_price: 1,
      },
      markets: {
        CN: {
          currency: "CNY",
          list_price: 99,
          promo_price: 79,
          floor_price: 50,
        },
      },
    },
    copy: {
      title: "测试种子吊坠",
      selling_points: ["轻盈佩戴", "细节耐看", "日常百搭"],
      description: "Fixture product for video tool smoke test.",
      faq: [],
    },
    assets: {
      figures_dir: figuresDir,
      source_dir: `${figuresDir}/assets`,
      selected: {
        near: `${figuresDir}/01_单品近景/near.jpg`,
        wear: `${figuresDir}/02_佩戴使用/wear.jpg`,
        detail: `${figuresDir}/03_工艺细节/detail.jpg`,
      },
      promo_usage_image: null,
    },
    notes: ["fixture"],
    include_in_external: true,
  };
  writeProductMeta(product.metaPath, meta);

  const bgmRel = "产品管理/素材库/audio/fixture-bgm.m4a";
  const bgmAbs = path.join(FIXTURE_ROOT, bgmRel);
  makeBgm(bgmAbs);

  const videoId = "seed-pendant-demo-v1";
  const input = defaultVideoInput({
    video_id: videoId,
    product_id: productId,
    bgm_path: bgmRel,
    platform: "douyin",
    purpose: "seed",
    locale: "zh",
    hook: "3秒种草这枚吊坠",
    cta: "评论区扣链接拿同款",
  });
  // Prefer ASCII captions for environments without CJK fonts
  input.script.beats[0]!.text = "3s hook: seed pendant";
  input.script.beats[1]!.text = "Wear look — remember it";
  input.script.beats[2]!.text = "Detail craft close-up";
  input.script.beats[3]!.text = "Comment for the link";
  input.script.hook = "3s hook: seed pendant";
  input.script.cta = "Comment for the link";
  parseVideoInput(input);

  const inputPath = path.join(TOOL_ROOT, "examples", "seed-demo.input.json");
  fs.mkdirSync(path.dirname(inputPath), { recursive: true });
  writeJsonFile(inputPath, input);

  // also copy into case inputs for convenience
  const caseInput = path.join(
    FIXTURE_ROOT,
    "产品管理",
    "交付归档",
    "videos",
    videoId,
    "inputs",
    "input.json",
  );
  fs.mkdirSync(path.dirname(caseInput), { recursive: true });
  writeJsonFile(caseInput, input);

  console.log(
    JSON.stringify(
      {
        workspace: FIXTURE_ROOT,
        input: inputPath,
        product_id: productId,
        bgm: bgmRel,
      },
      null,
      2,
    ),
  );
}

main();
