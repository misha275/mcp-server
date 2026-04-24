import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function getArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return undefined;
  }
  return process.argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

function parseToolTextResult(result: unknown): JsonValue {
  if (!result || typeof result !== "object") {
    return {};
  }

  const maybeContent = (result as { content?: unknown }).content;
  if (!Array.isArray(maybeContent) || maybeContent.length === 0) {
    return {};
  }

  const first = maybeContent[0] as { type?: string; text?: string };
  if (first.type !== "text" || typeof first.text !== "string") {
    return {};
  }

  try {
    return JSON.parse(first.text) as JsonValue;
  } catch {
    return { rawText: first.text };
  }
}

async function main() {
  const mode = getArg("--mode") ?? "demo";
  const serverCommand = getArg("--server-command") ?? "node";
  const serverArgs = getArg("--server-args")?.split(" ").filter(Boolean) ?? ["dist/index.js"];
  const serverCwd = getArg("--server-cwd") ?? process.cwd();

  const client = new Client(
    {
      name: "orchestrator-cli-client",
      version: "1.0.0",
    },
    {
      capabilities: {},
    },
  );

  const transport = new StdioClientTransport({
    command: serverCommand,
    args: serverArgs,
    cwd: serverCwd,
    stderr: "inherit",
  });

  await client.connect(transport);

  const callToolJson = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    return parseToolTextResult(result);
  };

  if (mode === "list-tools") {
    const tools = await client.listTools();
    console.log(JSON.stringify(tools.tools.map((tool) => tool.name), null, 2));
    await client.close();
    return;
  }

  if (mode === "snapshot") {
    const snapshot = await callToolJson("get_coordination_snapshot", { messageLimit: 50 });
    console.log(JSON.stringify(snapshot, null, 2));
    await client.close();
    return;
  }

  const coordinatorId = "coordinator-main";
  const coderId = "coder-main";
  const reviewerId = "reviewer-main";
  const testerId = "tester-main";

  await callToolJson("register_agent", {
    agentId: coordinatorId,
    name: "Main Coordinator",
    role: "coordinator",
    capabilities: ["assign", "prioritize", "escalation"],
    priority: 10,
  });

  await callToolJson("register_agent", {
    agentId: coderId,
    name: "Main Coder",
    role: "coder",
    capabilities: ["typescript", "integration"],
    priority: 8,
  });

  await callToolJson("register_agent", {
    agentId: reviewerId,
    name: "Main Reviewer",
    role: "reviewer",
    capabilities: ["code-review", "architecture"],
    priority: 7,
  });

  await callToolJson("register_agent", {
    agentId: testerId,
    name: "Main Tester",
    role: "tester",
    capabilities: ["integration-tests", "qa-gate"],
    priority: 7,
  });

  const createdTask = await callToolJson("create_task", {
    title: "Интеграция нового workflow",
    description: "Реализовать и проверить сквозной сценарий мультиагентной координации",
    requiredRoles: ["coder"],
    priority: "normal",
    createdBy: coordinatorId,
  });

  const taskId =
    typeof createdTask === "object" &&
    createdTask !== null &&
    "task" in createdTask &&
    typeof createdTask.task === "object" &&
    createdTask.task !== null &&
    "id" in createdTask.task
      ? String((createdTask.task as { id: string }).id)
      : undefined;

  if (!taskId) {
    throw new Error("Не удалось получить taskId из create_task");
  }

  await callToolJson("assign_task", {
    taskId,
    agentId: coderId,
    byAgentId: coordinatorId,
    note: "Берем в работу, после реализации передать в review и test",
  });

  await callToolJson("set_task_status", {
    taskId,
    status: "in_progress",
    byAgentId: coderId,
    note: "Кодирование начато",
  });

  await callToolJson("approve_task_gate", {
    taskId,
    byAgentId: reviewerId,
    gate: "reviewer",
    note: "Код проверен",
  });

  await callToolJson("approve_task_gate", {
    taskId,
    byAgentId: testerId,
    gate: "tester",
    note: "Тесты пройдены",
  });

  await callToolJson("resolve_task", {
    taskId,
    byAgentId: coordinatorId,
    resolution: "Сценарий реализован и подтвержден quality-gates",
  });

  if (hasFlag("--run-escalation-scan")) {
    await callToolJson("run_escalation_scan", { byAgentId: coordinatorId });
  }

  const snapshot = await callToolJson("get_coordination_snapshot", { messageLimit: 50 });
  console.log(JSON.stringify(snapshot, null, 2));

  await client.close();
}

main().catch((error) => {
  console.error("Client failed:", error);
  process.exit(1);
});
