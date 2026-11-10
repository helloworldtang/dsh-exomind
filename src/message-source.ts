/** 召回消息的生产者归因:扩展 dsh-llm 的 MessageSourceMap(方式同 MemOS adapter)。
 *  form:'recall' 是 DSH 内建语义——「从其他会话日志取材」——正好描述知识飞轮召回。 */
export interface ExomindMessageSource {
  kind: "plugin:exomind-flywheel";
  plugin: "exomind-flywheel";
  form?: "recall";
}

declare module "@deepseek-ai/dsh-llm" {
  interface MessageSourceMap {
    "plugin:exomind-flywheel": ExomindMessageSource;
  }
}

export function exomindMessageSource(form?: "recall"): ExomindMessageSource {
  return {
    kind: "plugin:exomind-flywheel",
    plugin: "exomind-flywheel",
    ...(form ? { form } : {}),
  };
}
