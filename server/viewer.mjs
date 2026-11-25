import { extname, posix } from "node:path";
import { evaluate, evaluateFilter, isErrorValue, resolvePropertyValue } from "@quartz-community/bases-page/compiler";
import { marked } from "marked";
import sanitizeHtml from "sanitize-html";
import { parse as parseYaml } from "yaml";

const renderableExtensions = new Set([".md", ".base"]);
const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"]);

export function isViewerDocument(file) {
  return Boolean(file && renderableExtensions.has(extname(file.path).toLowerCase()));
}

export function renderPublicationViewer({ publication, vaultId, currentPath, visibleFiles, key }) {
  const state = createVaultState(visibleFiles, vaultId, key);
  const current = state.byPath.get(currentPath);
  if (!current || !isViewerDocument(current.file)) return null;

  const content = current.extension === ".base"
    ? renderBase(current.raw, currentPath, state)
    : renderMarkdownDocument(current, state);
  const tree = renderExplorer(state.documents, currentPath, state);
  const breadcrumbs = renderBreadcrumbs(currentPath, state);
  const backlinks = renderBacklinks(currentPath, state);
  const searchIndex = state.documents
    .filter(document => document.extension === ".md")
    .map(document => ({ path: document.path, title: document.title, text: document.searchText, url: document.url }));
  const title = current.title || publication.siteTitle;
  const updated = new Date(publication.updatedAt).toLocaleString("ru-RU");

  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>${escapeHtml(title)} — ${escapeHtml(publication.siteTitle)}</title>
<style>${viewerCss}</style></head><body>
<header class="topbar"><button id="menu" class="icon-button mobile-only" aria-label="Открыть проводник">☰</button>
  <a class="brand" href="${state.rootUrl}">${escapeHtml(publication.siteTitle)}</a>
  <button id="theme" class="icon-button" aria-label="Сменить тему">◐</button></header>
<div class="workspace">
  <aside id="sidebar" class="sidebar"><div class="sidebar-title">Проводник</div>
    <label class="search-box"><span>⌕</span><input id="search" type="search" placeholder="Поиск по заметкам…" autocomplete="off"></label>
    <nav id="tree" class="file-tree">${tree || "<p class=muted>Нет доступных заметок</p>"}</nav>
    <div id="search-results" class="search-results" hidden></div>
    <p class="updated">Обновлено ${escapeHtml(updated)}</p>
  </aside>
  <main class="main-pane"><div class="breadcrumbs">${breadcrumbs}</div><article class="markdown-body">${content}</article>${backlinks}</main>
  <aside class="right-sidebar"><div class="sidebar-title">На этой странице</div><nav id="toc" class="toc"></nav></aside>
</div>
<div id="scrim" class="scrim"></div>
<script>window.__SIMPLE_SYNC_SEARCH__=${safeJson(searchIndex)};</script><script>${viewerJs}</script>
</body></html>`;
}

function createVaultState(files, vaultId, key) {
  const query = key ? `?key=${encodeURIComponent(key)}` : "";
  const state = {
    vaultId,
    key,
    query,
    rootUrl: `/view/${encodeURIComponent(vaultId)}/${query}`,
    byPath: new Map(),
    documents: [],
    files,
    fileLookup: new Map()
  };

  for (const file of files) {
    const extension = extname(file.path).toLowerCase();
    const raw = decodeFile(file);
    const parsed = extension === ".md" ? parseMarkdownFile(raw) : { data: {}, body: raw };
    const pathParts = file.path.split("/");
    const fullName = pathParts.at(-1) || file.path;
    const baseName = fullName.slice(0, fullName.length - extension.length);
    const title = stringValue(parsed.data.title) || firstHeading(parsed.body) || baseName;
    const links = extension === ".md" ? extractWikiTargets(parsed.body, false) : [];
    const embeds = extension === ".md" ? extractWikiTargets(parsed.body, true) : [];
    const tags = extractTags(parsed.data, parsed.body);
    const folder = pathParts.slice(0, -1).join("/");
    const fileProperties = {
      name: extension === ".md" ? baseName : fullName,
      basename: baseName,
      fullname: fullName,
      path: file.path,
      folder,
      ext: extension.slice(1),
      tags,
      links,
      embeds,
      modified: new Date(file.mtime || 0),
      mtime: new Date(file.mtime || 0),
      size: Buffer.byteLength(raw)
    };
    const document = {
      file,
      path: file.path,
      extension,
      raw,
      body: parsed.body,
      properties: parsed.data,
      title,
      links,
      embeds,
      fileProperties,
      url: viewerUrl(vaultId, file.path, query),
      searchText: `${title}\n${file.path}\n${stripMarkdown(parsed.body)}`.toLowerCase()
    };
    state.byPath.set(file.path, document);
    state.fileLookup.set(file.path, fileProperties);
    state.fileLookup.set(baseName, fileProperties);
    state.fileLookup.set(fullName, fileProperties);
    if (isViewerDocument(file)) state.documents.push(document);
  }
  state.documents.sort((a, b) => a.path.localeCompare(b.path, "ru", { numeric: true }));
  return state;
}

function renderMarkdownDocument(document, state, depth = 0) {
  if (depth > 5) return `<div class="notice">Достигнута максимальная глубина вложений.</div>`;
  const properties = renderProperties(document.properties);
  let markdown = document.body;
  markdown = markdown.replace(/```base\s*\r?\n([\s\S]*?)```/giu, (_match, source) => renderBase(source, document.path, state));
  markdown = markdown.replace(/(!?)\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/gu, (_match, embed, rawTarget, heading, alias) => {
    const target = resolveWikiTarget(rawTarget.trim(), document.path, state);
    const label = (alias || rawTarget).trim();
    if (!target) return embed ? `<span class="missing-link">${escapeHtml(label)}</span>` : `<span class="missing-link">${escapeHtml(label)}</span>`;
    if (!embed) {
      const anchor = heading ? `#${slugify(heading)}` : "";
      return `<a class="internal-link" href="${escapeHtml(target.url + anchor)}">${escapeHtml(label)}</a>`;
    }
    if (target.extension === ".base") return `<div class="embed base-embed">${renderBase(target.raw, target.path, state)}</div>`;
    if (target.extension === ".md") {
      let embedded = target;
      if (heading) embedded = { ...target, body: selectHeading(target.body, heading) };
      return `<div class="embed markdown-embed"><div class="embed-title"><a href="${escapeHtml(target.url)}">${escapeHtml(target.title)}</a></div>${renderMarkdownDocument(embedded, state, depth + 1)}</div>`;
    }
    if (imageExtensions.has(target.extension)) return `<img src="${escapeHtml(target.url)}" alt="${escapeHtml(label)}" loading="lazy">`;
    return `<a class="attachment" href="${escapeHtml(target.url)}">${escapeHtml(label)}</a>`;
  });

  const renderer = new marked.Renderer();
  renderer.heading = ({ tokens, depth: headingDepth }) => {
    const text = renderer.parser.parseInline(tokens);
    const plain = text.replace(/<[^>]+>/gu, "");
    return `<h${headingDepth} id="${escapeHtml(slugify(plain))}">${text}</h${headingDepth}>`;
  };
  const html = marked.parse(markdown, { gfm: true, breaks: false, renderer });
  return `${properties}${sanitizeRenderedHtml(html)}`;
}

