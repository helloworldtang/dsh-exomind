/** 质量点:①结构化 credential 各形态命中并打码 ②title 同扫(title 是独立出站字段)
 *  ③命中超阈值整条放弃 ④正常技术文本零误伤 ⑤打码后不可还原。 */
import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeDigest } from "../src/sanitize.js";

test("各 secret 形态命中打码,保留 4 字符前缀可辨认", () => {
  const content = [
    "OpenAI: sk-proj4AbCdEf0123456789ABCDEFG",
    "AWS: AKIAIOSFODNN7EXAMPLE",
    "GitHub: ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "curl -H 'Authorization: Bearer Ya29.a0AfH6SMBxN0Kq'",
    "JWT: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV",
  ].join("\n");
  const { content: out, masked, dropped } = sanitizeDigest(content, "普通标题");
  assert.equal(masked, 5);
  assert.equal(dropped, false);
  assert.match(out, /sk-p\*\*\*REDACTED\*\*\*/);
  assert.match(out, /AKIA\*\*\*REDACTED\*\*\*/);
  assert.match(out, /ghp_\*\*\*REDACTED\*\*\*/);
  assert.match(out, /Bearer \*\*\*REDACTED\*\*\*/);
  assert.match(out, /eyJh\*\*\*REDACTED\*\*\*/);
  assert.doesNotMatch(out, /0123456789ABCDEFG|IOSFODNN7EXAMPLE|SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV/);
});

test("PEM 私钥块整块替换(含多行)", () => {
  const pem = [
    "-----BEGIN RSA PRIVATE KEY-----",
    "MIIEpAIBAAKCAQEA7k9x",
    "secondlineOfKeyMaterial",
    "-----END RSA PRIVATE KEY-----",
  ].join("\n");
  const { content, masked } = sanitizeDigest(`签个名:\n${pem}\n结束`, "t");
  assert.equal(masked, 1);
  assert.match(content, /\[REDACTED:PEM 私钥块\]/);
  assert.doesNotMatch(content, /MIIEpAIBAAKCAQEA7k9x|secondlineOfKeyMaterial/);
});

test("title 同扫:密钥进了任务首句也在标题里被打码", () => {
  const { title, masked } = sanitizeDigest(
    "正文没有密钥",
    "DSH 会话:调试 sk-abcdef0123456789abcdef012",
  );
  assert.equal(masked, 1);
  assert.match(title, /sk-a\*\*\*REDACTED\*\*\*/);
});

test("零误伤:正常中文/URL/代码/版本号不打码", () => {
  const clean = [
    "插件版本 0.4.0,DSH 0.2.2-rc.5,Node 22",
    "文档在 https://exomind.ai-as.cn/docs?a=1&b=2",
    "const x = eyJlike_but_not; console.log(12345678)",
    "密钥管理制度要落实,sk 开头的都要管",
  ].join("\n");
  const { content, masked, dropped } = sanitizeDigest(clean, "DSH 会话:正常讨论");
  assert.equal(masked, 0);
  assert.equal(dropped, false);
  assert.equal(content, clean);
});

test("命中超阈值:整条放弃", () => {
  const dump = Array.from({ length: 11 }, (_, i) => `sk-batch${i}0123456789abcdef0123456789`).join(
    "\n",
  );
  const { dropped, masked } = sanitizeDigest(dump, "t");
  assert.equal(masked, 11);
  assert.equal(dropped, true);
});
