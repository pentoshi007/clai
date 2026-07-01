/**
 * HTML-to-readable-text conversion and a permissive `Set-Cookie` parser,
 * shared by `web.fetch` (via `capture.ts`) and DuckDuckGo's lite-HTML adapter.
 *
 * - {@link toReadableText} strips chrome/non-rendering content from HTML and
 *   returns visible prose with whitespace collapsed (cheerio-based, no
 *   browser/jsdom dependency).
 * - {@link parseSetCookie} parses one `Set-Cookie` value into a
 *   {@link CookieInfo}; regex-driven and permissive — malformed or missing
 *   attributes are simply absent rather than a hard error.
 */

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";

import type { CookieInfo, CookieSameSite } from "./types.js";

// ---------------------------------------------------------------------------
// HTML → readable text
// ---------------------------------------------------------------------------

/**
 * Selectors for elements whose text content should never appear in the
 * readable view. `script`/`style`/`noscript` carry executable or styling
 * payloads (Requirement 2.4); `nav`/`header`/`footer`/`aside` are the
 * obvious chrome regions called out in the design's
 * "HTML-to-readable-text strategy".
 */
const STRIPPED_SELECTORS = [
  "script",
  "style",
  "noscript",
  "nav",
  "header",
  "footer",
  "aside",
].join(", ");

/**
 * Convert an HTML document into a single readable text string.
 *
 * The conversion:
 * 1. Parses `html` with cheerio (no DOM/browser dependency).
 * 2. Removes `<script>`, `<style>`, `<noscript>`, `<nav>`, `<header>`,
 *    `<footer>`, and `<aside>` subtrees outright.
 * 3. Removes every HTML comment node anywhere in the tree.
 * 4. Extracts the remaining text via `$.root().text()`.
 * 5. Collapses every run of ASCII/Unicode whitespace (including newlines,
 *    tabs, NBSPs) into a single space and trims the result so the agent
 *    receives compact prose.
 * 6. Appends a deduplicated "Links" section so the agent can find the
 *    correct URL for any link on the page without guessing.
 *
 * @param html     - Raw HTML string to convert.
 * @param baseUrl  - The final page URL (used to resolve relative hrefs).
 *                   When provided, all href values are resolved to absolute
 *                   URLs. When omitted, relative hrefs are included as-is.
 */
export function toReadableText(html: string, baseUrl?: string): string {
  if (typeof html !== "string" || html.length === 0) return "";

  const $ = cheerio.load(html);

  $(STRIPPED_SELECTORS).remove();
  $("[aria-hidden='true'], [hidden], template, svg, canvas").remove();

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

  // Collect all links on the page and append a deduplicated Links section.
  // This is the canonical source of URLs — the agent must use these rather
  // than constructing or guessing paths.
  const linkSection = collectLinks($, baseUrl);
  if (linkSection.length > 0) {
    out.push("");
    out.push("## Links");
    out.push(...linkSection);
  }

  return normalizeReadableLines(out);
}

/**
 * Collapse every contiguous run of whitespace characters into a single
 * ASCII space and trim leading/trailing whitespace.
 *
 * Treated as whitespace: the standard `\s` set (space, tab, CR, LF, FF,
 * VT) plus the most common non-breaking and zero-width characters that
 * show up in real-world web HTML — `\u00a0` (NBSP), `\u200b` (zero-width
 * space), `\u200c`/`\u200d` (zero-width joiner/non-joiner), `\ufeff`
 * (BOM/zero-width no-break space), and the assorted `\u2000-\u200a` set
 * of Unicode spaces.
 */
function collapseWhitespace(text: string): string {
  return text
    .replace(/[\s\u00a0\u2000-\u200a\u200b\u200c\u200d\u2028\u2029\ufeff]+/g, " ")
    .trim();
}

/**
 * Resolve an href (possibly relative) against a base URL string.
 * Returns the absolute URL string, or the original href if resolution fails.
 */