function renderBase(source, currentPath, state) {
  let data;
  try {
    data = parseYaml(source) || {};
  } catch (error) {
    return `<div class="notice error"><strong>Не удалось прочитать Base</strong><br>${escapeHtml(error.message)}</div>`;
  }
  const views = Array.isArray(data.views) && data.views.length ? data.views : [{ type: "table", name: "Таблица" }];
  const entries = buildBaseEntries(data, currentPath, state);
  const resolvedViews = views.map(view => ({ view, entries: filterAndSortEntries(entries, data, view, currentPath, state) }));
  const id = `base-${shortHash(`${currentPath}:${source}`)}`;
  const tabs = views.map((view, index) => `<button class="base-tab${index === 0 ? " active" : ""}" data-base-tab="${id}-${index}">${escapeHtml(view.name || view.type || `Вид ${index + 1}`)}</button>`).join("");
  const panels = resolvedViews.map(({ view, entries: filtered }, index) => {
    return `<section id="${id}-${index}" class="base-panel"${index ? " hidden" : ""}>${renderBaseView(filtered, data, view, state)}</section>`;
  }).join("");
  const count = resolvedViews[0]?.entries.length || 0;
  return `<div class="obsidian-base" data-base="${id}"><div class="base-toolbar"><div class="base-tabs">${tabs}</div><span class="base-count">${count} ${plural(count, "запись", "записи", "записей")}</span></div>${panels}</div>`;
}

function buildBaseEntries(data, currentPath, state) {
  const entries = [];
  for (const document of state.documents) {
    if (document.extension !== ".md") continue;
    const formulaValues = {};
    const context = createEvalContext(document, formulaValues, currentPath, state);
    for (const [name, expression] of Object.entries(data.formulas || {})) {
      try { formulaValues[name] = evaluate(String(expression), context); }
      catch (error) { formulaValues[name] = `#ERROR: ${error.message}`; }
    }
    entries.push({ document, formulaValues });
  }
  return entries;
}

