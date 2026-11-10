# dsh-exomind

把 [ExoMind 知识飞轮](https://exomind.ai-as.cn)接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH):为 agent 提供三个工具,让它直接检索和问答你的个人知识库——实体图谱、经验沉淀、踩坑记录。

与本地记忆插件不同,ExoMind 是**服务端知识飞轮**(实体/关系图谱 + FSRS 复习),同一份记忆同时服务 Claude Code(MCP/CLI)、小程序、浏览器插件与本插件,换 harness 不丢记忆。

## 工具

| 工具             | 用途                                                  | 速度                  |
| ---------------- | ----------------------------------------------------- | --------------------- |
| `exomind_search` | 全文/语义检索(BM25,可选 hybrid 向量混合、rerank 精排) | 秒级,优先使用         |
| `exomind_entity` | 查实体详情:定义、别名、关联实体                       | 秒级                  |
| `exomind_query`  | 跨多页知识的 LLM 深度问答                             | 慢(1-2 分钟),仅深问题 |

## 安装

> 前置:DSH 0.1.0-rc.5+(preview 阶段 API 在变,本插件按 0.2.1-rc 系列验证);Node 22+;已用 `exomind login` 登录过 ExoMind(见下"凭据")。

```bash
dsh plugin --profile <你的profile> add github:helloworldtang/dsh-exomind#v0.3.0
dsh --profile <你的profile> --dump-config   # 应看到 id: exomind-flywheel 的 bundle 行
# 重启该 profile 后生效
```

⚠️ 引用请锁定 tag(`#vX.Y.Z`),不要引滚动分支——升级必须是显式改版本号的决策。

## 凭据

优先级(高 → 低):

1. DSH 行配置的 `baseUrl` / `apiKey`
2. 环境变量 `EXOMIND_BASE_URL` / `EXOMIND_API_KEY`
3. `~/.exomind/config.json`(与 [exomind-cli](https://github.com/helloworldtang/exomind-cli) 共享,`exomind login` 写入)

即:装好 exomind-cli 并 `exomind login` 后,本插件零配置可用;换 key 也只需 `exomind login`,无需重启 DSH(每次工具调用时解析凭据)。

## 自动召回(v0.2.0+)

每条**直接用户消息**进入 agent 前,插件自动做一次有界 BM25 检索,把命中包进 `<exomind_context>` 注入到该消息之后。设计要点(对齐 MemOS DSH adapter 的前台契约):

- **只走 BM25**(实测 rt≈0.3s),不用 hybrid——DSH 前台硬上限 3 秒不可配置突破,超时配置只能更短;
- **同一逻辑 turn 去重**:工具循环的多次 pre-step 只召回一次;插件/工具消息不触发(防递归);
- **全链路 fail-open**:检索失败/超时/未登录/无候选 → 不注入,绝不阻塞宿主;
- 注入内容标注为**历史参考数据而非指令**,防提示注入。

不想要自动召回?`recallEnabled: false` 或 `dsh plugin remove`。

## 配置

在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 放同 id 行覆盖(DSH patch 是整行替换,保留全部字段):

```yaml
- id: exomind-flywheel
  config:
    baseUrl: "" # 留空继承共享凭据
    apiKey: ""
    searchTimeoutMs: 15000
    queryTimeoutMs: 180000
    maxResultChars: 6000
    recallEnabled: true
    recallTimeoutMs: 2000 # 前台硬上限 3000,只能更短
    recallLimit: 3
    recallMaxChars: 3000
    captureEnabled: true
    captureMinUserChars: 8
    captureMinAssistantChars: 100
    captureMaxChars: 8000
```

## 会话自动沉淀(v0.3.0+)

会话结束(`session/disposed`)时,若会话足够有料(用户消息与助手结论都过质量门槛,寒暄/空转不存),自动把「任务 + 用户消息 + 助手结论」整理成一条存档,经 `/ingest/async` 秒回提交到知识飞轮,服务端后台异步抽取(1-3 分钟)——闭环:上一场会话的沉淀,成为下一场会话的自动召回。

- 提交带 `client_key` 幂等(内容哈希派生),重试/重投不产生重复;
- 插件退出窗口内有界等待提交完成;提交失败只丢弃本条,不影响宿主;
- 存档标签 `dsh` + `会话存档`,标题形如「DSH 会话:<任务>」。

不想要自动沉淀:`captureEnabled: false`。

## 卸载

```bash
dsh plugin --profile <你的profile> remove dsh-exomind
```

本插件不在本地存任何数据(凭据复用 exomind-cli 的文件),无残留。

## 路线图

- ✅ Phase 1:三个只读工具(v0.1.0)。
- ✅ Phase 2:自动召回——`agent/pre-step` 有界 BM25 注入,3 秒 SLA + fail-open(v0.2.0)。
- ✅ Phase 3:会话沉淀——`session/disposed` 质量门槛 + `/ingest/async` 幂等提交(v0.3.0)。

## 开发

```bash
npm install
npm run typecheck && npm run build && npm test && npm run lint
# 本地装进 DSH 试:dsh plugin --profile <profile> add /absolute/path/to/dsh-exomind
```

## License

[MIT](./LICENSE)
