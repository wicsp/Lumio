/** 设置页的地址预设（ADR 0029 第 7 节）：常见的兼容 Chat Completions 服务地址，只是填写帮助，不预设默认供应商或模型。名称不翻译。 */
export const PROVIDER_PRESETS: Array<[string, string]> = [
  ["DeepSeek", "https://api.deepseek.com/v1"],
  ["OpenAI", "https://api.openai.com/v1"],
  ["OpenRouter", "https://openrouter.ai/api/v1"],
  ["Moonshot (Kimi)", "https://api.moonshot.cn/v1"],
  ["Qwen (DashScope)", "https://dashscope.aliyuncs.com/compatible-mode/v1"],
  ["Ollama", "http://127.0.0.1:11434/v1"],
  ["LM Studio", "http://127.0.0.1:1234/v1"],
];
