// Code-edit tools — read project files, propose edits as diffs. All edits
// queue in pending-changes/ for human review. The Approve endpoint copies
// the new contents into place.
//
// Safety: every path is resolved against CODE_ROOT and refuses to escape it.

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const CODE_ROOT = path.resolve(process.env.CODE_WORKDIR || process.cwd());
const PENDING_DIR = path.join(CODE_ROOT, ".ai-pending-changes");
fs.mkdirSync(PENDING_DIR, { recursive: true });

function safePath(rel) {
  const abs = path.resolve(CODE_ROOT, rel);
  if (!abs.startsWith(CODE_ROOT)) throw new Error(`Path escapes project root: ${rel}`);
  return abs;
}

// Minimal unified-diff generator — avoids adding the 'diff' package to keep
// the install lean. Not perfect (no context smarts) but plenty for review.
function unifiedDiff(filename, oldStr, newStr) {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  let out = `--- a/${filename}\n+++ b/${filename}\n`;
  const a = oldLines.length, b = newLines.length;
  out += `@@ -1,${a} +1,${b} @@\n`;
  for (const l of oldLines) out += "-" + l + "\n";
  for (const l of newLines) out += "+" + l + "\n";
  return out;
}

const fn = (name, description, properties, required = []) => ({
  type: "function",
  function: { name, description, parameters: { type: "object", properties, required } },
});

export const CODE_TOOL_SCHEMAS = [
  fn("code_read_file", "Read a project source file.", {
    path: { type: "string", description: "Path relative to project root" },
  }, ["path"]),

  fn("code_list_files", "List files under a project directory. Skips node_modules and dotfiles.", {
    dir: { type: "string" },
    recursive: { type: "boolean" },
  }),

  fn("code_search", "Regex-search project source files. Returns up to 200 matches.", {
    pattern: { type: "string" },
    file_glob: { type: "string", description: "Optional path substring filter (e.g. 'components/')" },
  }, ["pattern"]),

  fn("code_propose_edit", "Propose an edit to an existing file. Generates a diff and queues for approval. ALWAYS read the current file first.", {
    path: { type: "string" },
    new_content: { type: "string", description: "Full new file contents" },
    reason: { type: "string", description: "One-sentence why this change" },
  }, ["path", "new_content", "reason"]),

  fn("code_propose_new_file", "Propose creating a new file. Queued for approval.", {
    path: { type: "string" },
    content: { type: "string" },
    reason: { type: "string" },
  }, ["path", "content", "reason"]),

  fn("code_list_pending", "List code changes waiting for approval.", {}),
];

export const CODE_TOOL_NAMES = CODE_TOOL_SCHEMAS.map((s) => s.function.name);

export async function runCodeTool(name, args) {
  switch (name) {
    case "code_read_file":
      return readFile(args.path);
    case "code_list_files":
      return listFiles(args.dir || ".", !!args.recursive);
    case "code_search":
      return searchFiles(args.pattern, args.file_glob);
    case "code_propose_edit":
      return proposeEdit(args.path, args.new_content, args.reason);
    case "code_propose_new_file":
      return proposeNewFile(args.path, args.content, args.reason);
    case "code_list_pending":
      return listPending();
    default:
      return { error: `Unknown code tool: ${name}` };
  }
}

async function readFile(p) {
  const abs = safePath(p);
  const content = await fsp.readFile(abs, "utf8");
  return { path: p, content, bytes: content.length };
}

async function listFiles(dir, recursive) {
  const abs = safePath(dir);
  const skip = new Set(["node_modules", ".next", ".git", ".ai-pending-changes"]);
  const out = [];
  async function walk(d, depth) {
    let items;
    try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (skip.has(it.name) || it.name.startsWith(".")) continue;
      const full = path.join(d, it.name);
      const rel = path.relative(CODE_ROOT, full) + (it.isDirectory() ? "/" : "");
      out.push(rel);
      if (recursive && it.isDirectory() && depth < 5) await walk(full, depth + 1);
    }
  }
  await walk(abs, 0);
  return { files: out.slice(0, 500) };
}

