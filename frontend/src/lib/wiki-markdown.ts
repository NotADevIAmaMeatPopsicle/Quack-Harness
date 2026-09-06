import type { WikiLinkRef } from "../api/contracts";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/`/g, "&#96;");
}

function preserveCodeBlocks(markdown: string): {
  text: string;
  restore: (input: string) => string;
} {
  const blocks: string[] = [];
  const text = markdown.replace(
    /```([\w-]*)\r?\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      const html = `<pre class="wiki-code"><code${lang ? ` data-lang="${escapeAttribute(lang)}"` : ""}>${escapeHtml(code)}</code></pre>`;
      const token = `@@WIKI_CODE_${blocks.length}@@`;
      blocks.push(html);
      return token;
    },
  );

  return {
    text,
    restore: (input: string) =>
      input.replace(/@@WIKI_CODE_(\d+)@@/g, (_token, index: string) => blocks[Number(index)] ?? ""),
  };
}

function preserveTables(markdown: string): { text: string; restore: (input: string) => string } {
  const tables: string[] = [];
  const lines = markdown.split(/\r?\n/);
  const out: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const current = lines[index] ?? "";
    const next = lines[index + 1] ?? "";
    if (!current.trim().startsWith("|") || !next.trim().startsWith("|")) {
      out.push(current);
      continue;
    }

    const chunk = [current];
    let cursor = index + 1;
    while (cursor < lines.length && (lines[cursor] ?? "").trim().startsWith("|")) {
      chunk.push(lines[cursor] ?? "");
      cursor += 1;
    }

    const rows = chunk
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) =>
        line
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((cell) => cell.trim()),
      );
    const separator = rows.findIndex((row) => row.every((cell) => /^:?-+:?$/.test(cell)));
    if (separator <= 0) {
      out.push(...chunk);
      index = cursor - 1;
      continue;
    }

    const header = rows[0] ?? [];
    const body = rows.slice(separator + 1);
    const html = [
      '<table class="wiki-table">',
      "<thead><tr>",
      ...header.map((cell) => `<th>${escapeHtml(cell)}</th>`),
      "</tr></thead>",
      "<tbody>",
      ...body.map(
        (row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`,
      ),
      "</tbody>",
      "</table>",
    ].join("");

    const token = `@@WIKI_TABLE_${tables.length}@@`;
    tables.push(html);
    out.push(token);
    index = cursor - 1;
  }

  return {
    text: out.join("\n"),
    restore: (input: string) =>
      input.replace(
        /@@WIKI_TABLE_(\d+)@@/g,
        (_token, index: string) => tables[Number(index)] ?? "",
      ),
  };
}

function replaceWikiLinks(markdown: string, links: WikiLinkRef[]): string {
  const byRaw = new Map(links.map((link) => [link.raw, link]));
  return markdown.replace(
    /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g,
    (raw: string, target: string, label?: string) => {
      const match = byRaw.get(raw);
      const text = escapeHtml((label ?? target).trim());
      if (!match?.resolvedPath) {
        return `<span class="wiki-link-dead">${text}</span>`;
      }
      return `<a href="/wiki?path=${encodeURIComponent(match.resolvedPath)}" data-wiki-path="${escapeAttribute(match.resolvedPath)}">${text}</a>`;
    },
  );
}

function wrapListBlocks(html: string): string {
  const lines = html.split("\n");
  const out: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!/^\s*[-*] /.test(line) && !/^\s*\d+\. /.test(line)) {
      out.push(line);
      index += 1;
      continue;
    }

    const ordered = /^\s*\d+\. /.test(line);
    const items: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (ordered && /^\s*\d+\. /.test(current)) {
        items.push(current.replace(/^\s*\d+\. /, ""));
        index += 1;
        continue;
      }
      if (!ordered && /^\s*[-*] /.test(current)) {
        items.push(current.replace(/^\s*[-*] /, ""));
        index += 1;
        continue;
      }
      break;
    }

    out.push(
      `<${ordered ? "ol" : "ul"}>${items.map((item) => `<li>${item}</li>`).join("")}</${ordered ? "ol" : "ul"}>`,
    );
  }

  return out.join("\n");
}

export function renderWikiHtml(markdown: string, links: WikiLinkRef[]): string {
  const codeBlocks = preserveCodeBlocks(markdown);
  const tables = preserveTables(codeBlocks.text);

  let html = escapeHtml(tables.text);
  html = replaceWikiLinks(html, links);

  html = html.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  html = html.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  html = html.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, href: string) => {
    const candidate = href.trim();
    const safeHref = /^(?:https?:\/\/|mailto:|\/[^/]|\.\.?\/|#)/i.test(candidate)
      ? escapeAttribute(candidate)
      : "#";
    return `<a href="${safeHref}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  });

  html = wrapListBlocks(html);
  html = html.replace(/\n{2,}/g, "</p><p>");
  html = html.replace(/\n/g, "<br>");
  html = tables.restore(codeBlocks.restore(html));

  return `<p>${html}</p>`
    .replace(
      /<p>(<(?:h1|h2|h3|pre|table|ul|ol)[\s\S]*?<\/(?:h1|h2|h3|pre|table|ul|ol)>)<\/p>/g,
      "$1",
    )
    .replace(/<p><\/p>/g, "");
}
