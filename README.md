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
dsh plugin --profile <你的profile> add github:helloworldtang/dsh-exomind#v0.1.0
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
```

## 卸载

```bash
dsh plugin --profile <你的profile> remove dsh-exomind
```

本插件不在本地存任何数据(凭据复用 exomind-cli 的文件),无残留。

## 路线图

- **Phase 1(当前)**:三个只读工具。
- **Phase 2**:自动召回——`agent/pre-step` 每轮注入一次检索结果(受 DSH 前台 3 秒 SLA 约束,只走亚秒级 search)。
- **Phase 3**:后台沉淀——会话结束异步写入知识飞轮。

## 开发

```bash
npm install
npm run typecheck && npm run build && npm test && npm run lint
# 本地装进 DSH 试:dsh plugin --profile <profile> add /absolute/path/to/dsh-exomind
```

## License

[MIT](./LICENSE)
