import type { Context } from "@deepseek-ai/cordis";
import type {} from "../../../settings/service.js";

/** WebUI owners declare presentation preferences; Settings does not interpret them. */
export const ComposerPreferences = {
  name: "webui-composer-preferences", inject: ["settings"],
  apply(ctx: Context): void {
    ctx.settings.register(ctx, { namespace: "webui-appearance", title: "外观", applies: "live", fields: [
      { key: "theme", label: "主题", description: "切换 Wish WebUI 的明暗外观。", type: "enum", options: [
        { value: "light", label: "浅色" }, { value: "dark", label: "深色" },
      ], default: "light" },
      { key: "language", label: "语言", description: "切换界面文字，不翻译会话内容或工作区文件。", type: "enum", options: [
        { value: "zh-CN", label: "中文" }, { value: "en-US", label: "English" },
      ], default: "zh-CN" },
      { key: "font-size", label: "字号", description: "调整整个 WebUI 的文字大小。", type: "enum", options: [
        { value: "standard", label: "标准 · 14 px" }, { value: "large", label: "大 · 16 px" }, { value: "extra-large", label: "特大 · 18 px" },
      ], default: "standard" },
    ] });
    ctx.settings.register(ctx, { namespace: "webui-composer", title: "消息输入", applies: "next-request", fields: [
      { key: "busy-delivery", label: "运行中按 Enter 的默认行为", description: "queue 加入后续轮次；steer 在下一 Step 送达引导，不中断当前工具。界面保留两种操作。", type: "enum", options: ["queue", "steer"], default: "queue" },
    ] });
  },
};