function resolveHref(href: string, baseUrl: string | undefined): string {
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

/**
 * Collect all unique, non-anchor-only `<a href>` links from the page and
 * return them as `[text](url)` markdown lines for the Links section.
 * Deduplicates by URL. Fragment-only (#section) links are skipped.
 * Limits to 80 links to avoid flooding the model context.
 */
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
    // Skip javascript: and mailto: etc.
    if (/^(javascript|mailto|tel):/i.test(resolved)) return;
    if (seen.has(resolved)) return;
    seen.add(resolved);
    const text = collapseWhitespace($(el).text()) || resolved;
    links.push(`- [${text}](${resolved})`);
    if (links.length >= 80) return false; // cheerio each — returning false stops iteration
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
    const text = wrapped.text().replace(/\n{3,}/g, "\n\n").trim();
    return text ? ["```", text, "```"] : [];
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
  for (const line of lines) {
    const text = collapseWhitespace(line);
    if (!text) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      continue;
    }
    if (out[out.length - 1] !== text) out.push(text);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------
// Set-Cookie parser
// ---------------------------------------------------------------------------

/**
 * Allowed values for `SameSite`, lower-cased for case-insensitive lookup.
 * The map preserves the canonical capitalisation used in the
 * {@link CookieInfo.sameSite} field.
 */
const SAME_SITE_VALUES: ReadonlyMap<string, CookieSameSite> = new Map([
  ["strict", "Strict"],
  ["lax", "Lax"],
  ["none", "None"],
]);

/**
 * Parse a single `Set-Cookie` header value into a {@link CookieInfo}.
 *
 * The parser is intentionally permissive: it never throws for malformed
 * input. The first `;`-separated attribute is treated as the
 * `name=value` pair (with everything after the first `=` taken verbatim
 * as the value, matching common server practice). Subsequent attributes
 * are matched case-insensitively against the public RFC 6265 set the
 * `web.fetch` tool surfaces:
 *
 * - `Domain`        → {@link CookieInfo.domain}
 * - `Path`          → {@link CookieInfo.path}
 * - `Expires`       → {@link CookieInfo.expires} as an ISO 8601 string
 *                     (omitted if the date string fails to parse)
 * - `Max-Age`       → {@link CookieInfo.maxAge} as a finite integer
 *                     (omitted if not a finite integer)
 * - `HttpOnly`      → {@link CookieInfo.httpOnly} = `true`
 * - `Secure`        → {@link CookieInfo.secure}   = `true`
 * - `SameSite=…`    → {@link CookieInfo.sameSite} normalized to
 *                     `"Strict"`/`"Lax"`/`"None"` (omitted if value is
 *                     unknown)
 *
 * Unknown attributes (e.g. `Priority`, `Partitioned`) are ignored. When
 * an attribute is missing, malformed, or unrecognised, the corresponding
 * field is simply absent from the returned object.
 *
 * The header value is expected to be a single cookie. Callers that
 * receive multiple cookies in a single header (which servers must not
 * do, but a few do) should split on the appropriate boundary before
 * calling this function.
 */
export function parseSetCookie(value: string): CookieInfo {
  if (typeof value !== "string") {
    return { name: "", value: "" };
  }

  // Split on `;` to peel attributes off the name=value pair. We do not
  // split on `,` because RFC 6265 §4.1 forbids commas in cookie values
  // unrelated to date attributes, and Node/undici always hand us one
  // header value per Set-Cookie line.
  const parts = value.split(";");
  const head = (parts[0] ?? "").trim();

  const eqIdx = head.indexOf("=");
  let name: string;
  let cookieValue: string;
  if (eqIdx === -1) {
    // No `=` at all: treat the whole token as the name, value empty.
    name = head;
    cookieValue = "";
  } else {
    name = head.slice(0, eqIdx).trim();
    // Per RFC 6265 the value runs to end-of-attribute; trim outer
    // whitespace but keep internal characters verbatim.
    cookieValue = head.slice(eqIdx + 1).trim();
  }

  // Build the result one field at a time so `exactOptionalPropertyTypes`
  // sees an absent key for any attribute we did not observe.
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
        // Ignore unknown attributes (Priority, Partitioned, etc.).
        break;
    }
  }

  return result;
}

/**
 * Parse an HTTP-date string (RFC 7231 §7.1.1.1, including the legacy
 * RFC 850 and asctime forms) into an ISO 8601 timestamp. Returns
 * `undefined` when the value does not parse to a finite, valid date.
 */
function parseHttpDate(value: string): string | undefined {
  if (value.length === 0) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return undefined;
  return new Date(ms).toISOString();
}

/**
 * Parse a `Max-Age` attribute value into a finite integer. Returns
 * `undefined` for empty input, non-numeric input, fractional values, or
 * values outside the safe-integer range.
 */
function parseMaxAge(value: string): number | undefined {
  if (value.length === 0) return undefined;
  // RFC 6265 §5.2.2 specifies the value as DIGIT *DIGIT (optionally
  // preceded by `-` for delete-now semantics). Reject anything that
  // does not match that shape.
  if (!/^-?\d+$/.test(value)) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return undefined;
  if (!Number.isSafeInteger(n)) return undefined;
  return n;
}