async function searchFiles(pattern, glob) {
  let re;
  try { re = new RegExp(pattern, "gm"); } catch (e) { return { error: `Invalid regex: ${e.message}` }; }
  const skip = new Set(["node_modules", ".next", ".git", ".ai-pending-changes"]);
  const results = [];
  async function walk(d) {
    if (results.length >= 200) return;
    let items;
    try { items = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      if (skip.has(it.name) || it.name.startsWith(".")) continue;
      const full = path.join(d, it.name);
      const rel = path.relative(CODE_ROOT, full);
      if (it.isDirectory()) await walk(full);
      else {
        if (glob && !rel.includes(glob)) continue;
        if (!/\.(js|jsx|ts|tsx|css|json|md|mjs|html)$/.test(it.name)) continue;
        try {
          const content = await fsp.readFile(full, "utf8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (re.test(lines[i])) {
              results.push({ file: rel, line: i + 1, text: lines[i].slice(0, 200).trim() });
              if (results.length >= 200) return;
            }
            re.lastIndex = 0;
          }
        } catch {}
      }
    }
  }
  await walk(CODE_ROOT);
  return { matches: results };
}

async function proposeEdit(p, newContent, reason) {
  const abs = safePath(p);
  let old = "";
  try { old = await fsp.readFile(abs, "utf8"); } catch {}
  if (old === newContent) return { error: "No changes." };
  const diff = unifiedDiff(p, old, newContent);
  const id = Date.now().toString(36) + "_" + path.basename(p).replace(/[^a-z0-9._-]/gi, "_");
  await fsp.writeFile(path.join(PENDING_DIR, id + ".new"), newContent);
  await fsp.writeFile(path.join(PENDING_DIR, id + ".patch"), diff);
  await fsp.writeFile(path.join(PENDING_DIR, id + ".meta.json"),
    JSON.stringify({ kind: "edit", target: p, reason, created_at: Date.now() }, null, 2));
  return { kind: "code-change", pending_id: id, target: p, reason, diff };
}

async function proposeNewFile(p, content, reason) {
  const abs = safePath(p);
  if (fs.existsSync(abs)) return { error: `File already exists: ${p}. Use code_propose_edit instead.` };
  const id = Date.now().toString(36) + "_new_" + path.basename(p).replace(/[^a-z0-9._-]/gi, "_");
  await fsp.writeFile(path.join(PENDING_DIR, id + ".new"), content);
  await fsp.writeFile(path.join(PENDING_DIR, id + ".meta.json"),
    JSON.stringify({ kind: "new", target: p, reason, created_at: Date.now() }, null, 2));
  return { kind: "code-change", pending_id: id, target: p, reason, diff: `(new file: ${p}, ${content.length} bytes)\n${content.slice(0, 800)}` };
}

async function listPending() {
  const files = (await fsp.readdir(PENDING_DIR)).filter((f) => f.endsWith(".meta.json"));
  const out = [];
  for (const f of files) {
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(PENDING_DIR, f), "utf8"));
      const id = f.replace(/\.meta\.json$/, "");
      out.push({ id, ...meta });
    } catch {}
  }
  return out;
}

export async function approveCodeChange(id) {
  const meta = JSON.parse(await fsp.readFile(path.join(PENDING_DIR, id + ".meta.json"), "utf8"));
  const newContent = await fsp.readFile(path.join(PENDING_DIR, id + ".new"), "utf8");
  const target = safePath(meta.target);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, newContent);
  // archive
  await fsp.rename(path.join(PENDING_DIR, id + ".meta.json"), path.join(PENDING_DIR, id + ".applied.json"));
  return { ok: true, target: meta.target };
}

export async function rejectCodeChange(id) {
  for (const ext of [".new", ".patch", ".meta.json"]) {
    try { await fsp.unlink(path.join(PENDING_DIR, id + ext)); } catch {}
  }
  return { ok: true };
}