function filterAndSortEntries(entries, data, view, currentPath, state) {
  const filtered = entries.filter(entry => {
    const context = createEvalContext(entry.document, entry.formulaValues, currentPath, state);
    try { return evaluateFilter(data.filters, context) && evaluateFilter(view.filters, context); }
    catch { return false; }
  });
  const sort = Array.isArray(view.sort) && view.sort.length
    ? view.sort
    : Array.isArray(view.order) ? [] : [];
  if (sort.length) {
    filtered.sort((left, right) => {
      for (const item of sort) {
        const a = entryValue(left, item.property, currentPath, state);
        const b = entryValue(right, item.property, currentPath, state);
        const compared = compareValues(a, b);
        if (compared) return String(item.direction).toUpperCase() === "DESC" ? -compared : compared;
      }
      return left.document.title.localeCompare(right.document.title, "ru", { numeric: true });
    });
  }
  return Number.isInteger(view.limit) ? filtered.slice(0, Math.max(0, view.limit)) : filtered;
}

function createEvalContext(document, formulaValues, currentPath, state) {
  const selfDocument = state.byPath.get(currentPath);
  return {
    note: document.properties,
    file: document.fileProperties,
    formula: formulaValues,
    self: selfDocument ? { file: selfDocument.fileProperties, note: selfDocument.properties, ...selfDocument.properties } : undefined,
    locale: "ru-RU",
    _fileLookup: state.fileLookup
  };
}

function entryValue(entry, property, currentPath, state) {
  const context = createEvalContext(entry.document, entry.formulaValues, currentPath, state);
  try { return resolvePropertyValue(property, context); }
  catch { return undefined; }
}

function renderBaseView(entries, data, view, state) {
  const type = String(view.type || "table").toLowerCase();
  if (type === "cards" || type === "gallery") return renderCards(entries, data, view, state);
  if (type === "list") return renderBaseList(entries, data, view, state);
  if (type === "board" || type === "kanban") return renderBoard(entries, data, view, state);
  return renderBaseTable(entries, data, view, state);
}

function renderBaseTable(entries, data, view, state) {
  const columns = baseColumns(entries, view);
  const headers = columns.map(column => `<th data-sortable><span>${escapeHtml(propertyLabel(column, data))}</span><span class="sort-indicator">↕</span></th>`).join("");
  const renderRow = entry => `<tr>${columns.map(column => `<td>${renderValue(entryValue(entry, column, "", state), column, entry, state)}</td>`).join("")}</tr>`;
  let rows;
  if (view.groupBy?.property) {
    const groups = new Map();
    for (const entry of entries) {
      const value = entryValue(entry, view.groupBy.property, "", state);
      const name = value == null || value === "" ? "Без группы" : String(value);
      if (!groups.has(name)) groups.set(name, []);
      groups.get(name).push(entry);
    }
    const ordered = [...groups];
    const configuredOrder = Array.isArray(view.groupOrder) ? view.groupOrder.map(String) : [];
    ordered.sort(([left], [right]) => {
      const leftIndex = configuredOrder.indexOf(left), rightIndex = configuredOrder.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) return (leftIndex < 0 ? Number.MAX_SAFE_INTEGER : leftIndex) - (rightIndex < 0 ? Number.MAX_SAFE_INTEGER : rightIndex);
      const compared = left.localeCompare(right, "ru", { numeric: true });
      return String(view.groupBy.direction).toUpperCase() === "DESC" ? -compared : compared;
    });
    rows = ordered.map(([name, group]) => `<tr class="base-group"><td colspan="${Math.max(1, columns.length)}">${escapeHtml(name)} <span>${group.length}</span></td></tr>${group.map(renderRow).join("")}`).join("");
  } else {
    rows = entries.map(renderRow).join("");
  }
  const summaries = { ...(data.summaries || {}), ...(view.summaries || {}) };
  const footer = Object.keys(summaries).length ? `<tfoot><tr>${columns.map(column => `<td>${renderSummary(entries.map(entry => entryValue(entry, column, "", state)), summaries[column])}</td>`).join("")}</tr></tfoot>` : "";
  return `<div class="base-table-wrap"><table class="base-table"><thead><tr>${headers}</tr></thead><tbody>${rows || `<tr><td colspan="${Math.max(1, columns.length)}" class="muted">Нет записей</td></tr>`}</tbody>${footer}</table></div>`;
}

function renderBaseList(entries, data, view, state) {
  const columns = baseColumns(entries, view);
  const marker = view.markers === "number" ? "ol" : "ul";
  return `<${marker} class="base-list">${entries.map(entry => `<li>${columns.map(column => renderValue(entryValue(entry, column, "", state), column, entry, state)).filter(Boolean).join(escapeHtml(view.separator || ", "))}</li>`).join("")}</${marker}>`;
}

function renderCards(entries, data, view, state) {
  const columns = baseColumns(entries, view);
  return `<div class="base-cards">${entries.map(entry => `<article class="base-card"><h3><a href="${escapeHtml(entry.document.url)}">${escapeHtml(entry.document.title)}</a></h3>${columns.filter(column => column !== "file.name").map(column => `<div class="card-property"><span>${escapeHtml(propertyLabel(column, data))}</span>${renderValue(entryValue(entry, column, "", state), column, entry, state)}</div>`).join("")}</article>`).join("")}</div>`;
}

