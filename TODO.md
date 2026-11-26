# TODO

已拍板待做与有意后置的事项。发版节奏见 README「发版」一节。

## 待做

- [ ] **DSH 0.2.4 预发布出现时(或上游发布不带后缀的 0.2.3):评估并放宽版本上限**(2026-11-26 登记):
      版本范围:`engines.dsh` 与 peer 当前上限 `<0.2.3`。宿主的兼容性判定带 includePrerelease——0.2.3 的
      alpha/rc 仍算兼容(2026-11-26 在 0.2.3-alpha.2 上实测通过),不带后缀的 0.2.3 与 0.2.4 起任何版本会被拒。
      届时先在目标版本上跑真实端到端,再发新版推上限;用户侧的临时出路是精确版本豁免(不随升级继承),
      命令为 `dsh plugin --profile <p> allow-version dsh-exomind@<版本> --dsh-version <运行时版本> --accept-risk`。

- [ ] **会话级豁免通道**（v2,挂真实需求后启动）：沉淀（capture）目前只有全局 `captureEnabled`
      开关,没有"这一次/这个会话不要上传"的表达。v1 定调不做消息内指令标记——指令可能被
      模型/用户误解,且 DSH 侧无 per-session 配置挂点;待 DSH 提供会话级配置能力或用户反馈
      出真实豁免需求再设计。观察信号:脱敏埋点(`masked`/`dropped`)的命中趋势、社区反馈。
- [ ] **使用即复习的接入设计**（挂服务端需求后启动,2026-11-19 调研结论）：
      让 agent 的知识消费热度反馈知识状态。竞品调研（MemOS + MemoryBear）结论：
      MemoryBear 把 implicit 访问与 explicit 复习压成同一种"访问"（`record_access` 无
      channel 字段,ACT-R 时间戳无差别,价值权重定义了但未启用）——架构上无法分权;
      MemOS 两条独立通路,显式反馈修正内容、访问频率改变记忆**形态**（明文→激活→参数）,
      不做条目级加权。**ExoMind 现状（FSRS 只被显式 /review/mark 移动,usage/click/view
      走独立被动账本）恰好避开两家的坑**。若落地：agent 使用信号必须走 channel 打标的
      事件账本（喂激活度/质量分）,绝不直接 bump FSRS 稳定度——机器"用"≠人"记住了"。
      现成入口：服务端 `/flywheel/events` 的 append-only 账本。

## 有意后置(已评估,非欠债)

- **召回查询词面相关性择优**(就近+相关择优):挂在召回埋点积累出"注入质量是瓶颈"的证据
  之后,不做盲调。v0.5.0 起 `followup` 埋点(采纳率 = none/(none+tool))就是这个证据的
  采集器——攒到能算出「注入后仍绕开检索」的占比,再决定择优还是 strict 降级。
- **服务端摄入 secret 扫描**:插件侧收口脱敏先挡(最小爆炸半径);服务端 guardian 加
  同款扫描可保护全部客户端(exomind-cli/earshot 等),属 ExoMind 服务端仓的事,两道不冲突。
- **strict 降级开关**:fail-open 前台召回的 strict 模式意义存疑,除非埋点证据显示
  "低质注入比不注入更糟"。
- **主动建议进 agent 上下文**:v0.5.0 拍板不做——注入等于让产品目标(选题引导)混入
  用户的任务目标,可能把 agent 带偏。保留 exomind_suggest 工具(agent 可主动调)与
  dispose 日志行(人看)两个安静出口。
