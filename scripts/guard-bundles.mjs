#!/usr/bin/env node
// `dsh plugin add` 会把宿主发现的所有 app bundle(acp/sdk/sdk-minimal/web 等)
// 塞回 profile 的 dsh.profile.bundles——多 app 争参,headless 一问一答报
// "too many arguments. Expected 0 arguments but got 1"×3(2026-11-10 两度踩实)。
// 本脚本幂等修剪 bundles 为规范集 [dsh-base, <app>, dsh-exomind]。
//
// 用法:
//   node scripts/guard-bundles.mjs                          # 默认 headless profile
//   node scripts/guard-bundles.mjs --profile headless --app @deepseek-ai/dsh-headless
// 每次 `dsh plugin add` 之后跑一遍;修剪后重启该 profile 生效。
// 校验: dsh --profile headless --dump-config | grep -c exomind-flywheel
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const profile = get("--profile", "headless");
const app = get("--app", `@deepseek-ai/dsh-${profile}`);
const dshHome = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const file = join(dshHome, "profiles", profile, "package.json");

let pkg;
try {
  pkg = JSON.parse(readFileSync(file, "utf-8"));
} catch (e) {
  console.error(`✗ 读不到 profile 文件 ${file}:${e.message}`);
  console.error(`  确认 profile 名,或用 --profile 指定(见 dsh --help)`);
  process.exit(1);
}

const before = pkg.dsh?.profile?.bundles ?? [];
const canonical = [...new Set(["@deepseek-ai/dsh-base", app, "dsh-exomind"])];
if (JSON.stringify(before) === JSON.stringify(canonical)) {
  console.log(`✓ ${profile} bundles 已是规范集,无需修剪`);
  process.exit(0);
}
pkg.dsh.profile.bundles = canonical;
writeFileSync(file, `${JSON.stringify(pkg, null, 2)}\n`);
console.log(`✓ 已修剪 ${profile} bundles:`);
console.log(`  前: ${JSON.stringify(before)}`);
console.log(`  后: ${JSON.stringify(canonical)}`);
console.log(
  `重启该 profile 生效;校验: dsh --profile ${profile} --dump-config | grep -c exomind-flywheel`,
);
