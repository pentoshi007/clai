
import * as cheerio from "cheerio/slim";
import type { AnyNode } from "domhandler";

import type { CookieInfo, CookieSameSite } from "./types.js";


const STRIPPED_SELECTORS = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
].join(", ");

const CHROME_SELECTORS = [
  "nav",
  "[role='navigation']",
  "body > header",
  "body > footer",
  "body > aside",
].join(", ");

export function toReadableText(html: string, baseUrl?: string): string {
  if (typeof html !== "string" || html.length === 0) return "";

  const $ = cheerio.load(html);

  $(STRIPPED_SELECTORS).remove();
  $(CHROME_SELECTORS).remove();
  $("[aria-hidden='true'], [hidden]").remove();

  $('*')
    .contents()
    .filter(function (this: { type?: string }) {
      return this.type === "comment";
    })
    .remove();

  const title = collapseWhitespace($("title").first().text());
  const description = collapseWhitespace(
    $("meta[name='description']").attr("content") ?? "",
  );
  const root = bestContentRoot($);
  const lines = renderChildren($, root, baseUrl);
  const out: string[] = [];
  if (title) out.push(`# ${title}`);
  if (description && description !== title) out.push(`Summary: ${description}`);
  out.push(...lines);

  const linkSection = collectLinks($, baseUrl);
  if (linkSection.length > 0) {
    out.push("");
    out.push("## Links");
    out.push(...linkSection);
  }

  return normalizeReadableLines(out);
}

function collapseWhitespace(text: string): string {
  return text
    .replace(/[\s\u00a0\u2000-\u200a\u200b\u200c\u200d\u2028\u2029\ufeff]+/g, " ")
    .trim();
}

function resolveHref(href: string, baseUrl: string | undefined): string {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function collectLinks(
  $: cheerio.CheerioAPI,
  baseUrl: string | undefined,
): string[] {
  const seen = new Set<string>();
  const links: string[] = [];

  $("a[href]").each((_, el) => {
    const rawHref = collapseWhitespace($(el).attr("href") ?? "");
    if (!rawHref || rawHref.startsWith("#")) return;
    const resolved = resolveHref(rawHref, baseUrl);
    if (/^(javascript|mailto|tel):/i.test(resolved)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const text = collapseWhitespace($(el).text()) || resolved;
    links.push(`- [${text}](${resolved})`);
    if (links.length >= 80) return false;
  });

  return links;
}

function bestContentRoot($: cheerio.CheerioAPI): cheerio.Cheerio<AnyNode> {
  const candidates = [
    "main",
    "article",
    "[role='main']",
    "#content",
    "#main",
    ".content",
    ".main",
    "body",
  ];
  let best: cheerio.Cheerio<AnyNode> = $("body").first();
  let bestScore = collapseWhitespace(best.text()).length;
  for (const selector of candidates) {
    $(selector).each((_, el) => {
      const node = $(el);
      const score = collapseWhitespace(node.text()).length;
      if (score > bestScore || (score > 200 && selector !== "body")) {
        best = node;
        bestScore = score;
      }
    });
    if (selector !== "body" && bestScore > 200 && best.is(selector)) break;
  }
  return best.length ? best : $.root();
}

function renderChildren(
  $: cheerio.CheerioAPI,
  node: cheerio.Cheerio<AnyNode>,
  baseUrl?: string,
): string[] {
  const lines: string[] = [];
  node.contents().each((_, child) => {
    lines.push(...renderNode($, child, baseUrl));
  });
  return lines;
}

function renderNode($: cheerio.CheerioAPI, node: AnyNode, baseUrl?: string): string[] {
  const wrapped = $(node);
  const raw = wrapped.get(0) as { type?: string; tagName?: string; name?: string } | undefined;
  if (!raw) return [];
  if (raw.type === "text") {
    const text = collapseWhitespace(wrapped.text());
    return text ? [text] : [];
  }
  if (raw.type !== "tag") return [];

  const tag = (raw.tagName ?? raw.name ?? "").toLowerCase();
  if (!tag || STRIPPED_SELECTORS.split(", ").includes(tag)) return [];

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag[1]), 6);
    const text = inlineText($, wrapped, baseUrl);
    return text ? [`${"#".repeat(level)} ${text}`] : [];
  }

  if (tag === "p" || tag === "blockquote") {
    const text = inlineText($, wrapped, baseUrl);
    if (!text) return [];
    return [tag === "blockquote" ? `> ${text}` : text];
  }

  if (tag === "br") return [""];

  if (tag === "pre") {
    const text = wrapped.text().replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
    return text ? ["```", ...text.split("\n"), "```"] : [];
  }

  if (tag === "code") {
    const text = collapseWhitespace(wrapped.text());
    return text ? [`\`${text}\``] : [];
  }

  if (tag === "ul" || tag === "ol") {
    const ordered = tag === "ol";
    const items: string[] = [];
    wrapped.children("li").each((index, li) => {
      const text = inlineText($, $(li), baseUrl);
      if (text) items.push(`${ordered ? `${index + 1}.` : "-"} ${text}`);
    });
    return items;
  }

  if (tag === "table") return renderTable($, wrapped, baseUrl);

  if (tag === "img") {
    const alt = collapseWhitespace(wrapped.attr("alt") ?? "");
    const src = collapseWhitespace(wrapped.attr("src") ?? "");
    if (!alt && !src) return [];
    return [`Image: ${alt || src}${alt && src ? ` (${src})` : ""}`];
  }

  if (tag === "form") return renderForm($, wrapped);

  if (tag === "a") {
    const text = inlineText($, wrapped, baseUrl);
    return text ? [text] : [];
  }

  return renderChildren($, wrapped, baseUrl);
}

