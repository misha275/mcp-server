import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { open, type Database } from "sqlite";
import sqlite3 from "sqlite3";
import { z } from "zod";

const ROLE_CATALOG = [
  "coordinator",
  "planner",
  "researcher",
  "coder",
  "reviewer",
  "tester",
  "documenter",
  "analyst",
  "deployer",
  "custom",
] as const;

type AgentRole = (typeof ROLE_CATALOG)[number];
type TaskPriority = "low" | "normal" | "high" | "critical";

type AgentStatus = "idle" | "busy" | "blocked" | "offline";
type TaskStatus = "open" | "assigned" | "in_progress" | "blocked" | "done";
type MessageType = "update" | "question" | "handoff" | "alert";
type TaskGate = "reviewer" | "tester";

interface TaskApproval {
  byAgentId: string;
  at: string;
  note?: string;
}

interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  capabilities: string[];
  goal?: string;
  priority: number;
  status: AgentStatus;
  load: number;
  context?: string;
  lastSeenAt: string;
}

interface Task {
  id: string;
  title: string;
  description: string;
  requiredRoles: AgentRole[];
  priority: TaskPriority;
  status: TaskStatus;
  createdBy: string;
  assignedTo?: string;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  resolution?: string;
  blockedSince?: string;
  escalationLevel: number;
  approvals: Partial<Record<TaskGate, TaskApproval>>;
}

interface AgentMessage {
  id: string;
  fromAgentId: string;
  toAgentId?: string;
  taskId?: string;
  type: MessageType;
  content: string;
  createdAt: string;
}

const agents = new Map<string, Agent>();
const tasks = new Map<string, Task>();
const messages: AgentMessage[] = [];
const DB_PATH = resolve(process.cwd(), "data", "orchestrator.db");
const ESCALATION_SCAN_INTERVAL_MS = Number(process.env.ESCALATION_SCAN_INTERVAL_MS ?? 60_000);
const ESCALATION_THRESHOLDS_MINUTES = [10, 30, 60] as const;
const PRIORITY_ORDER: TaskPriority[] = ["low", "normal", "high", "critical"];
let db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

const server = new Server(
  {
    name: "multi-agent-orchestrator",
    version: "2.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  },
);

const registerAgentSchema = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1),
  role: z.enum(ROLE_CATALOG),
  capabilities: z.array(z.string()).default([]),
  goal: z.string().optional(),
  priority: z.number().int().min(1).max(10).default(5),
});

const updateAgentStatusSchema = z.object({
  agentId: z.string().min(1),
  status: z.enum(["idle", "busy", "blocked", "offline"]),
  context: z.string().optional(),
  load: z.number().int().min(0).max(100).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  requiredRoles: z.array(z.enum(ROLE_CATALOG)).min(1),
  priority: z.enum(["low", "normal", "high", "critical"]).default("normal"),
  createdBy: z.string().min(1),
  dueAt: z.string().optional(),
});

const assignTaskSchema = z.object({
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  byAgentId: z.string().min(1),
  note: z.string().optional(),
});

const taskStatusSchema = z.object({
  taskId: z.string().min(1),
  status: z.enum(["open", "assigned", "in_progress", "blocked", "done"]),
  byAgentId: z.string().min(1),
  note: z.string().optional(),
});

const resolveTaskSchema = z.object({
  taskId: z.string().min(1),
  byAgentId: z.string().min(1),
  resolution: z.string().min(1),
});

const postMessageSchema = z.object({
  fromAgentId: z.string().min(1),
  toAgentId: z.string().optional(),
  taskId: z.string().optional(),
  type: z.enum(["update", "question", "handoff", "alert"]).default("update"),
  content: z.string().min(1),
});

const snapshotSchema = z.object({
  messageLimit: z.number().int().min(1).max(200).default(30),
});

const approveTaskGateSchema = z.object({
  taskId: z.string().min(1),
  byAgentId: z.string().min(1),
  gate: z.enum(["reviewer", "tester"]),
  note: z.string().optional(),
});

