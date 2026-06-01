import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";

type Task = {
  id: string;
  text: string;
  completed: boolean;
  createdAt: string;
  updatedAt: string;
};

// Shared in-memory task store at module scope so it persists across the
// per-request server instances created in stateless Streamable HTTP mode
// (sessionIdGenerator: undefined). Resets on process restart/redeploy.
const tasks: Task[] = [];

export const getServer = (): McpServer => {
  const server = new McpServer(
    { name: "mcp-todo-server", version: "1.0.0" },
    { capabilities: {} },
  );

  const text = (s: string): CallToolResult => ({ content: [{ type: "text", text: s }] });

  server.registerTool(
    "create_task",
    {
      title: "Create Task",
      description: "Creates a new task in the todo list",
      inputSchema: { text: z.string().min(1).max(500).describe("Task text") },
    },
    async ({ text: t }): Promise<CallToolResult> => {
      const now = new Date().toISOString();
      const task: Task = { id: uuidv4(), text: t.trim(), completed: false, createdAt: now, updatedAt: now };
      tasks.push(task);
      return text(`Created task ${task.id}: "${task.text}"`);
    },
  );

  server.registerTool(
    "get_tasks",
    {
      title: "Get Tasks",
      description: "Retrieves tasks with filtering",
      inputSchema: { filter: z.enum(["all", "pending", "completed"]).describe("Filter by status") },
    },
    async ({ filter }): Promise<CallToolResult> => {
      const filtered = tasks.filter((x) =>
        filter === "all" ? true : filter === "completed" ? x.completed : !x.completed,
      );
      return text(JSON.stringify(filtered, null, 2));
    },
  );

  server.registerTool(
    "update_task",
    {
      title: "Update Task",
      description: "Updates a task completion status by ID",
      inputSchema: {
        id: z.string().uuid().describe("Task UUID"),
        completed: z.boolean().describe("Completion status"),
      },
    },
    async ({ id, completed }): Promise<CallToolResult> => {
      const t = tasks.find((x) => x.id === id);
      if (!t) return text(`Task ${id} not found`);
      t.completed = completed;
      t.updatedAt = new Date().toISOString();
      return text(`Updated task ${id}: completed=${completed}`);
    },
  );

  server.registerTool(
    "complete_task_by_text",
    {
      title: "Complete Task By Text",
      description: "Marks a task as completed by partial text match",
      inputSchema: { text: z.string().min(1).max(500).describe("Text to match") },
    },
    async ({ text: q }): Promise<CallToolResult> => {
      const t = tasks.find((x) => x.text.toLowerCase().includes(q.toLowerCase()) && !x.completed);
      if (!t) return text(`No matching pending task found for "${q}"`);
      t.completed = true;
      t.updatedAt = new Date().toISOString();
      return text(`Completed task ${t.id}: "${t.text}"`);
    },
  );

  server.registerTool(
    "analyze_tasks",
    {
      title: "Analyze Tasks",
      description: "Analyzes the todo list",
      inputSchema: { analysis_type: z.enum(["summary", "progress", "suggestions"]) },
    },
    async ({ analysis_type }): Promise<CallToolResult> => {
      const total = tasks.length;
      const done = tasks.filter((x) => x.completed).length;
      const pending = total - done;
      if (analysis_type === "summary") return text(`Total: ${total}, Done: ${done}, Pending: ${pending}`);
      if (analysis_type === "progress") {
        const pct = total === 0 ? 0 : Math.round((done / total) * 100);
        return text(`Progress: ${pct}% (${done}/${total})`);
      }
      return text(pending === 0 ? "All caught up!" : `You have ${pending} pending tasks. Pick the smallest one first.`);
    },
  );

  server.registerTool(
    "delete_task",
    {
      title: "Delete Task",
      description: "Deletes a task by ID",
      inputSchema: { id: z.string().uuid().describe("Task UUID") },
    },
    async ({ id }): Promise<CallToolResult> => {
      const idx = tasks.findIndex((x) => x.id === id);
      if (idx === -1) return text(`Task ${id} not found`);
      const [deleted] = tasks.splice(idx, 1);
      return text(`Deleted task ${deleted.id}: "${deleted.text}"`);
    },
  );

  server.registerTool(
    "clear_all_tasks",
    {
      title: "Clear All Tasks",
      description: "Removes all tasks",
      inputSchema: {},
    },
    async (): Promise<CallToolResult> => {
      const n = tasks.length;
      tasks.length = 0;
      return text(`Cleared ${n} tasks`);
    },
  );

  // --- MCP Apps: interactive HTML UI for the todo list (SEP-1865) ---
  const UI_RESOURCE_URI = "ui://todo/list.html";

  const escapeHtml = (s: string): string =>
    s.replace(/[&<>"']/g, (c) =>
      c === "&" ? "&amp;"
        : c === "<" ? "&lt;"
        : c === ">" ? "&gt;"
        : c === '"' ? "&quot;"
        : "&#39;",
    );

  const renderTodoHtml = (items: Task[]): string => {
    const total = items.length;
    const done = items.filter((x) => x.completed).length;
    const rows = items.length === 0
      ? `<li class="empty">No tasks yet.</li>`
      : items
          .map((t) => {
            const box = t.completed ? "✓" : "";
            const cls = t.completed ? "item done" : "item";
            return `<li class="${cls}"><span class="box">${box}</span><span class="text">${escapeHtml(t.text)}</span></li>`;
          })
          .join("");
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Todo List</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 16px; }
  h1 { font-size: 1.2rem; margin: 0 0 4px; }
  .counts { color: #666; font-size: 0.9rem; margin-bottom: 12px; }
  ul { list-style: none; padding: 0; margin: 0; }
  .item { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border-bottom: 1px solid #e0e0e0; }
  .box { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; border: 1px solid #888; border-radius: 4px; font-size: 13px; line-height: 1; }
  .item.done .text { text-decoration: line-through; color: #888; }
  .item.done .box { background: #2e7d32; color: #fff; border-color: #2e7d32; }
  .empty { color: #888; padding: 8px; }
</style>
</head>
<body>
  <h1>Todo List</h1>
  <div class="counts">${done} of ${total} done</div>
  <ul>${rows}</ul>
</body>
</html>`;
  };

  registerAppResource(
    server,
    "Todo List UI",
    UI_RESOURCE_URI,
    { description: "Interactive HTML view of the current todo list" },
    async () => ({
      contents: [
        {
          uri: UI_RESOURCE_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: renderTodoHtml(tasks),
        },
      ],
    }),
  );

  registerAppTool(
    server,
    "show_todo_ui",
    {
      title: "Show Todo UI",
      description: "Displays the current todo list as an interactive HTML UI",
      inputSchema: { filter: z.enum(["all", "pending", "completed"]).optional().describe("Filter by status") },
      _meta: { ui: { resourceUri: UI_RESOURCE_URI } },
    },
    async ({ filter }): Promise<CallToolResult> => {
      const f = filter ?? "all";
      const filtered = tasks.filter((x) =>
        f === "all" ? true : f === "completed" ? x.completed : !x.completed,
      );
      const done = filtered.filter((x) => x.completed).length;
      return text(`Showing todo UI: ${filtered.length} tasks (${done} done, ${filtered.length - done} pending).`);
    },
  );

  return server;
};