function renderBoard(entries, data, view, state) {
  const property = view.boardProperty || view.groupBy?.property || "status";
  const groups = new Map();
  for (const entry of entries) {
    const value = entryValue(entry, property, "", state);
    const name = value == null || value === "" ? "Без группы" : String(value);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry);
  }
  return `<div class="base-board">${[...groups].map(([name, group]) => `<section class="board-column"><h3>${escapeHtml(name)} <span>${group.length}</span></h3>${group.map(entry => `<a class="board-card" href="${escapeHtml(entry.document.url)}">${escapeHtml(entry.document.title)}</a>`).join("")}</section>`).join("")}</div>`;
}

function baseColumns(entries, view) {
  if (Array.isArray(view.order) && view.order.length) return view.order;
  const columns = new Set(["file.name"]);
  for (const entry of entries) for (const key of Object.keys(entry.document.properties)) if (key !== "title") columns.add(key);
  return [...columns];
}

function renderValue(value, property, entry, state) {
  if (isErrorValue(value)) return `<span class="formula-error" title="${escapeHtml(value.message)}">#ERROR</span>`;
  if (property === "file.name" || property === "file.basename") return `<a class="internal-link" href="${escapeHtml(entry.document.url)}">${escapeHtml(String(value ?? entry.document.title))}</a>`;
  if (value == null || value === "") return "";
  if (typeof value === "boolean") return `<input type="checkbox" disabled${value ? " checked" : ""}>`;
  if (value instanceof Date) return escapeHtml(value.toLocaleDateString("ru-RU"));
  if (Array.isArray(value)) return value.map(item => `<span class="property-chip">${escapeHtml(String(item))}</span>`).join(" ");
  if (typeof value === "object" && "url" in value) return `<a href="${escapeHtml(String(value.url))}">${escapeHtml(String(value.display || value.url))}</a>`;
  return escapeHtml(String(value));
}

function renderSummary(values, type) {
  if (!type) return "";
  const present = values.filter(value => value !== undefined && value !== null && value !== "");
  const numbers = present.map(Number).filter(Number.isFinite);
  const normalized = String(type).toLowerCase();
  let result;
  if (normalized === "sum") result = numbers.reduce((sum, value) => sum + value, 0);
  else if (normalized === "average") result = numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : "";
  else if (normalized === "min") result = numbers.length ? Math.min(...numbers) : "";
  else if (normalized === "max") result = numbers.length ? Math.max(...numbers) : "";
  else if (normalized === "checked") result = present.filter(Boolean).length;
  else if (normalized === "unchecked") result = present.filter(value => value === false).length;
  else if (normalized === "empty") result = values.length - present.length;
  else if (normalized === "unique") result = new Set(present.map(String)).size;
  else result = present.length;
  return `<span class="summary">${escapeHtml(String(type))} ${escapeHtml(String(result))}</span>`;
}

function propertyLabel(property, data) {
  return data.properties?.[property]?.displayName || ({ "file.name": "Имя", "file.path": "Путь", "file.folder": "Папка" })[property] || property.replace(/^formula\./u, "");
}