function inlineText($: cheerio.CheerioAPI, node: cheerio.Cheerio<AnyNode>, baseUrl?: string): string {
  const clone = node.clone();
  clone.find("script, style, noscript, svg, canvas").remove();
  clone.find("a[href]").each((_, el) => {
    const link = $(el);
    const text = collapseWhitespace(link.text());
    const rawHref = collapseWhitespace(link.attr("href") ?? "");
    if (rawHref && !rawHref.startsWith("#")) {
      const href = resolveHref(rawHref, baseUrl);
      if (text) link.text(`${text} (${href})`);
    }
  });
  clone.find("img").each((_, el) => {
    const img = $(el);
    const alt = collapseWhitespace(img.attr("alt") ?? "");
    img.replaceWith(alt ? ` Image: ${alt} ` : " ");
  });
  return collapseWhitespace(clone.text());
}

function renderTable(
  $: cheerio.CheerioAPI,
  table: cheerio.Cheerio<AnyNode>,
  baseUrl?: string,
): string[] {
  const rows: string[][] = [];
  table.find("tr").each((_, tr) => {
    const cells: string[] = [];
    $(tr).children("th,td").each((__, cell) => {
      cells.push(inlineText($, $(cell), baseUrl));
    });
    if (cells.some(Boolean)) rows.push(cells);
  });
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => row.length));
  const normalized = rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ""));
  const header = normalized[0]!;
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ];
}

function renderForm(
  $: cheerio.CheerioAPI,
  form: cheerio.Cheerio<AnyNode>,
): string[] {
  const fields: string[] = [];
  form.find("input, textarea, select, button").each((_, el) => {
    const field = $(el);
    const tag = (field.get(0) as { tagName?: string }).tagName?.toLowerCase() ?? "field";
    const label = collapseWhitespace(
      field.attr("aria-label") ??
        field.attr("placeholder") ??
        field.attr("name") ??
        field.text() ??
        "",
    );
    fields.push(`${tag}${label ? `: ${label}` : ""}`);
  });
  return fields.length ? [`Form fields: ${fields.join("; ")}`] : [];
}

function normalizeReadableLines(lines: string[]): string {
  const out: string[] = [];
  let inCodeBlock = false;
  for (const line of lines) {
    if (line === "```") {
      if (out[out.length - 1] === "" && !inCodeBlock) out.pop();
      out.push(line);
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) {
      out.push(line.replace(/\r/g, "").replace(/[ \t]+$/g, ""));
      continue;
    }
    const text = collapseWhitespace(line);
    if (!text) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (out[out.length - 1] !== text) out.push(text);
  }
  return out.join("\n").trim();
}


const SAME_SITE_VALUES: ReadonlyMap<string, CookieSameSite> = new Map([
  ["strict", "Strict"],
  ["lax", "Lax"],
  ["none", "None"],
]);

export function parseSetCookie(value: string): CookieInfo {
  if (typeof value !== "string") {
    return { name: "", value: "" };
  }

  const parts = value.split(";");
  const head = (parts[0] ?? "").trim();

  const eqIdx = head.indexOf("=");
  let name: string;
  let cookieValue: string;
  if (eqIdx === -1) {
    name = head;
    cookieValue = "";
  } else {
    name = head.slice(0, eqIdx).trim();
    cookieValue = head.slice(eqIdx + 1).trim();
  }

  const result: CookieInfo = { name, value: cookieValue };

  for (let i = 1; i < parts.length; i++) {
    const attr = parts[i];
    if (typeof attr !== "string") continue;
    const trimmed = attr.trim();
    if (trimmed.length === 0) continue;

    const attrEq = trimmed.indexOf("=");
    const attrName =
      attrEq === -1 ? trimmed : trimmed.slice(0, attrEq).trim();
    const attrValue = attrEq === -1 ? "" : trimmed.slice(attrEq + 1).trim();
    const lowerName = attrName.toLowerCase();

    switch (lowerName) {
      case "domain": {
        if (attrValue.length > 0) result.domain = attrValue;
        break;
      }
      case "path": {
        if (attrValue.length > 0) result.path = attrValue;
        break;
      }
      case "expires": {
        const iso = parseHttpDate(attrValue);
        if (iso !== undefined) result.expires = iso;
        break;
      }
      case "max-age": {
        const n = parseMaxAge(attrValue);
        if (n !== undefined) result.maxAge = n;
        break;
      }
      case "httponly": {
        result.httpOnly = true;
        break;
      }
      case "secure": {
        result.secure = true;
        break;
      }
      case "samesite": {
        const canonical = SAME_SITE_VALUES.get(attrValue.toLowerCase());
        if (canonical !== undefined) result.sameSite = canonical;
        break;
      }
      default:
        break;
    }
  }

  return result;
}

function parseHttpDate(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

function parseMaxAge(value: string): number | undefined {
  if (value.length === 0) return undefined;
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}
