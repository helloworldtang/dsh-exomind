# dsh-exomind

把 [ExoMind 知识飞轮](https://exomind.ai-as.cn)接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(DSH):为 agent 提供五个工具,让它直接检索、问答、沉淀你的个人知识库——实体图谱、经验沉淀、踩坑记录。

与本地记忆插件不同,ExoMind 是**服务端知识飞轮**(实体/关系图谱 + FSRS 复习),同一份记忆同时服务 Claude Code(MCP/CLI)、小程序、浏览器插件与本插件,换 harness 不丢记忆。

## 工具

| 工具              | 用途                                                  | 速度                  |
| ----------------- | ----------------------------------------------------- | --------------------- |
| `exomind_search`  | 全文/语义检索(BM25,可选 hybrid 向量混合、rerank 精排) | 秒级,优先使用         |
| `exomind_entity`  | 查实体详情:定义、别名、关联实体                       | 秒级                  |
| `exomind_query`   | 跨多页知识的 LLM 深度问答                             | 慢(1-2 分钟),仅深问题 |
| `exomind_suggest` | 建议下一步深挖主题(图谱密度/盲区/跨域关联)            | 秒级                  |
| `exomind_ingest`  | 把会话中值得长期保留的结论当场存入飞轮                | 秒级(异步抽取)        |

## 安装

> 前置:DSH 0.1.0-rc.6+(与 peer 范围一致;0.1.x 宿主不读 `engines.dsh`,0.2.1+ 宿主在安装与启动时按它校验)。实测通过:0.1.2-rc.1、0.1.5-rc.2、0.1.7-rc.2(headless)与 0.2.2-rc.5(桌面);preview 阶段 API 在变,上限 `<0.2.3`,DSH 0.2.3 正式版发布后需评估再放宽。Node 22+;已用 `exomind login` 登录过 ExoMind(见下"凭据")。

**桌面应用**(DeepSeek Harness Desktop):在应用的「插件」页安装与更新,也可以直接对 agent 说「安装 dsh-exomind@0.7.5」。

**命令行**:

```bash
dsh plugin --profile <你的profile> add github:helloworldtang/dsh-exomind#v0.7.5   # GitHub tag
dsh plugin --profile <你的profile> add dsh-exomind@0.7.5                          # 或 npm
dsh --profile <你的profile> --dump-config   # 应看到 id: exomind-flywheel 的 bundle 行
# 重启该 profile 后生效
```

⚠️ 引用请锁定 tag(`#vX.Y.Z`),不要引滚动分支——升级必须是显式改版本号的决策。

升级:命令行重新执行 `add` 并指定新版本;桌面应用在插件页点更新。本插件刚发布的版本可能触发 pnpm 的发布龄护栏(pnpm 11 起默认 24 小时),DSH 会自动豁免;若 profile 开了严格模式,等发布满 24 小时再装。

## 命令行与 profile

除了桌面应用,DSH 也可以从命令行启动。两者共用 `~/.dsh` 下的会话、设置与凭据,但插件各装各的——桌面应用装的插件不会出现在命令行里,反之亦然。

profile 是一份命名配置(`~/.dsh/profiles/<名字>`),决定把哪些插件组合成什么样的应用。内置模板:

| profile       | 用途                                                                  | 命令                            |
| ------------- | --------------------------------------------------------------------- | ------------------------------- |
| `headless`    | 一次性任务:新建会话、跑完、打印答案、退出。适合脚本、定时任务、批处理 | `dsh --profile headless "任务"` |
| `web`         | 本地网页界面,浏览器打开 `127.0.0.1:3080`                              | `dsh web`                       |
| `acp` / `sdk` | 给编辑器或程序调用(stdio 协议)                                        | `dsh --profile acp` 等          |
| `desktop`     | 桌面应用专用,命令行不接管                                             | —                               |

管理某个 profile 的插件用 `dsh plugin --profile <p> add|remove <包>`;看它实际会启动什么用 `dsh --profile <p> --dump-config`。

## 凭据

优先级(高 → 低):

1. DSH 行配置的 `baseUrl` / `apiKey`
2. 环境变量 `EXOMIND_BASE_URL` / `EXOMIND_API_KEY`
3. `~/.exomind/config.json`(与 [exomind-cli](https://github.com/helloworldtang/exomind-cli) 共享,`exomind login` 写入)

即:装好 exomind-cli 并 `exomind login` 后,本插件零配置可用;换 key 也只需 `exomind login`,无需重启 DSH(每次工具调用时解析凭据)。

## 自动召回(v0.2.0+)

每条**直接用户消息**进入 agent 前,插件自动做一次有界 BM25 检索,把命中包进 `<exomind_context>` 注入到该消息之后。设计要点(对齐 MemOS DSH adapter 的前台契约):

- **只走 BM25**(实测 rt≈0.3s),不用 hybrid——DSH 前台硬上限 3 秒不可配置突破,超时配置只能更短;
- **查询按"当下意图优先"构造**:从最后一条用户消息往前按消息粒度回填 200 字符窗口(单条超窗取尾部——中文提问惯例先铺垫后发问);最多回溯 8 条,历史消息装不下整条即停;
- **同一逻辑 turn 去重**:工具循环的多次 pre-step 只召回一次;插件/工具消息不触发(防递归);
- **独立 recall 检索通道**(v0.5.0+):召回请求带 `channel=recall`,服务端不把机器召回写进使用日志(不稀释质量分母),零命中才记缺口(低分命中是召回常态,不过量记账)——召回零命中即「这场会话的主题飞轮里没有」,自动进服务端缺口状态机,`/knowledge-gaps` 可见;
- **每次召回打一行结构化埋点**(`exomind-recall` logger),字段:`turn/qChars/msgs/hits/ms/injected`,缓存就绪时附 `revived`(命中页里来自本插件此前会话沉淀的数量,见下);skip 路径(短查询/同 turn 去重)每 turn 至多一行 `skipped`;
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

**出站脱敏**(v0.4.0+):提交前对最终出站字节(content + title)做收口扫描,命中结构化密钥形态(sk- 系 key、AWS `AKIA`、GitHub `ghp_`、Slack、Google、JWT、`Bearer` 头、PEM 私钥块、`sk_live_` 系自家 key)即打码(`sk-a***REDACTED***`,保留 4 字符前缀可辨认、不可还原);命中超 10 处视为密钥清单粘贴,整条放弃上传。打码/放弃各打一行 `exomind-capture` 埋点。插件启用时有一条知情提示说明会上传什么、如何关闭。无结构敏感内容(如 prose 密码)超出正则能力,请自行确认或 `captureEnabled: false`。

- 提交带 `client_key` 幂等(内容哈希派生),重试/重投不产生重复;
- 提交带 `origin: dsh-plugin`(v0.5.0+):服务端摄入流水以此区分来源,是复活率统计的过滤键;
- 插件卸载时等待在途提交完成(上限 3 秒);提交失败只丢弃本条,不影响宿主;
- 存档标签 `dsh` + `会话存档`,标题形如「DSH 会话:<任务>」。

不想要自动沉淀:`captureEnabled: false`。

## Agent 主动沉淀(v0.6.0+)

自动沉淀是整场兜底(质量门槛只看长度),`exomind_ingest` 工具把「什么值得存」的判断交给 agent:架构决策与理由、踩坑根因、经验总结,会话中段**当场**存入飞轮,不等会话结束、不受 digest 截断。召回注入的头部声明自带基础引导;更强的引导见下「引导通道(AGENTS.md)」。

- 与自动沉淀并存:工具存精选亮点,自动存任务全景;重叠由服务端抽取/判重收口;
- 出站脱敏与自动沉淀同一套扫描,但行为不同——密钥清单**不静默放弃,而是返回 isError** 告知 agent 打码后重试(工具路径 agent 能对反馈采取行动);零星密钥照常自动打码;
- 质量门:正文不足 50 字 / 超 5 万字拒绝;标签最多 5 个,自动追加 `dsh` + `agent存档` 标签族与 `origin=dsh-plugin`(复活率统计与自动沉淀同源可比);
- `client_key` 幂等同款(内容哈希派生),同内容重试不产生重复。

## 引导通道(AGENTS.md)

agent 会不会**自发**调用 `exomind_ingest` 取决于模型对工具描述的敏感度。DSH 没有 CLAUDE.md 式的全局指令文件,但会自动加载项目里的 **AGENTS.md** 注入 agent 上下文——把下面几行加进你常用项目的 `AGENTS.md`(一次配置,长期生效),引导强度即与 Claude Code 侧对齐:

```markdown
## 知识沉淀

会话中出现值得长期保留的结论(架构决策与理由/踩坑根因/经验总结)时,当场调用
exomind_ingest 存入知识飞轮,不要等会话结束;内容自包含,勿含密钥。
处理问题前先看注入的 <exomind_context>;需要更多背景用 exomind_search。
```

不配置也能用:工具描述与召回注入的头部声明已含基础引导,只是强度较弱(采用率可从 `exomind-capture` 日志 `via:"tool"` 埋点观察)。

## 数据闭环观测(v0.5.0+)

飞轮的后半圈(使用→反馈→驱动下一轮摄入)靠三组埋点转起来,全部输出在 `exomind-recall` / `exomind-capture` logger,可直接从日志统计:

- **采纳信号**:每个有注入的 turn 在 turn/end 打一行 `{turn, followup:"<工具名>"|"none", adopted:true|false}`。`followup` = turn 内 agent 调过的第一个 exomind 检索工具(绕开信号);`adopted` = 助手回答文本中出现了注入命中页的标题(正向采纳,子串代理:转述不含原标题会偏低估)。四档读法:none+adopted=纯采纳 / 工具+adopted=顺着注入深挖 / 工具+¬adopted=绕开重查 / none+¬adopted=可能被忽略——是召回择优/降级开关的启动证据。
- **复活率**:召回埋点的 `revived` 字段 = 命中页与「本插件此前沉淀页」(`/ingest/recent` 中 channel=dsh-plugin 的 created/updated pages)的交集数。「上一场会话的沉淀成为下一场的召回」从此是可观测数字,不再是叙事。命中页集合进程内缓存(TTL 10 分钟),前台召回路径零额外网络等待。
- **主动建议**:会话结束沉淀时顺带取一条 `/suggest-topics` 选题,以「ExoMind 建议下一步深挖: <主题> — <理由>」输出在 `exomind-capture` 日志,失败静默。agent 也可随时用 `exomind_suggest` 工具主动取。

## 卸载

```bash
dsh plugin --profile <你的profile> remove dsh-exomind
```

桌面应用在插件页卸载。

本插件不在本地存任何数据(凭据复用 exomind-cli 的文件),无残留。

## 路线图

- ✅ Phase 1:三个只读工具(v0.1.0)。
- ✅ Phase 2:自动召回——`agent/pre-step` 有界 BM25 注入,3 秒 SLA + fail-open(v0.2.0)。
- ✅ Phase 3:会话沉淀——`session/disposed` 质量门槛 + `/ingest/async` 幂等提交(v0.3.0)。
- ✅ Phase 4:数据闭环——召回采纳信号(followup)+ 复活率(revived)+ 独立 recall 缺口通道 + 主动建议(exomind_suggest 与 dispose 日志行)(v0.5.0)。
- ✅ Phase 5:Agent 主动沉淀——exomind_ingest 工具 + 召回头部引导 + 密钥清单可行动拒绝(v0.6.0)。
- ✅ Phase 6:正向采纳信号——followup 埋点升级为 turn 级汇总(followup+adopted 四档)+ AGENTS.md 引导通道文档化(v0.7.0)。
- ✅ Phase 7:卸载契约修复——`apply` 返回的 disposer 被 Cordis 丢弃,中断退出时在途的会话沉淀会丢失;改箭头函数 + 兜底定时器 `unref`,补真 Cordis 回归测试(v0.7.5)。

## 开发

```bash
npm install
npm run typecheck && npm run build && npm test && npm run lint
```

**验证一个本地构建**(不落任何 profile):`npm run build && npm pack`,解包后写一个覆盖层——停用已装的 `exomind-flywheel` 条目,再 `insert` 一条 `name` 为 `file:///…/dist/index.js` 的新条目——用 `--patch` 挂进任意 profile,只对本次启动生效:

```bash
dsh --profile <profile> --patch /path/to/overlay.yml "一句话任务"
```

**装进 profile**:`dsh plugin --profile <p> add <包名@版本或路径>`。DSH ≥ 0.2.1 的 CLI 安装前做兼容性预检,失败时回滚清单与锁文件,且只把本次新增的依赖并入 bundles;≤ 0.1.5 的 CLI 会把无关 bundle 一并写入 profile,请先升级 CLI。维护者备注:

- 预览会装什么,用 `pnpm view dsh-exomind@<版本> version engines peerDependencies --json`;`pnpm add --lockfile-only` 不是 dry-run,它会改 `package.json` 与锁文件。
- pnpm 11 起默认 24 小时发布龄护栏:当天发当天装,pnpm 会把该版本自动写进 profile 的 `pnpm-workspace.yaml`;把豁免写成包名 `dsh-exomind` 可一次到位。
- 真实 DSH 端到端优先用隔离的临时 `DSH_HOME`,不碰本机 `~/.dsh`。
- 全局 CLI 按官方方式用 npm/npx 安装。本机实测 pnpm 11.22 全局安装的 0.2.2-rc.5 启动即报 `No usable native binding found for node-addon-require-builtin-darwin-arm64`(软链布局下加载器的原生依赖解析不到),改用 `npm install -g` 后正常。

发版:bump `package.json` 版本(README 安装示例与 `package-lock.json` 一并同步)→ 质量门全绿 → commit → `git tag v*`(带注解)→ push tag,
GitHub Actions 自动 npm publish(trusted publishing,无 token)→ 建 GitHub Release(变更 / 为什么 / 升级命令 / 消费方指引)→ 复核 npm 可见与 Release 页可达。

## License

[MIT](./LICENSE)
