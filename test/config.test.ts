/** 质量点:凭据解析优先级(行配置 > 环境变量 > ~/.exomind/config.json > 默认)。 */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { DEFAULT_BASE_URL, resolveTarget } from "../src/config.js";

function tmpHome(config?: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "dsh-exomind-"));
  if (config) {
    mkdirSync(join(home, ".exomind"), { recursive: true });
    writeFileSync(join(home, ".exomind", "config.json"), JSON.stringify(config));
  }
  return home;
}

test("全部为空时回落默认 base,apiKey 为空串", () => {
  const home = tmpHome();
  const target = resolveTarget({}, { env: {}, homeDir: home });
  assert.equal(target.baseUrl, DEFAULT_BASE_URL);
  assert.equal(target.apiKey, "");
  rmSync(home, { recursive: true, force: true });
});

test("文件配置生效:继承 exomind login 写入的凭据", () => {
  const home = tmpHome({ base_url: "https://example.com", api_key: "k-file" });
  const target = resolveTarget({}, { env: {}, homeDir: home });
  assert.equal(target.baseUrl, "https://example.com");
  assert.equal(target.apiKey, "k-file");
  rmSync(home, { recursive: true, force: true });
});

test("环境变量覆盖文件,行配置覆盖环境变量", () => {
  const home = tmpHome({ base_url: "https://file.example.com", api_key: "k-file" });
  const viaEnv = resolveTarget({}, { env: { EXOMIND_API_KEY: "k-env" }, homeDir: home });
  assert.equal(viaEnv.baseUrl, "https://file.example.com");
  assert.equal(viaEnv.apiKey, "k-env");
  const viaRow = resolveTarget(
    { baseUrl: "https://row.example.com", apiKey: "k-row" },
    { env: { EXOMIND_API_KEY: "k-env" }, homeDir: home },
  );
  assert.equal(viaRow.baseUrl, "https://row.example.com");
  assert.equal(viaRow.apiKey, "k-row");
  rmSync(home, { recursive: true, force: true });
});

test("HOME 缺失(Windows 场景)回落 os.homedir,凭据仍能读到", () => {
  const home = tmpHome({ base_url: "https://example.com", api_key: "k-file" });
  const target = resolveTarget({}, { env: {}, homedir: () => home });
  assert.equal(target.apiKey, "k-file");
  rmSync(home, { recursive: true, force: true });
});

test("文件存在但 JSON 损坏:降级为空并警告,不是无声死局", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-exomind-"));
  mkdirSync(join(home, ".exomind"), { recursive: true });
  writeFileSync(join(home, ".exomind", "config.json"), "{ not json");
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (arg: unknown) => warnings.push(String(arg));
  try {
    const target = resolveTarget({}, { env: {}, homeDir: home });
    assert.equal(target.apiKey, "");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0] ?? "", /config\.json/);
  } finally {
    console.warn = originalWarn;
    rmSync(home, { recursive: true, force: true });
  }
});

test("Git Bash 场景:HOME 是 POSIX 形态且无文件,homedir(对齐 exomind-cli 落盘)生效", () => {
  const home = tmpHome({ base_url: "https://example.com", api_key: "k-file" });
  const target = resolveTarget({}, { env: { HOME: "/c/Users/someone" }, homedir: () => home });
  assert.equal(target.apiKey, "k-file");
  rmSync(home, { recursive: true, force: true });
});

test("HOME 兜底:homedir 无文件而 HOME 下手工放置的 config 仍可读到", () => {
  const empty = tmpHome(); // homedir 候选:无文件
  const manual = tmpHome({ api_key: "k-manual" }); // HOME 候选:有文件
  const target = resolveTarget({}, { env: { HOME: manual }, homedir: () => empty });
  assert.equal(target.apiKey, "k-manual");
  rmSync(empty, { recursive: true, force: true });
  rmSync(manual, { recursive: true, force: true });
});

test("BOM:Windows 记事本保存的 config.json(带 \\uFEFF 前缀)能正常解析", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-exomind-"));
  mkdirSync(join(home, ".exomind"), { recursive: true });
  writeFileSync(
    join(home, ".exomind", "config.json"),
    `\u{FEFF}${JSON.stringify({ api_key: "k-bom" })}`,
  );
  const target = resolveTarget({}, { env: {}, homeDir: home });
  assert.equal(target.apiKey, "k-bom");
  rmSync(home, { recursive: true, force: true });
});
