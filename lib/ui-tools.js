// UI manipulation tools — these don't touch the database. They emit DOM-op
// instructions that the AssistantWidget applies live to the page the user is on.
// Each tool returns an object with `kind: "ui"` so the agent loop knows to
// route it into the response's ui_ops array.
//
// Why this is split from lib/tools.js: those tools mutate league data (records,
// fields, rules) and go through the audit log; UI ops are ephemeral visual
// changes the user can also save to a "theme" later. Keeping them separate
// keeps the audit log clean.

const op = (name) => (args) => ({ kind: "ui", op: name, ...args });

const make = (name, description, properties, required = []) => ({
  schema: { type: "function", function: { name, description, parameters: { type: "object", properties, required } } },
  handler: op(name),
});

export const UI_TOOLS = {
  ui_update_style: make(
    "ui_update_style",
    "Change a CSS style on element(s) matching a selector. Use camelCase properties.",
    { selector: { type: "string" }, property: { type: "string" }, value: { type: "string" } },
    ["selector", "property", "value"],
  ),

  ui_set_text: make(
    "ui_set_text",
    "Replace the text content of element(s).",
    { selector: { type: "string" }, text: { type: "string" } },
    ["selector", "text"],
  ),

  ui_set_attr: make(
    "ui_set_attr",
    "Set an HTML attribute (e.g. placeholder, title, data-x).",
    { selector: { type: "string" }, name: { type: "string" }, value: { type: "string" } },
    ["selector", "name", "value"],
  ),

  ui_add_class: make(
    "ui_add_class",
    "Add a CSS class to element(s).",
    { selector: { type: "string" }, className: { type: "string" } },
    ["selector", "className"],
  ),

  ui_remove_class: make(
    "ui_remove_class",
    "Remove a CSS class from element(s).",
    { selector: { type: "string" }, className: { type: "string" } },
    ["selector", "className"],
  ),

  ui_hide: make(
    "ui_hide", "Hide element(s).",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_show: make(
    "ui_show", "Show element(s) (reverts display).",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_remove_element: make(
    "ui_remove_element", "Permanently remove element(s) from the page.",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_insert_html: make(
    "ui_insert_html", "Insert HTML adjacent to a target element.",
    {
      selector: { type: "string" },
      position: { type: "string", enum: ["beforebegin", "afterbegin", "beforeend", "afterend"] },
      html: { type: "string" },
    },
    ["selector", "position", "html"],
  ),

  ui_set_value: make(
    "ui_set_value", "Set an input/textarea/select value and fire change events.",
    { selector: { type: "string" }, value: { type: "string" } }, ["selector", "value"],
  ),

  ui_click: make(
    "ui_click", "Programmatically click an element.",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_scroll_to: make(
    "ui_scroll_to", "Scroll an element into view.",
    {
      selector: { type: "string" },
      block: { type: "string", enum: ["start", "center", "end"] },
    },
    ["selector"],
  ),

  ui_inject_css: make(
    "ui_inject_css", "Inject a <style> block (replaceable by key) so the change can be undone or updated.",
    { key: { type: "string", description: "Unique key; reusing it replaces the previous block." }, css: { type: "string" } },
    ["key", "css"],
  ),

  ui_remove_css: make(
    "ui_remove_css", "Remove a previously injected <style> by key.",
    { key: { type: "string" } }, ["key"],
  ),

  ui_toast: make(
    "ui_toast", "Show a transient toast.",
    {
      message: { type: "string" },
      level: { type: "string", enum: ["info", "warn", "error"] },
      duration_ms: { type: "integer" },
    },
    ["message"],
  ),

  ui_navigate: make(
    "ui_navigate", "Navigate to a route inside the app.",
    { path: { type: "string" } }, ["path"],
  ),

  ui_set_theme: make(
    "ui_set_theme", "Set theme CSS variables. Pass any subset of common tokens.",
    {
      vars: {
        type: "object",
        additionalProperties: { type: "string" },
        description: "Map of CSS variable -> value. Common tokens: --primary, --bg, --fg, --accent, --radius.",
      },
    },
    ["vars"],
  ),

  ui_set_dark_mode: make(
    "ui_set_dark_mode", "Toggle dark mode (adds/removes .dark on <html>).",
    { on: { type: "boolean" } }, ["on"],
  ),

  ui_set_density: make(
    "ui_set_density", "Set layout density (compact | comfortable | spacious).",
    { density: { type: "string", enum: ["compact", "comfortable", "spacious"] } }, ["density"],
  ),

  ui_set_font: make(
    "ui_set_font", "Change the global UI font family.",
    { family: { type: "string", description: 'e.g. "Inter, system-ui" or "Georgia, serif"' } }, ["family"],
  ),

  ui_set_font_size: make(
    "ui_set_font_size", "Set the base font size in pixels.",
    { px: { type: "integer" } }, ["px"],
  ),

  ui_highlight: make(
    "ui_highlight", "Briefly pulse-outline element(s). Use after changing something so the user sees what moved.",
    { selector: { type: "string" }, color: { type: "string" } }, ["selector"],
  ),

  ui_disable: make(
    "ui_disable", "Disable interactive element(s).",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_enable: make(
    "ui_enable", "Enable previously disabled element(s).",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_set_title: make(
    "ui_set_title", "Set the document title (browser tab).",
    { title: { type: "string" } }, ["title"],
  ),

  ui_focus: make(
    "ui_focus", "Focus an element (useful for guiding the user).",
    { selector: { type: "string" } }, ["selector"],
  ),

  ui_explain: make(
    "ui_explain", "Open a callout pointing at an element with explanation text.",
    {
      selector: { type: "string" },
      text: { type: "string" },
      placement: { type: "string", enum: ["top", "bottom", "left", "right"] },
    },
    ["selector", "text"],
  ),

  ui_save_theme: make(
    "ui_save_theme", "Persist the current theme variables as the user's saved default.",
    { name: { type: "string", description: "Theme name to save under" } }, ["name"],
  ),
};

export const UI_TOOL_NAMES = Object.keys(UI_TOOLS);
export const UI_TOOL_SCHEMAS = Object.values(UI_TOOLS).map((t) => t.schema);

export function runUiTool(name, args) {
  const t = UI_TOOLS[name];
  if (!t) return null;
  return t.handler(args || {});
}
