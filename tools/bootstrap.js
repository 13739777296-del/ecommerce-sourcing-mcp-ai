import { buildBootstrapGuide, buildWorkerInstallCommand, installScriptUrl } from "../lib/bootstrap-guide.js";

export const name = "bootstrap";
export const description = "返回新电脑初始化本机 worker 的两种方案：一条 install.sh 命令，或由 Claude Code/Agent 在本机自动安装。Agent 应先询问用户选择哪种方式。";
export const parameters = {
  type: "object",
  properties: {
    mode: {
      type: "string",
      enum: ["guide", "command"],
      description: "guide 返回完整说明；command 只返回一条安装命令。默认 guide。"
    }
  }
};

export async function execute(input = {}) {
  const mode = String(input.mode || "guide");
  const command = buildWorkerInstallCommand();
  const text = mode === "command"
    ? [
      "本机 worker 一键安装命令：",
      "",
      "```bash",
      command,
      "```",
      "",
      "执行后再检查 `/health` 里的 `worker.connected`。"
    ].join("\n")
    : buildBootstrapGuide();
  return {
    content: [{ type: "text", text }],
    details: {
      installScriptUrl: installScriptUrl(),
      installCommand: command,
      modes: ["一条安装命令", "Agent 本机自动安装"]
    }
  };
}
