// Client-side applier — exported as a plain string so we can inject it via a
// <script dangerouslySetInnerHTML> or include it inside the React widget.
// Living in /lib so build-time tools can lint it.

export const UI_APPLIER_SOURCE = `
(function(){
  if (window.__easyApplyInstalled) return;
  window.__easyApplyInstalled = true;

  const styleNodes = new Map();
  const tooltips = new Set();
  const activity = [];

  function $$(sel){ try { return [...document.querySelectorAll(sel)]; } catch { return []; } }
  function bestSelector(el){
    if (!el || el.nodeType !== 1) return "";
    if (el.id) return "#" + el.id;
    if (el.dataset && el.dataset.testid) return '[data-testid="'+el.dataset.testid+'"]';
    const cls = [...el.classList].filter(c => !/^(css-|sc-|_)/.test(c)).slice(0,2).join(".");
    const tag = el.tagName.toLowerCase();
    return cls ? tag + "." + cls : tag;
  }

  function logActivity(ev){
    activity.push({ t: Date.now(), ...ev });
    if (activity.length > 50) activity.shift();
  }

  window.addEventListener("click", (e) => {
    const t = e.target; if (!(t instanceof Element)) return;
    logActivity({ kind: "click", selector: bestSelector(t), text: (t.textContent||"").slice(0,60) });
  }, true);
  window.addEventListener("input", (e) => {
    const t = e.target;
    if (!(t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)) return;
    logActivity({ kind: "input", selector: bestSelector(t), name: t.name || t.id });
  }, true);
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath){ lastPath = location.pathname; logActivity({ kind:"nav", path: lastPath }); }
  }, 250);

  function snapshot(){
    const sel = "a,button,input,textarea,select,[role='button'],[data-testid],h1,h2,h3,nav,main,header,footer,form,table,.card,.panel,.tab,.btn";
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (out.length >= 120) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return;
      out.push({
        tag: el.tagName.toLowerCase(),
        sel: bestSelector(el),
        text: (el.textContent || "").trim().slice(0, 80),
        role: el.getAttribute("role"),
        name: el.getAttribute("name") || el.getAttribute("aria-label"),
        visible: rect.top < innerHeight && rect.bottom > 0,
      });
    });
    return {
      url: location.href,
      path: location.pathname,
      title: document.title,
      viewport: { w: innerWidth, h: innerHeight },
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
      density: document.documentElement.dataset.density || "comfortable",
      elements: out,
      recent_activity: activity.slice(-15),
    };
  }
  window.__easyContext = { snapshot, activity };

  function showToast(msg, level, ms){
    const el = document.createElement("div");
    el.textContent = msg;
    const bg = { info: "#0ea5e9", warn: "#f59e0b", error: "#ef4444" }[level || "info"];
    Object.assign(el.style, {
      position: "fixed", bottom: "20px", left: "20px", zIndex: 99999,
      padding: "10px 14px", borderRadius: "8px", color: "#fff",
      background: bg, boxShadow: "0 4px 12px rgba(0,0,0,.18)",
      fontFamily: "system-ui", fontSize: "14px", maxWidth: "320px",
    });
    document.body.appendChild(el);
    setTimeout(() => el.remove(), ms || 3000);
  }

  function showExplain(target, text, placement){
    const el = $$(target)[0]; if (!el) return;
    const rect = el.getBoundingClientRect();
    const tip = document.createElement("div");
    tip.textContent = text;
    Object.assign(tip.style, {
      position: "fixed", zIndex: 99999, background: "#111827", color: "#fff",
      padding: "8px 12px", borderRadius: "6px", fontSize: "13px", maxWidth: "260px",
      boxShadow: "0 6px 16px rgba(0,0,0,.25)", fontFamily: "system-ui",
    });
    document.body.appendChild(tip);
    const p = placement || "top";
    const tr = tip.getBoundingClientRect();
    let top, left;
    if (p === "top") { top = rect.top - tr.height - 8; left = rect.left + rect.width/2 - tr.width/2; }
    else if (p === "bottom") { top = rect.bottom + 8; left = rect.left + rect.width/2 - tr.width/2; }
    else if (p === "left") { top = rect.top + rect.height/2 - tr.height/2; left = rect.left - tr.width - 8; }
    else { top = rect.top + rect.height/2 - tr.height/2; left = rect.right + 8; }
    tip.style.top = Math.max(8, top) + "px";
    tip.style.left = Math.max(8, left) + "px";
    tooltips.add(tip);
    el.style.outline = "2px solid #22c55e"; el.style.outlineOffset = "2px";
    setTimeout(() => {
      tip.remove(); tooltips.delete(tip);
      el.style.outline = ""; el.style.outlineOffset = "";
    }, 4500);
  }

  function apply(op){
    try {
      switch(op.op){
        case "ui_update_style":
          $$(op.selector).forEach(el => el.style[op.property] = op.value); break;
        case "ui_set_text":
          $$(op.selector).forEach(el => el.textContent = op.text); break;
        case "ui_set_attr":
          $$(op.selector).forEach(el => el.setAttribute(op.name, op.value)); break;
        case "ui_add_class":
          $$(op.selector).forEach(el => el.classList.add(op.className)); break;
        case "ui_remove_class":
          $$(op.selector).forEach(el => el.classList.remove(op.className)); break;
        case "ui_hide":
          $$(op.selector).forEach(el => el.style.display = "none"); break;
        case "ui_show":
          $$(op.selector).forEach(el => el.style.display = "revert"); break;
        case "ui_remove_element":
          $$(op.selector).forEach(el => el.remove()); break;
        case "ui_insert_html":
          $$(op.selector).forEach(el => el.insertAdjacentHTML(op.position, op.html)); break;
        case "ui_set_value":
          $$(op.selector).forEach(el => {
            el.value = op.value;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }); break;
        case "ui_click":
          $$(op.selector).forEach(el => el.click()); break;
        case "ui_scroll_to":
          $$(op.selector)[0]?.scrollIntoView({ block: op.block || "center", behavior: "smooth" }); break;
        case "ui_inject_css": {
          let n = styleNodes.get(op.key);
          if (!n){
            n = document.createElement("style");
            n.dataset.easyKey = op.key;
            document.head.appendChild(n);
            styleNodes.set(op.key, n);
          }
          n.textContent = op.css; break;
        }
        case "ui_remove_css": {
          const n = styleNodes.get(op.key);
          if (n){ n.remove(); styleNodes.delete(op.key); } break;
        }
        case "ui_toast":
          showToast(op.message, op.level, op.duration_ms); break;
        case "ui_navigate":
          history.pushState({}, "", op.path);
          window.dispatchEvent(new PopStateEvent("popstate"));
          break;
        case "ui_set_theme":
          Object.entries(op.vars || {}).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
          try { localStorage.setItem("easy_theme_vars", JSON.stringify(op.vars)); } catch {}
          break;
        case "ui_set_dark_mode":
          document.documentElement.classList.toggle("dark", !!op.on);
          try { localStorage.setItem("easy_dark", op.on ? "1" : "0"); } catch {}
          break;
        case "ui_set_density":
          document.documentElement.dataset.density = op.density;
          try { localStorage.setItem("easy_density", op.density); } catch {}
          break;
        case "ui_set_font":
          document.documentElement.style.setProperty("--ui-font", op.family);
          document.body.style.fontFamily = op.family;
          try { localStorage.setItem("easy_font", op.family); } catch {}
          break;
        case "ui_set_font_size":
          document.documentElement.style.fontSize = op.px + "px";
          try { localStorage.setItem("easy_font_size", String(op.px)); } catch {}
          break;
        case "ui_highlight":
          $$(op.selector).forEach(el => {
            const prev = el.style.outline;
            const prevO = el.style.outlineOffset;
            el.style.outline = "2px solid " + (op.color || "#22c55e");
            el.style.outlineOffset = "2px";
            setTimeout(() => { el.style.outline = prev; el.style.outlineOffset = prevO; }, 1600);
          }); break;
        case "ui_disable":
          $$(op.selector).forEach(el => { el.disabled = true; el.setAttribute("aria-disabled","true"); }); break;
        case "ui_enable":
          $$(op.selector).forEach(el => { el.disabled = false; el.removeAttribute("aria-disabled"); }); break;
        case "ui_set_title":
          document.title = op.title; break;
        case "ui_focus":
          $$(op.selector)[0]?.focus(); break;
        case "ui_explain":
          showExplain(op.selector, op.text, op.placement); break;
        case "ui_save_theme": {
          const theme = {
            vars: JSON.parse(localStorage.getItem("easy_theme_vars") || "{}"),
            dark: localStorage.getItem("easy_dark") === "1",
            density: localStorage.getItem("easy_density"),
            font: localStorage.getItem("easy_font"),
            font_size: localStorage.getItem("easy_font_size"),
          };
          const all = JSON.parse(localStorage.getItem("easy_themes") || "{}");
          all[op.name || "default"] = theme;
          localStorage.setItem("easy_themes", JSON.stringify(all));
          showToast("Saved theme as '" + (op.name || "default") + "'", "info", 2500);
          break;
        }
      }
    } catch (e) {
      console.error("[easy] apply failed", op, e);
    }
  }
  window.__easyApply = apply;

  // Restore persisted theme on load
  try {
    const vars = JSON.parse(localStorage.getItem("easy_theme_vars") || "null");
    if (vars) apply({ op: "ui_set_theme", vars });
    if (localStorage.getItem("easy_dark") === "1") apply({ op: "ui_set_dark_mode", on: true });
    const d = localStorage.getItem("easy_density"); if (d) apply({ op: "ui_set_density", density: d });
    const f = localStorage.getItem("easy_font"); if (f) apply({ op: "ui_set_font", family: f });
    const fs = localStorage.getItem("easy_font_size"); if (fs) apply({ op: "ui_set_font_size", px: Number(fs) });
  } catch {}
})();
`;