function renderExplorer(documents, currentPath, state) {
  const root = { folders: new Map(), files: [] };
  for (const document of documents) {
    const parts = document.path.split("/");
    const fileName = parts.pop();
    let node = root;
    let accumulated = "";
    for (const part of parts) {
      accumulated = accumulated ? `${accumulated}/${part}` : part;
      if (!node.folders.has(part)) node.folders.set(part, { name: part, path: accumulated, folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    node.files.push({ ...document, fileName });
  }
  return renderTreeNode(root, currentPath, 0);
}

function renderTreeNode(node, currentPath, depth) {
  const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name, "ru", { numeric: true }));
  const files = node.files.sort((a, b) => a.title.localeCompare(b.title, "ru", { numeric: true }));
  const folderHtml = folders.map(folder => {
    const activeBranch = currentPath.startsWith(`${folder.path}/`);
    return `<details class="tree-folder" data-folder="${escapeHtml(folder.path)}"${activeBranch || depth === 0 ? " open" : ""}><summary><span class="chevron">›</span><span class="folder-icon">▱</span><span>${escapeHtml(folder.name)}</span></summary><div class="tree-children">${renderTreeNode(folder, currentPath, depth + 1)}</div></details>`;
  }).join("");
  const fileHtml = files.map(file => `<a class="tree-file${file.path === currentPath ? " active" : ""}" href="${escapeHtml(file.url)}" title="${escapeHtml(file.path)}"><span class="file-icon">${file.extension === ".base" ? "▦" : "◇"}</span><span>${escapeHtml(file.title)}</span></a>`).join("");
  return folderHtml + fileHtml;
}

function renderBreadcrumbs(path, state) {
  const parts = path.split("/");
  const links = [`<a href="${state.rootUrl}">Заметки</a>`];
  for (let index = 0; index < parts.length; index++) {
    const partial = parts.slice(0, index + 1).join("/");
    const document = state.byPath.get(partial);
    links.push(document ? `<a href="${escapeHtml(document.url)}">${escapeHtml(document.title)}</a>` : `<span>${escapeHtml(parts[index])}</span>`);
  }
  return links.join("<span class=breadcrumb-separator>›</span>");
}

function renderBacklinks(currentPath, state) {
  const backlinks = state.documents.filter(document => document.extension === ".md" && document.links.some(link => resolveWikiTarget(link, document.path, state)?.path === currentPath));
  if (!backlinks.length) return "";
  return `<section class="backlinks"><h2>Обратные ссылки</h2>${backlinks.map(document => `<a href="${escapeHtml(document.url)}">${escapeHtml(document.title)}</a>`).join("")}</section>`;
}

function renderProperties(properties) {
  const entries = Object.entries(properties || {}).filter(([key]) => key !== "title" && key !== "aliases");
  if (!entries.length) return "";
  return `<details class="properties"><summary>Свойства</summary><dl>${entries.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${renderPlainValue(value)}</dd>`).join("")}</dl></details>`;
}

function renderPlainValue(value) {
  if (Array.isArray(value)) return value.map(item => `<span class="property-chip">${escapeHtml(String(item))}</span>`).join(" ");
  if (typeof value === "boolean") return `<input type="checkbox" disabled${value ? " checked" : ""}>`;
  if (value && typeof value === "object") return escapeHtml(JSON.stringify(value));
  return escapeHtml(String(value ?? ""));
}

function resolveWikiTarget(rawTarget, currentPath, state) {
  const normalized = rawTarget.replaceAll("\\", "/").replace(/^\/+|\/+$/gu, "");
  const currentDir = posix.dirname(currentPath) === "." ? "" : posix.dirname(currentPath);
  const candidates = [normalized, currentDir ? `${currentDir}/${normalized}` : normalized];
  if (!extname(normalized)) {
    candidates.push(`${normalized}.md`, `${normalized}.base`);
    if (currentDir) candidates.push(`${currentDir}/${normalized}.md`, `${currentDir}/${normalized}.base`);
  }
  for (const candidate of candidates) if (state.byPath.has(candidate)) return state.byPath.get(candidate);
  const name = normalized.split("/").at(-1);
  return state.documents.find(document => document.path === normalized || document.path.endsWith(`/${normalized}`) || document.path.endsWith(`/${name}.md`) || document.path.endsWith(`/${name}.base`)) || null;
}

function parseMarkdownFile(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!match) return { data: {}, body: raw };
  try { return { data: parseYaml(match[1]) || {}, body: raw.slice(match[0].length) }; }
  catch { return { data: {}, body: raw.slice(match[0].length) }; }
}

function extractWikiTargets(markdown, embedsOnly) {
  const result = [];
  for (const match of markdown.matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/gu)) {
    if (embedsOnly ? match[1] === "!" : match[1] !== "!") result.push(match[2].trim());
  }
  return result;
}

function extractTags(data, body) {
  const tags = new Set();
  const frontmatter = data.tags ?? data.tag;
  for (const tag of Array.isArray(frontmatter) ? frontmatter : frontmatter ? String(frontmatter).split(/[ ,]+/u) : []) tags.add(String(tag).startsWith("#") ? String(tag) : `#${tag}`);
  for (const match of body.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(`#${match[1]}`);
  return [...tags];
}

function selectHeading(markdown, heading) {
  const wanted = heading.trim().toLowerCase();
  const lines = markdown.split(/\r?\n/u);
  const start = lines.findIndex(line => /^#{1,6}\s+/u.test(line) && line.replace(/^#{1,6}\s+/u, "").trim().toLowerCase() === wanted);
  if (start < 0) return markdown;
  const level = lines[start].match(/^#+/u)[0].length;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const match = lines[index].match(/^(#+)\s+/u);
    if (match && match[1].length <= level) { end = index; break; }
  }
  return lines.slice(start, end).join("\n");
}

function sanitizeRenderedHtml(html) {
  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "details", "summary", "input", "mark", "section", "article", "button"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["id", "class", "data-base", "data-base-tab", "data-sortable", "hidden"],
      a: ["href", "name", "target", "rel", "class"],
      img: ["src", "alt", "title", "loading", "width", "height"],
      input: ["type", "checked", "disabled"],
      th: ["data-sortable"],
      td: ["colspan"],
      section: ["id", "class", "hidden"]
    },
    allowedSchemes: ["http", "https", "mailto", "data"],
    allowProtocolRelative: false
  });
}

