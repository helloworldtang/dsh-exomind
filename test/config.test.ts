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
