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
  .item input[type="checkbox"] { width: 16px; height: 16px; margin: 0; cursor: pointer; }
  .item.done .text { text-decoration: line-through; color: #888; }
  .item.done .box { background: #2e7d32; color: #fff; border-color: #2e7d32; }
  .empty { color: #888; padding: 8px; }
</style>
</head>
<body>
  <h1>Todo List</h1>
  <div id="todo-counts" class="counts">${done} of ${total} done</div>
  <ul id="todo-list">${rows}</ul>
  <script>
  (function () {
    "use strict";
    // SEP-1865 MCP Apps view<->host postMessage JSON-RPC bridge.
    // Everything below runs in the browser (sandboxed iframe). It is INLINE
    // vanilla JS with NO imports / NO external scripts (claude.ai CSP-safe).
    // If the handshake never completes, the server-rendered fallback list
    // (above) is left untouched.
    try {
      var nextId = 1;
      var pending = new Map();

      function post(msg) {
        window.parent.postMessage(msg, "*");
      }

      // Send a JSON-RPC request and resolve with its \`result\`.
      function request(method, params) {
        return new Promise(function (resolve, reject) {
          var id = nextId++;
          pending.set(id, { resolve: resolve, reject: reject });
          post({ jsonrpc: "2.0", id: id, method: method, params: params || {} });
        });
      }

      function notify(method, params) {
        post({ jsonrpc: "2.0", method: method, params: params || {} });
      }

      window.addEventListener("message", function (e) {
        var msg = e.data;
        if (!msg || msg.jsonrpc !== "2.0") return;
        // Correlate responses by JSON-RPC id.
        if (msg.id != null && pending.has(msg.id)) {
          var p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || "RPC error"));
          else p.resolve(msg.result);
          return;
        }
        // Inbound host notifications (ignore-safe; we do not depend on them).
        if (msg.method === "ui/notifications/tool-result" ||
            msg.method === "ui/notifications/tool-input") {
          return;
        }
      });

      // Call a server tool; returns the parsed CallToolResult.
      function callTool(name, args) {
        return request("tools/call", { name: name, arguments: args || {} });
      }

      // Pull text out of a CallToolResult.
      function resultText(res) {
        if (res && res.content && res.content[0] && res.content[0].type === "text") {
          return res.content[0].text;
        }
        return "";
      }

      function escapeText(s) {
        return String(s)
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#39;");
      }

      // Re-render the list client-side with interactive checkboxes.
      function render(items) {
        var list = document.getElementById("todo-list");
        var counts = document.getElementById("todo-counts");
        if (!list) return;
        while (list.firstChild) list.removeChild(list.firstChild);

        if (!items || items.length === 0) {
          var empty = document.createElement("li");
          empty.className = "empty";
          empty.textContent = "No tasks yet.";
          list.appendChild(empty);
        } else {
          for (var i = 0; i < items.length; i++) {
            (function (task) {
              var li = document.createElement("li");
              li.className = task.completed ? "item done" : "item";

              var cb = document.createElement("input");
              cb.type = "checkbox";
              cb.checked = !!task.completed;
              cb.setAttribute("data-id", task.id);

              var span = document.createElement("span");
              span.className = "text";
              span.textContent = task.text;

              cb.addEventListener("change", function () {
                onToggle(cb);
              });

              li.appendChild(cb);
              li.appendChild(span);
              list.appendChild(li);
            })(items[i]);
          }
        }

        if (counts) {
          var total = items ? items.length : 0;
          var done = 0;
          if (items) {
            for (var j = 0; j < items.length; j++) {
              if (items[j].completed) done++;
            }
          }
          counts.textContent = done + " of " + total + " done";
        }
      }

      function refresh() {
        return callTool("get_tasks", { filter: "all" }).then(function (res) {
          var txt = resultText(res);
          var items = [];
          try { items = JSON.parse(txt); } catch (err) { items = []; }
          render(items);
          return items;
        });
      }

      function onToggle(cb) {
        var id = cb.getAttribute("data-id");
        var completed = cb.checked;
        cb.disabled = true; // disable while the round-trip is in flight
        callTool("update_task", { id: id, completed: completed })
          .then(function () { return refresh(); })
          .catch(function () { /* swallow; keep widget alive */ })
          .then(function () { cb.disabled = false; });
      }

      // Handshake, then enter the interactive loop.
      request("ui/initialize", {
        protocolVersion: "2026-01-26",
        clientInfo: { name: "todo-widget", version: "1.0.0" },
        capabilities: {},
        appCapabilities: {
          tools: { listChanged: true },
          availableDisplayModes: ["inline", "fullscreen"]
        }
      }).then(function () {
        notify("ui/notifications/initialized", {});
        return refresh();
      }).catch(function () {
        // No host / non-supporting client: leave the fallback list as-is.
      });

      // Silence the unused-var lint for escapeText if a host later wants it
      // for innerHTML; kept available but DOM uses textContent for safety.
      void escapeText;
    } catch (err) {
      // Never throw uncaught; the server-rendered fallback remains usable.
    }
  })();
  </script>
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