function decodeFile(file) { return Buffer.from(file.content, "base64").toString("utf8"); }
function viewerUrl(vaultId, path, query) { return `/view/${encodeURIComponent(vaultId)}/${path.split("/").map(encodeURIComponent).join("/")}${query}`; }
function firstHeading(markdown) { return markdown.match(/^#\s+(.+)$/mu)?.[1]?.trim() || ""; }
function stringValue(value) { return typeof value === "string" ? value : ""; }
function slugify(value) { return String(value).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, "").replace(/\s+/gu, "-"); }
function stripMarkdown(value) { return String(value).replace(/```[\s\S]*?```/gu, " ").replace(/!?(?:\[([^\]]*)\]\([^)]*\)|\[\[([^\]]+)\]\])/gu, "$1$2").replace(/[#>*_`~|-]/gu, " ").replace(/\s+/gu, " ").trim(); }
function compareValues(a, b) { if (a == null && b == null) return 0; if (a == null) return 1; if (b == null) return -1; if (typeof a === "number" && typeof b === "number") return a - b; return String(a).localeCompare(String(b), "ru", { numeric: true }); }
function shortHash(value) { let hash = 2166136261; for (const char of value) hash = Math.imul(hash ^ char.codePointAt(0), 16777619); return (hash >>> 0).toString(36); }
function safeJson(value) { return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029"); }
function escapeHtml(value) { return String(value).replace(/[&<>"']/gu, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]); }
function plural(number, one, few, many) { const mod10 = number % 10; const mod100 = number % 100; return mod10 === 1 && mod100 !== 11 ? one : mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14) ? few : many; }

const viewerJs = `(()=>{
const root=document.documentElement,side=document.getElementById('sidebar'),scrim=document.getElementById('scrim');
const saved=localStorage.getItem('simple-sync-theme');if(saved)root.dataset.theme=saved;else if(matchMedia('(prefers-color-scheme:dark)').matches)root.dataset.theme='dark';
document.getElementById('theme').onclick=()=>{const next=root.dataset.theme==='dark'?'light':'dark';root.dataset.theme=next;localStorage.setItem('simple-sync-theme',next)};
const closeMenu=()=>{side.classList.remove('open');scrim.classList.remove('open')};document.getElementById('menu').onclick=()=>{side.classList.toggle('open');scrim.classList.toggle('open')};scrim.onclick=closeMenu;
document.querySelectorAll('.tree-folder').forEach(folder=>{const key='simple-sync-folder:'+folder.dataset.folder;const stored=localStorage.getItem(key);if(stored!==null)folder.open=stored==='1';folder.addEventListener('toggle',()=>localStorage.setItem(key,folder.open?'1':'0'))});
const input=document.getElementById('search'),tree=document.getElementById('tree'),results=document.getElementById('search-results'),index=window.__SIMPLE_SYNC_SEARCH__||[];
input.oninput=()=>{const query=input.value.trim().toLocaleLowerCase('ru');if(!query){tree.hidden=false;results.hidden=true;results.innerHTML='';return}const terms=query.split(/\\s+/).filter(Boolean);const found=index.map(item=>{let score=0;for(const term of terms){if(item.title.toLocaleLowerCase('ru').includes(term))score+=20;if(item.path.toLocaleLowerCase('ru').includes(term))score+=8;if(item.text.includes(term))score+=2}return{...item,score}}).filter(item=>item.score>=terms.length*2).sort((a,b)=>b.score-a.score||a.title.localeCompare(b.title,'ru')).slice(0,50);tree.hidden=true;results.hidden=false;results.innerHTML=found.length?found.map(item=>'<a href="'+item.url+'"><strong>'+escapeText(item.title)+'</strong><small>'+escapeText(item.path)+'</small></a>').join(''):'<p class="muted">Ничего не найдено</p>'};
function escapeText(value){const span=document.createElement('span');span.textContent=value;return span.innerHTML}
document.querySelectorAll('.base-tab').forEach(button=>button.onclick=()=>{const base=button.closest('.obsidian-base');base.querySelectorAll('.base-tab').forEach(item=>item.classList.toggle('active',item===button));base.querySelectorAll('.base-panel').forEach(panel=>panel.hidden=panel.id!==button.dataset.baseTab)});
document.querySelectorAll('.base-table th[data-sortable]').forEach((header,column)=>header.onclick=()=>{const table=header.closest('table'),body=table.tBodies[0],rows=[...body.rows],direction=header.dataset.direction==='asc'?'desc':'asc';table.querySelectorAll('th').forEach(item=>delete item.dataset.direction);header.dataset.direction=direction;rows.sort((a,b)=>{const left=a.cells[column]?.innerText.trim()||'',right=b.cells[column]?.innerText.trim()||'',ln=Number(left),rn=Number(right),comp=Number.isFinite(ln)&&Number.isFinite(rn)?ln-rn:left.localeCompare(right,'ru',{numeric:true});return direction==='asc'?comp:-comp});rows.forEach(row=>body.append(row))});
const toc=document.getElementById('toc'),headings=[...document.querySelectorAll('.markdown-body h2,.markdown-body h3')];toc.innerHTML=headings.map(heading=>'<a class="toc-'+heading.tagName.toLowerCase()+'" href="#'+heading.id+'">'+escapeText(heading.textContent)+'</a>').join('')||'<span class="muted">Нет заголовков</span>';
})();`;

const viewerCss = `:root{--bg:#fff;--side:#f6f6f6;--text:#2e3338;--muted:#7a7f87;--line:#e4e4e7;--accent:#7c3aed;--accent-soft:#ede9fe;--code:#f3f4f6;--hover:#e9e9ec;--shadow:0 12px 36px #0002}html[data-theme=dark]{--bg:#1e1e1e;--side:#181818;--text:#dcddde;--muted:#9a9a9a;--line:#343434;--accent:#a88bfa;--accent-soft:#302a45;--code:#262626;--hover:#2b2b2b;--shadow:0 12px 36px #0008}*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.topbar{height:48px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid var(--line);position:fixed;inset:0 0 auto;z-index:20;background:color-mix(in srgb,var(--bg) 94%,transparent);backdrop-filter:blur(12px)}.brand{font-weight:650;color:var(--text);text-decoration:none;flex:1}.icon-button{width:34px;height:34px;border:0;border-radius:7px;background:transparent;color:var(--muted);font-size:20px;cursor:pointer}.icon-button:hover{background:var(--hover);color:var(--text)}.workspace{display:grid;grid-template-columns:280px minmax(0,1fr) 220px;min-height:100vh;padding-top:48px}.sidebar,.right-sidebar{position:fixed;top:48px;bottom:0;overflow:auto;background:var(--side);padding:14px}.sidebar{left:0;width:280px;border-right:1px solid var(--line)}.right-sidebar{right:0;width:220px;border-left:1px solid var(--line);background:var(--bg)}.sidebar-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:2px 6px 10px}.search-box{display:flex;align-items:center;gap:7px;border:1px solid var(--line);background:var(--bg);border-radius:7px;padding:6px 9px;margin-bottom:12px}.search-box:focus-within{border-color:var(--accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--accent) 18%,transparent)}.search-box input{min-width:0;width:100%;border:0;outline:0;background:transparent;color:var(--text);font:inherit}.file-tree{font-size:14px}.tree-folder>summary{list-style:none;display:flex;align-items:center;gap:6px;height:30px;padding:0 6px;border-radius:5px;cursor:pointer;white-space:nowrap;overflow:hidden}.tree-folder>summary::-webkit-details-marker{display:none}.tree-folder>summary:hover,.tree-file:hover{background:var(--hover)}.chevron{font-size:19px;line-height:1;transition:.15s}.tree-folder[open]>summary .chevron{transform:rotate(90deg)}.folder-icon,.file-icon{color:var(--muted);width:17px;text-align:center}.tree-children{padding-left:14px;border-left:1px solid var(--line);margin-left:12px}.tree-file{display:flex;align-items:center;gap:6px;min-width:0;height:30px;padding:0 6px;border-radius:5px;color:var(--text);text-decoration:none}.tree-file span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tree-file.active{background:var(--accent-soft);color:var(--accent)}.search-results a{display:block;color:var(--text);text-decoration:none;padding:8px;border-radius:6px}.search-results a:hover{background:var(--hover)}.search-results strong,.search-results small{display:block}.search-results small{color:var(--muted);overflow:hidden;text-overflow:ellipsis}.updated,.muted{font-size:12px;color:var(--muted);margin:18px 6px}.main-pane{grid-column:2;padding:24px clamp(24px,5vw,72px) 80px;min-width:0}.breadcrumbs{display:flex;align-items:center;gap:7px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin:0 auto 22px;max-width:850px}.breadcrumbs a{color:inherit;text-decoration:none}.breadcrumb-separator{opacity:.55}.markdown-body{max-width:850px;margin:0 auto;font-size:16px}.markdown-body h1,.markdown-body h2,.markdown-body h3,.markdown-body h4{line-height:1.25;margin:1.5em 0 .55em;scroll-margin-top:64px}.markdown-body h1{font-size:2.15em;margin-top:.3em}.markdown-body h2{font-size:1.55em;border-bottom:1px solid var(--line);padding-bottom:.25em}.markdown-body a,.internal-link{color:var(--accent);text-decoration:none}.markdown-body a:hover{text-decoration:underline}.markdown-body img,.markdown-body video{max-width:100%;border-radius:6px}.markdown-body pre{overflow:auto;padding:14px;border-radius:7px;background:var(--code)}.markdown-body code{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;background:var(--code);padding:.12em .3em;border-radius:4px}.markdown-body pre code{padding:0}.markdown-body blockquote{margin-left:0;padding:2px 0 2px 16px;border-left:3px solid var(--accent);color:var(--muted)}.markdown-body>table{border-collapse:collapse;display:block;overflow:auto}.markdown-body th,.markdown-body td{border:1px solid var(--line);padding:7px 10px}.properties{border:1px solid var(--line);border-radius:7px;padding:8px 12px;margin-bottom:22px}.properties summary{cursor:pointer;color:var(--muted)}.properties dl{display:grid;grid-template-columns:minmax(100px,180px) 1fr;gap:6px 12px;margin:10px 0 2px}.properties dt{color:var(--muted)}.properties dd{margin:0}.property-chip{display:inline-block;background:var(--accent-soft);color:var(--accent);border-radius:999px;padding:1px 7px;font-size:.86em}.embed{border:1px solid var(--line);border-radius:7px;padding:16px;margin:18px 0}.embed-title{font-size:13px;margin-bottom:10px}.missing-link{color:#e05252}.notice{padding:12px 14px;border-radius:7px;background:var(--code);border-left:3px solid var(--accent)}.notice.error{border-color:#e05252}.obsidian-base{border:1px solid var(--line);border-radius:7px;margin:16px 0;overflow:hidden;background:var(--bg)}.base-toolbar{height:42px;display:flex;align-items:center;gap:12px;border-bottom:1px solid var(--line);padding:0 10px}.base-tabs{display:flex;gap:4px;min-width:0;overflow:auto}.base-tab{border:0;background:transparent;color:var(--muted);font:inherit;padding:6px 9px;border-radius:5px;cursor:pointer;white-space:nowrap}.base-tab:hover{background:var(--hover)}.base-tab.active{background:var(--accent-soft);color:var(--accent)}.base-count{margin-left:auto;color:var(--muted);font-size:12px;white-space:nowrap}.base-panel[hidden]{display:none}.base-table-wrap{overflow:auto}.base-table{width:100%;border-collapse:collapse;font-size:14px}.base-table th,.base-table td{height:34px;padding:5px 10px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}.base-table th{font-weight:500;color:var(--muted);cursor:pointer;position:sticky;top:0;background:var(--bg)}.base-group td{background:var(--side);font-weight:600;color:var(--text)}.base-group td span{color:var(--muted);font-weight:400;margin-left:4px}.sort-indicator{float:right;opacity:.45}.base-table tfoot td{border-bottom:0}.summary{color:var(--muted);font-size:12px}.base-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:12px;padding:12px}.base-card{border:1px solid var(--line);border-radius:7px;padding:12px}.base-card h3{margin:0 0 10px;font-size:16px}.card-property{display:grid;grid-template-columns:1fr 1.3fr;gap:8px;font-size:13px;margin-top:5px}.card-property>span:first-child{color:var(--muted)}.base-list{margin:14px 28px}.base-board{display:flex;gap:12px;padding:12px;overflow:auto}.board-column{min-width:220px;background:var(--side);border-radius:7px;padding:10px}.board-column h3{font-size:14px;margin:0 0 9px}.board-column h3 span{color:var(--muted);font-weight:400}.board-card{display:block;background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:9px;margin:7px 0;color:var(--text);text-decoration:none}.toc a{display:block;color:var(--muted);text-decoration:none;padding:3px 0;font-size:13px}.toc a:hover{color:var(--accent)}.toc-h3{padding-left:12px!important}.backlinks{max-width:850px;margin:56px auto 0;border-top:1px solid var(--line)}.backlinks h2{font-size:18px}.backlinks a{display:block;color:var(--accent);padding:3px 0}.scrim{display:none}.mobile-only{display:none}@media(max-width:1100px){.workspace{grid-template-columns:280px minmax(0,1fr)}.right-sidebar{display:none}.main-pane{grid-column:2}}@media(max-width:760px){.mobile-only{display:block}.workspace{display:block}.sidebar{transform:translateX(-105%);transition:transform .18s;z-index:30;box-shadow:var(--shadow)}.sidebar.open{transform:none}.scrim{position:fixed;inset:48px 0 0;background:#0007;z-index:25}.scrim.open{display:block}.main-pane{padding:20px 16px 60px}.markdown-body{font-size:15px}.markdown-body h1{font-size:1.8em}.base-embed,.obsidian-base{margin-left:-8px;margin-right:-8px}.base-toolbar{height:auto;min-height:42px;align-items:flex-start;padding:7px}.base-count{padding-top:7px}.properties dl{grid-template-columns:1fr}.properties dt{margin-top:5px}}`;