const rebalanceSchema = z.object({
  byAgentId: z.string().min(1),
});

const escalationScanSchema = z.object({
  byAgentId: z.string().min(1),
});

function nowIso() {
  return new Date().toISOString();
}

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function asText(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function ensureDb() {
  if (!db) {
    throw new Error("База данных не инициализирована");
  }
  return db;
}

async function initDatabase() {
  await mkdir(dirname(DB_PATH), { recursive: true });
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
  `);
}

async function loadStateFromDatabase() {
  const database = ensureDb();

  const agentRows = await database.all<{ payload: string }[]>("SELECT payload FROM agents");
  for (const row of agentRows) {
    const parsed = JSON.parse(row.payload) as Agent;
    agents.set(parsed.id, parsed);
  }

  const taskRows = await database.all<{ payload: string }[]>("SELECT payload FROM tasks");
  for (const row of taskRows) {
    const parsed = JSON.parse(row.payload) as Task;
    parsed.approvals = parsed.approvals ?? {};
    parsed.escalationLevel = parsed.escalationLevel ?? 0;
    tasks.set(parsed.id, parsed);
  }

  const messageRows = await database.all<{ payload: string }[]>(
    "SELECT payload FROM messages ORDER BY createdAt ASC",
  );
  for (const row of messageRows) {
    messages.push(JSON.parse(row.payload) as AgentMessage);
  }
}

async function upsertAgent(agent: Agent) {
  const database = ensureDb();
  await database.run(
    "INSERT INTO agents(id, payload, updatedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updatedAt=excluded.updatedAt",
    agent.id,
    JSON.stringify(agent),
    nowIso(),
  );
}

async function upsertTask(task: Task) {
  const database = ensureDb();
  await database.run(
    "INSERT INTO tasks(id, payload, updatedAt) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, updatedAt=excluded.updatedAt",
    task.id,
    JSON.stringify(task),
    nowIso(),
  );
}

async function insertMessage(message: AgentMessage) {
  const database = ensureDb();
  await database.run(
    "INSERT INTO messages(id, payload, createdAt) VALUES (?, ?, ?)",
    message.id,
    JSON.stringify(message),
    message.createdAt,
  );
}

function requireAgent(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) {
    throw new Error(`Агент не найден: ${agentId}`);
  }
  return agent;
}

function requireTask(taskId: string) {
  const task = tasks.get(taskId);
  if (!task) {
    throw new Error(`Задача не найдена: ${taskId}`);
  }
  return task;
}

function assertAgentRole(agent: Agent, allowed: AgentRole[], action: string) {
  if (!allowed.includes(agent.role)) {
    throw new Error(
      `Недостаточно прав для ${action}. Роль ${agent.role}. Разрешено: ${allowed.join(", ")}`,
    );
  }
}

function assertTaskActor(task: Task, agent: Agent, action: string) {
  if (agent.role === "coordinator") {
    return;
  }
  if (task.assignedTo !== agent.id) {
    throw new Error(`Только назначенный агент или coordinator может выполнить ${action}`);
  }
}

function requiresQualityGates(task: Task) {
  return task.requiredRoles.includes("coder");
}

function addSystemMessage(payload: Omit<AgentMessage, "id" | "createdAt">) {
  const message: AgentMessage = {
    id: id("msg"),
    createdAt: nowIso(),
    ...payload,
  };
  messages.push(message);
  return message;
}

function getTaskPriorityRank(priority: TaskPriority) {
  return PRIORITY_ORDER.indexOf(priority);
}

function bumpTaskPriority(priority: TaskPriority) {
  const current = getTaskPriorityRank(priority);
  const next = Math.min(PRIORITY_ORDER.length - 1, current + 1);
  return PRIORITY_ORDER[next];
}

async function runEscalationScan(sourceAgentId = "system") {
  const changes: Array<{
    taskId: string;
    previousPriority: TaskPriority;
    newPriority: TaskPriority;
    blockedMinutes: number;
    escalationLevel: number;
  }> = [];

  for (const task of tasks.values()) {
    if (task.status !== "blocked") {
      continue;
    }

    if (!task.blockedSince) {
      task.blockedSince = task.updatedAt;
      task.escalationLevel = task.escalationLevel ?? 0;
      await upsertTask(task);
      continue;
    }

    const blockedMinutes = Math.floor((Date.now() - Date.parse(task.blockedSince)) / 60_000);
    const reachedLevel = ESCALATION_THRESHOLDS_MINUTES.filter((m) => blockedMinutes >= m).length;

    if (reachedLevel <= task.escalationLevel) {
      continue;
    }

    const previousPriority = task.priority;
    let nextPriority = task.priority;
    for (let i = task.escalationLevel; i < reachedLevel; i += 1) {
      nextPriority = bumpTaskPriority(nextPriority);
    }

    task.priority = nextPriority;
    task.escalationLevel = reachedLevel;
    task.updatedAt = nowIso();
    await upsertTask(task);

    const message = addSystemMessage({
      fromAgentId: sourceAgentId,
      toAgentId: task.assignedTo,
      taskId: task.id,
      type: "alert",
      content:
        `Эскалация блокера: задача заблокирована ${blockedMinutes} мин, ` +
        `приоритет повышен ${previousPriority} -> ${nextPriority}, уровень ${reachedLevel}`,
    });
    await insertMessage(message);

    changes.push({
      taskId: task.id,
      previousPriority,
      newPriority: nextPriority,
      blockedMinutes,
      escalationLevel: reachedLevel,
    });
  }

  return changes;
}

function computeRoleCoverage() {
  const coverage = Object.fromEntries(ROLE_CATALOG.map((role) => [role, 0])) as Record<AgentRole, number>;
  for (const agent of agents.values()) {
    coverage[agent.role] += 1;
  }
  return coverage;
}

function computeTaskStats() {
  const stats: Record<TaskStatus, number> = {
    open: 0,
    assigned: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };
  for (const task of tasks.values()) {
    stats[task.status] += 1;
  }
  return stats;
}

function rebalanceUnassignedTasks() {
  const changes: Array<{ taskId: string; agentId: string }> = [];

  for (const task of tasks.values()) {
    if (task.assignedTo || task.status === "done") {
      continue;
    }

    const candidates = [...agents.values()]
      .filter((agent) => task.requiredRoles.includes(agent.role))
      .filter((agent) => agent.status !== "offline" && agent.status !== "blocked")
      .sort((a, b) => a.load - b.load || b.priority - a.priority);

    const pick = candidates[0];
    if (!pick) {
      continue;
    }

    task.assignedTo = pick.id;
    task.status = "assigned";
    task.updatedAt = nowIso();
    pick.load = Math.min(100, pick.load + 10);
    if (pick.status === "idle") {
      pick.status = "busy";
    }
    pick.lastSeenAt = nowIso();

    changes.push({ taskId: task.id, agentId: pick.id });
  }

  return changes;
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "register_agent",
        description: "Регистрирует агента с четкой ролью, способностями и приоритетом",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            name: { type: "string" },
            role: {
              type: "string",
              enum: ROLE_CATALOG,
            },
            capabilities: {
              type: "array",
              items: { type: "string" },
            },
            goal: { type: "string" },
            priority: { type: "number", minimum: 1, maximum: 10 },
          },
          required: ["agentId", "name", "role"],
        },
      },
      {
        name: "update_agent_status",
        description: "Обновляет статус агента и рабочий контекст",
        inputSchema: {
          type: "object",
          properties: {
            agentId: { type: "string" },
            status: {
              type: "string",
              enum: ["idle", "busy", "blocked", "offline"],
            },
            context: { type: "string" },
            load: { type: "number", minimum: 0, maximum: 100 },
          },
          required: ["agentId", "status"],
        },
      },
      {
        name: "create_task",
        description: "Создает задачу с требованиями по ролям",
        inputSchema: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            requiredRoles: {
              type: "array",
              items: {
                type: "string",
                enum: ROLE_CATALOG,
              },
            },
            priority: {
              type: "string",
              enum: ["low", "normal", "high", "critical"],
            },
            createdBy: { type: "string" },
            dueAt: { type: "string" },
          },
          required: ["title", "description", "requiredRoles", "createdBy"],
        },
      },
      {
        name: "assign_task",
        description: "Явно назначает задачу агенту",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            agentId: { type: "string" },
            byAgentId: { type: "string" },
            note: { type: "string" },
          },
          required: ["taskId", "agentId", "byAgentId"],
        },
      },
      {
        name: "set_task_status",
        description: "Обновляет статус задачи по ходу выполнения",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            status: {
              type: "string",
              enum: ["open", "assigned", "in_progress", "blocked", "done"],
            },
            byAgentId: { type: "string" },
            note: { type: "string" },
          },
          required: ["taskId", "status", "byAgentId"],
        },
      },
      {
        name: "resolve_task",
        description: "Завершает задачу и фиксирует результат",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            byAgentId: { type: "string" },
            resolution: { type: "string" },
          },
          required: ["taskId", "byAgentId", "resolution"],
        },
      },
      {
        name: "approve_task_gate",
        description: "Подтверждает quality-gate от reviewer или tester перед финальным закрытием",
        inputSchema: {
          type: "object",
          properties: {
            taskId: { type: "string" },
            byAgentId: { type: "string" },
            gate: {
              type: "string",
              enum: ["reviewer", "tester"],
            },
            note: { type: "string" },
          },
          required: ["taskId", "byAgentId", "gate"],
        },
      },
      {
        name: "post_message",
        description: "Передает сообщение между агентами или в общий канал",
        inputSchema: {
          type: "object",
          properties: {
            fromAgentId: { type: "string" },
            toAgentId: { type: "string" },
            taskId: { type: "string" },
            type: {
              type: "string",
              enum: ["update", "question", "handoff", "alert"],
            },
            content: { type: "string" },
          },
          required: ["fromAgentId", "content"],
        },
      },
      {
        name: "rebalance_workload",
        description: "Автоматически распределяет неназначенные задачи по ролям и нагрузке",
        inputSchema: {
          type: "object",
          properties: {
            byAgentId: { type: "string" },
          },
          required: ["byAgentId"],
        },
      },
      {
        name: "run_escalation_scan",
        description: "Проверяет blocked-задачи, автоматически эскалирует и публикует alert",
        inputSchema: {
          type: "object",
          properties: {
            byAgentId: { type: "string" },
          },
          required: ["byAgentId"],
        },
      },
      {
        name: "get_coordination_snapshot",
        description: "Возвращает срез координации: роли, задачи, нагрузку и последние сообщения",
        inputSchema: {
          type: "object",
          properties: {
            messageLimit: { type: "number", minimum: 1, maximum: 200 },
          },
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === "register_agent") {
      const parsed = registerAgentSchema.parse(args);
      const existing = agents.get(parsed.agentId);

      const agent: Agent = {
        id: parsed.agentId,
        name: parsed.name,
        role: parsed.role,
        capabilities: parsed.capabilities,
        goal: parsed.goal,
        priority: parsed.priority,
        status: existing?.status ?? "idle",
        load: existing?.load ?? 0,
        context: existing?.context,
        lastSeenAt: nowIso(),
      };

      agents.set(agent.id, agent);
      await upsertAgent(agent);
      return asText({ ok: true, agent });
    }

    if (name === "update_agent_status") {
      const parsed = updateAgentStatusSchema.parse(args);
      const agent = requireAgent(parsed.agentId);
      agent.status = parsed.status;
      if (parsed.context !== undefined) {
        agent.context = parsed.context;
      }
      if (parsed.load !== undefined) {
        agent.load = parsed.load;
      }
      agent.lastSeenAt = nowIso();
      await upsertAgent(agent);
      return asText({ ok: true, agent });
    }

    if (name === "create_task") {
      const parsed = createTaskSchema.parse(args);
      const author = requireAgent(parsed.createdBy);
      assertAgentRole(author, ["coordinator", "planner", "analyst"], "create_task");

      const createdAt = nowIso();
      const task: Task = {
        id: id("task"),
        title: parsed.title,
        description: parsed.description,
        requiredRoles: parsed.requiredRoles,
        priority: parsed.priority,
        status: "open",
        createdBy: parsed.createdBy,
        dueAt: parsed.dueAt,
        createdAt,
        updatedAt: createdAt,
        escalationLevel: 0,
        approvals: {},
      };

      tasks.set(task.id, task);
      await upsertTask(task);
      return asText({ ok: true, task });
    }

    if (name === "assign_task") {
      const parsed = assignTaskSchema.parse(args);
      const task = requireTask(parsed.taskId);
      const agent = requireAgent(parsed.agentId);
      const coordinator = requireAgent(parsed.byAgentId);
      assertAgentRole(coordinator, ["coordinator"], "assign_task");

      if (!task.requiredRoles.includes(agent.role)) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `Роль агента ${agent.role} не соответствует требованиям задачи ${task.requiredRoles.join(", ")}`,
            },
          ],
        };
      }

      task.assignedTo = agent.id;
      task.status = "assigned";
      task.updatedAt = nowIso();
      agent.status = "busy";
      agent.load = Math.min(100, agent.load + 10);
      agent.lastSeenAt = nowIso();
      await upsertTask(task);
      await upsertAgent(agent);

      if (parsed.note) {
        const message = addSystemMessage({
          fromAgentId: "coordinator",
          toAgentId: agent.id,
          taskId: task.id,
          type: "handoff",
          content: parsed.note,
        });
        await insertMessage(message);
      }

      return asText({ ok: true, task, agent });
    }

    if (name === "set_task_status") {
      const parsed = taskStatusSchema.parse(args);
      const task = requireTask(parsed.taskId);
      const actor = requireAgent(parsed.byAgentId);
      assertTaskActor(task, actor, "set_task_status");

      if (parsed.status === "done") {
        throw new Error("Прямое завершение запрещено. Используйте resolve_task после quality-gates");
      }

      task.status = parsed.status;
      task.updatedAt = nowIso();
      if (parsed.status === "blocked") {
        if (!task.blockedSince) {
          task.blockedSince = nowIso();
        }
      } else {
        task.blockedSince = undefined;
        task.escalationLevel = 0;
      }

      if (task.assignedTo) {
        const owner = agents.get(task.assignedTo);
        if (owner) {
          if (parsed.status === "blocked") {
            owner.status = "blocked";
          }
          if (parsed.status === "in_progress") {
            owner.status = "busy";
          }
          owner.lastSeenAt = nowIso();
          await upsertAgent(owner);
        }
      }

      await upsertTask(task);

      if (parsed.note) {
        const message = addSystemMessage({
          fromAgentId: parsed.byAgentId,
          taskId: task.id,
          type: parsed.status === "blocked" ? "alert" : "update",
          content: parsed.note,
        });
        await insertMessage(message);
      }

      return asText({ ok: true, task });
    }

    if (name === "approve_task_gate") {
      const parsed = approveTaskGateSchema.parse(args);
      const task = requireTask(parsed.taskId);
      const approver = requireAgent(parsed.byAgentId);

      assertAgentRole(approver, [parsed.gate], "approve_task_gate");
      if (!requiresQualityGates(task)) {
        throw new Error("Для этой задачи quality-gates не требуются");
      }

      task.approvals[parsed.gate] = {
        byAgentId: approver.id,
        at: nowIso(),
        note: parsed.note,
      };
      task.updatedAt = nowIso();
      await upsertTask(task);

      const message = addSystemMessage({
        fromAgentId: approver.id,
        taskId: task.id,
        type: "update",
        content: `Quality-gate подтвержден: ${parsed.gate}`,
      });
      await insertMessage(message);

      return asText({ ok: true, taskId: task.id, approvals: task.approvals });
    }

    if (name === "resolve_task") {
      const parsed = resolveTaskSchema.parse(args);
      const task = requireTask(parsed.taskId);
      const actor = requireAgent(parsed.byAgentId);
      assertAgentRole(actor, ["coordinator", "deployer", "reviewer"], "resolve_task");

      if (requiresQualityGates(task)) {
        if (!task.approvals.reviewer) {
          throw new Error("Нельзя закрыть задачу: отсутствует подтверждение reviewer");
        }
        if (!task.approvals.tester) {
          throw new Error("Нельзя закрыть задачу: отсутствует подтверждение tester");
        }
      }

      task.status = "done";
      task.resolution = parsed.resolution;
      task.blockedSince = undefined;
      task.escalationLevel = 0;
      task.updatedAt = nowIso();
      await upsertTask(task);

      if (task.assignedTo) {
        const owner = agents.get(task.assignedTo);
        if (owner) {
          owner.load = Math.max(0, owner.load - 10);
          owner.status = owner.load > 0 ? "busy" : "idle";
          owner.lastSeenAt = nowIso();
          await upsertAgent(owner);
        }
      }

      const message = addSystemMessage({
        fromAgentId: parsed.byAgentId,
        taskId: task.id,
        type: "update",
        content: `Задача завершена: ${parsed.resolution}`,
      });
      await insertMessage(message);

      return asText({ ok: true, task });
    }

    if (name === "post_message") {
      const parsed = postMessageSchema.parse(args);
      requireAgent(parsed.fromAgentId);
      if (parsed.toAgentId) {
        requireAgent(parsed.toAgentId);
      }
      if (parsed.taskId) {
        requireTask(parsed.taskId);
      }

      const message: AgentMessage = {
        id: id("msg"),
        fromAgentId: parsed.fromAgentId,
        toAgentId: parsed.toAgentId,
        taskId: parsed.taskId,
        type: parsed.type,
        content: parsed.content,
        createdAt: nowIso(),
      };

      messages.push(message);
      await insertMessage(message);
      return asText({ ok: true, message });
    }

    if (name === "rebalance_workload") {
      const parsed = rebalanceSchema.parse(args);
      const actor = requireAgent(parsed.byAgentId);
      assertAgentRole(actor, ["coordinator"], "rebalance_workload");

      const assignments = rebalanceUnassignedTasks();
      for (const assignment of assignments) {
        const task = tasks.get(assignment.taskId);
        const agent = agents.get(assignment.agentId);
        if (task) {
          await upsertTask(task);
        }
        if (agent) {
          await upsertAgent(agent);
        }
      }
      return asText({ ok: true, assignments, changed: assignments.length });
    }

    if (name === "run_escalation_scan") {
      const parsed = escalationScanSchema.parse(args);
      const actor = requireAgent(parsed.byAgentId);
      assertAgentRole(actor, ["coordinator"], "run_escalation_scan");

      const changes = await runEscalationScan(parsed.byAgentId);
      return asText({ ok: true, changed: changes.length, changes });
    }

    if (name === "get_coordination_snapshot") {
      const parsed = snapshotSchema.parse(args ?? {});
      const lastMessages = messages.slice(-parsed.messageLimit);

      return asText({
        server: "multi-agent-orchestrator",
        dbPath: DB_PATH,
        escalation: {
          thresholdsMinutes: ESCALATION_THRESHOLDS_MINUTES,
          scanIntervalMs: ESCALATION_SCAN_INTERVAL_MS,
        },
        roleCoverage: computeRoleCoverage(),
        taskStats: computeTaskStats(),
        agents: [...agents.values()],
        tasks: [...tasks.values()],
        recentMessages: lastMessages,
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Неизвестная ошибка";
    return {
      isError: true,
      content: [{ type: "text", text: message }],
    };
  }

  return {
    isError: true,
    content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }],
  };
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return {
    resources: [
      {
        uri: "info://server",
        name: "server-info",
        description: "Информация об оркестраторе",
        mimeType: "application/json",
      },
      {
        uri: "orchestration://agents",
        name: "agents",
        description: "Список агентов и их роли",
        mimeType: "application/json",
      },
      {
        uri: "orchestration://tasks",
        name: "tasks",
        description: "Состояние задач",
        mimeType: "application/json",
      },
      {
        uri: "orchestration://messages",
        name: "messages",
        description: "Лента сообщений между агентами",
        mimeType: "application/json",
      },
      {
        uri: "orchestration://snapshot",
        name: "snapshot",
        description: "Единый срез координации",
        mimeType: "application/json",
      },
      {
        uri: "orchestration://policies",
        name: "policies",
        description: "Активные правила ролей и quality-gates",
        mimeType: "application/json",
      },
    ],
  };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  if (request.params.uri === "info://server") {
    return {
      contents: [
        {
          uri: "info://server",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              name: "multi-agent-orchestrator",
              version: "2.0.0",
              dbPath: DB_PATH,
              purpose: "Координация множества ИИ-агентов с четкими ролями и максимальной связью",
              tools: [
                "register_agent",
                "update_agent_status",
                "create_task",
                "assign_task",
                "set_task_status",
                "resolve_task",
                "approve_task_gate",
                "post_message",
                "rebalance_workload",
                "run_escalation_scan",
                "get_coordination_snapshot",
              ],
              roles: ROLE_CATALOG,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (request.params.uri === "orchestration://agents") {
    return {
      contents: [
        {
          uri: "orchestration://agents",
          mimeType: "application/json",
          text: JSON.stringify([...agents.values()], null, 2),
        },
      ],
    };
  }

  if (request.params.uri === "orchestration://tasks") {
    return {
      contents: [
        {
          uri: "orchestration://tasks",
          mimeType: "application/json",
          text: JSON.stringify([...tasks.values()], null, 2),
        },
      ],
    };
  }

  if (request.params.uri === "orchestration://messages") {
    return {
      contents: [
        {
          uri: "orchestration://messages",
          mimeType: "application/json",
          text: JSON.stringify(messages, null, 2),
        },
      ],
    };
  }

  if (request.params.uri === "orchestration://snapshot") {
    return {
      contents: [
        {
          uri: "orchestration://snapshot",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              roleCoverage: computeRoleCoverage(),
              taskStats: computeTaskStats(),
              dbPath: DB_PATH,
              escalation: {
                thresholdsMinutes: ESCALATION_THRESHOLDS_MINUTES,
                scanIntervalMs: ESCALATION_SCAN_INTERVAL_MS,
              },
              agents: [...agents.values()],
              tasks: [...tasks.values()],
              recentMessages: messages.slice(-30),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (request.params.uri === "orchestration://policies") {
    return {
      contents: [
        {
          uri: "orchestration://policies",
          mimeType: "application/json",
          text: JSON.stringify(
            {
              rolePolicies: {
                create_task: ["coordinator", "planner", "analyst"],
                assign_task: ["coordinator"],
                rebalance_workload: ["coordinator"],
                run_escalation_scan: ["coordinator"],
                resolve_task: ["coordinator", "deployer", "reviewer"],
              },
              workflowRules: [
                "set_task_status не может завершать задачу через done",
                "Для задач с role=coder обязательны approvals reviewer и tester",
                "Только назначенный агент или coordinator может менять статус задачи",
                "Blocked-задачи автоматически эскалируются по времени с alert-сообщением",
              ],
              qualityGates: ["reviewer", "tester"],
              escalation: {
                thresholdsMinutes: ESCALATION_THRESHOLDS_MINUTES,
                scanIntervalMs: ESCALATION_SCAN_INTERVAL_MS,
              },
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  throw new Error(`Неизвестный ресурс: ${request.params.uri}`);
});

async function main() {
  await initDatabase();
  await loadStateFromDatabase();

  setInterval(() => {
    void runEscalationScan("system").catch((error) => {
      console.error("Escalation scan failed:", error);
    });
  }, ESCALATION_SCAN_INTERVAL_MS);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("MCP server failed to start:", error);
  process.exit(1);
});
