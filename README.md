# multi-agent-orchestrator

MCP-сервер для совместной работы множества ИИ-агентов с четкими ролями, quality-gates и персистентным состоянием в SQLite.

Документ ниже содержит полный runbook: установка, запуск сервера, подключение MCP в VS Code, запуск локального клиента и диагностика проблем.

## 1) Что реализовано

- Роли агентов: coordinator, planner, researcher, coder, reviewer, tester, documenter, analyst, deployer, custom.
- Оркестрация задач: создание, назначение, смена статусов, завершение.
- Строгие ролевые политики и обязательные quality-gates для задач с coder.
- Сообщения между агентами: handoff, update, question, alert.
- Автоэскалация blocked-задач по времени с повышением приоритета.
- Персистентность в SQLite: агенты, задачи, сообщения сохраняются между перезапусками.

## 2) Требования

- Node.js 20+ (рекомендуется LTS).
- npm.
- Windows PowerShell, cmd, Git Bash или другой терминал.

Примечание для Windows PowerShell:

- Если срабатывает Execution Policy на npm.ps1, используйте npm.cmd.

## 3) Структура ключевых файлов

- Сервер: src/index.ts
- Клиент: src/client.ts
- Конфиг MCP для VS Code: .vscode/mcp.json
- VS Code tasks: .vscode/tasks.json
- Скомпилированные файлы: dist/
- База данных: data/orchestrator.db

## 4) Установка зависимостей

В корне проекта:

```powershell
cd c:\Users\Liosh\Desktop\programming\MCP
npm.cmd install
```

## 5) Сборка проекта

```powershell
npm.cmd run build
```

После сборки будут доступны:

- dist/index.js (сервер)
- dist/client.js (клиент)

## 6) Запуск сервера

### Вариант A: production-подобный запуск (из dist)

```powershell
npm.cmd run build
npm.cmd run start
```

или напрямую:

```powershell
node dist/index.js
```

### Вариант B: development-запуск (без предварительной сборки)

```powershell
npm.cmd run dev
```

## 7) Подключение сервера в VS Code (GitHub Copilot MCP)

Проект уже содержит готовый конфиг .vscode/mcp.json:

```json
{
	"servers": {
		"multi-agent-orchestrator": {
			"type": "stdio",
			"command": "npm.cmd",
			"args": ["run", "dev"],
			"cwd": "${workspaceFolder}"
		}
	}
}
```

Шаги:

1. Откройте папку проекта в VS Code.
2. Убедитесь, что .vscode/mcp.json присутствует.
3. Выполните команду Developer: Reload Window.
4. Откройте Copilot Chat и проверьте подключенный MCP-сервер multi-agent-orchestrator.

## 8) VS Code задачи (опционально)

Доступны задачи из .vscode/tasks.json:

- mcp: install
- mcp: build
- mcp: dev
- mcp: start

Запуск:

1. Ctrl+Shift+P
2. Tasks: Run Task
3. Выберите нужную задачу

## 9) Запуск локального клиента

Клиент расположен в src/client.ts и подключается к серверу по stdio.

### Быстрый запуск demo-сценария

```powershell
npm.cmd run build
npm.cmd run client
```

### Режимы клиента (dev)

```powershell
npm.cmd run client:dev -- --mode list-tools
npm.cmd run client:dev -- --mode snapshot
npm.cmd run client:dev -- --mode demo
```

### Подключение клиента к кастомной команде сервера

Пример запуска сервера через npm run dev:

```powershell
npm.cmd run client:dev -- --server-command npm.cmd --server-args "run dev"
```

Параметры клиента:

- --mode list-tools | snapshot | demo
- --server-command <команда>
- --server-args "<аргументы через пробел>"
- --server-cwd <рабочая папка>
- --run-escalation-scan

## 10) Полный сценарий запуска с нуля

```powershell
cd c:\Users\Liosh\Desktop\programming\MCP
npm.cmd install
npm.cmd run build
npm.cmd run client:dev -- --mode list-tools
npm.cmd run client:dev -- --mode demo
npm.cmd run client:dev -- --mode snapshot
```

## 11) Доступные MCP tools

- register_agent
- update_agent_status
- create_task
- assign_task
- set_task_status
- approve_task_gate
- resolve_task
- post_message
- rebalance_workload
- run_escalation_scan
- get_coordination_snapshot

## 12) Доступные MCP resources

- info://server
- orchestration://agents
- orchestration://tasks
- orchestration://messages
- orchestration://snapshot
- orchestration://policies

## 13) Политики и quality-gates

- create_task: coordinator, planner, analyst
- assign_task: coordinator (через byAgentId)
- rebalance_workload: coordinator
- run_escalation_scan: coordinator
- set_task_status: назначенный агент задачи или coordinator
- set_task_status(status=done): запрещено
- resolve_task: coordinator, deployer, reviewer
- Для задач с requiredRoles, содержащим coder, нужны approvals reviewer и tester

## 14) Автоэскалация блокеров

- Пороги: 10, 30, 60 минут в blocked
- На каждом новом пороге приоритет повышается на одну ступень
- В ленту сообщений добавляется alert
- Автоскан запускается по таймеру

Настройка интервала автоскана:

```powershell
$env:ESCALATION_SCAN_INTERVAL_MS = "15000"
npm.cmd run dev
```

Ручной запуск эскалации через tool:

- run_escalation_scan с byAgentId роли coordinator

## 15) База данных и сброс состояния

Путь к БД:

- data/orchestrator.db

Полный сброс состояния:

```powershell
Remove-Item -Force .\data\orchestrator.db
```

После удаления просто перезапустите сервер, БД создастся заново.

## 16) npm scripts

```json
{
	"build": "tsc -p tsconfig.json",
	"start": "node dist/index.js",
	"dev": "tsx src/index.ts",
	"client": "node dist/client.js",
	"client:dev": "tsx src/client.ts"
}
```

## 17) Troubleshooting

### Проблема: Cannot find module ... index.ts

Причина: попытка запускать TypeScript-файл напрямую через node.

Решение:

```powershell
npm.cmd run build
node dist/index.js
```

или:

```powershell
npm.cmd run dev
```

### Проблема: PowerShell блокирует npm.ps1

Решение: использовать npm.cmd вместо npm.

### Проблема: MCP-сервер не виден в Copilot

1. Проверьте .vscode/mcp.json
2. Выполните Developer: Reload Window
3. Убедитесь, что npm.cmd run dev стартует без ошибок

### Проблема: клиент не может подключиться к серверу

1. Проверьте --server-command и --server-args
2. Проверьте рабочую директорию --server-cwd
3. Запустите npm.cmd run client:dev -- --mode list-tools для быстрой диагностики
