/**
 * Bidirectional conversion between Confluence Storage Format (XHTML) and Markdown.
 *
 * XHTML -> Markdown  uses `turndown`  (for sending to the LLM)
 * Markdown -> XHTML  uses `markdown-it` + post-processing (for writing back to Confluence)
 */

import TurndownService from 'turndown';
import MarkdownIt from 'markdown-it';
import * as core from '@actions/core';

//XHTML -> Markdown

const td = new TurndownService({
  headingStyle: 'atx',
  hr: '---',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  fence: '```',
});

//Preserve Confluence structured macros as code blocks so the LLM can reason about them
td.addRule('confluence-macro', {
  filter: (node) =>
    node.nodeName === 'AC:STRUCTURED-MACRO' ||
    node.nodeName === 'AC:RICH-TEXT-BODY',
  replacement: (content, node) => {
    const macroNode = node as { getAttribute?: (name: string) => string | null };
    const name = macroNode.getAttribute?.('ac:name') ?? 'macro';
    return `\n\n<!-- confluence-macro:${name} -->\n${content}\n\n`;
  },
});

export function xhtmlToMarkdown(xhtml: string): string {
  return td.turndown(xhtml);
}

//Markdown -> XHTML

const md = new MarkdownIt({
  html: false,
  xhtmlOut: true,
  breaks: false,
  linkify: true,
  typographer: false,
});

/**
 * Convert Markdown to Atlassian Confluence Storage Format (XHTML).
 *
 * markdown-it produces XHTML which is already valid Confluence storage format
 * for most constructs. We post-process a few edge cases.
 */
export function markdownToXhtml(markdown: string): string {
  let html = md.render(markdown);

  //markdown-it wraps code blocks in <pre><code class="language-xxx">
  //Confluence prefers <ac:structured-macro ac:name="code">
  html = convertCodeBlocks(html);

  //Wrap inline <code> in <code> (already correct for Confluence)
  //Ensure self-closing tags are XHTML-compliant
  html = html.replace(/<br>/g, '<br />').replace(/<hr>/g, '<hr />');

  return html;
}

function convertCodeBlocks(html: string): string {
  return html.replace(
    /<pre><code(?:\s+class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g,
    (_match, lang: string | undefined, code: string) => {
      const language = lang ?? 'none';
      //Unescape HTML entities inside the code body
      const decoded = code
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

      return (
        `<ac:structured-macro ac:name="code">` +
        `<ac:parameter ac:name="language">${language}</ac:parameter>` +
        `<ac:plain-text-body><![CDATA[${decoded}]]></ac:plain-text-body>` +
        `</ac:structured-macro>`
      );
    }
  );
}

//Patch helpers

/**
 * Apply a proposed change to an existing XHTML storage body.
 * Finds the section by heading, replaces the content, and returns the updated XHTML.
 *
 * For "append" / "prepend" changes the heading is used as an anchor point.
 * For "delete_section" the section content is removed.
 */
export function applyChange(
  storageBody: string,
  type: string,
  heading: string,
  beforeExcerpt: string,
  afterMarkdown: string
): string {
  const afterXhtml = markdownToXhtml(afterMarkdown);

  switch (type) {
    case 'update':
      return updateSection(storageBody, heading, beforeExcerpt, afterXhtml);
    case 'append':
      return appendAfterHeading(storageBody, heading, afterXhtml);
    case 'prepend':
      return prependBeforeHeading(storageBody, heading, afterXhtml);
    case 'delete_section':
      return deleteSection(storageBody, heading, beforeExcerpt);
    default:
      //Unknown type, fall back to update behaviour
      return updateSection(storageBody, heading, beforeExcerpt, afterXhtml);
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateSection(
  body: string,
  heading: string,
  beforeExcerpt: string,
  afterXhtml: string
): string {
  if (!beforeExcerpt.trim()) {
    return appendAfterHeading(body, heading, afterXhtml);
  }

  const excerpt = beforeExcerpt.trim();
  const targetRange = findSectionRange(body, heading) ?? { start: 0, end: body.length };
  const section = body.slice(targetRange.start, targetRange.end);

  //Attempt exact match in the target section first.
  if (section.includes(excerpt)) {
    const updatedSection = section.replace(excerpt, afterXhtml.trim());
    return body.slice(0, targetRange.start) + updatedSection + body.slice(targetRange.end);
  }

  //Replace the first block (<li> / <p>) whose normalized text matches.
  const normalizedExcerpt = normalizeForMatch(excerpt);
  if (!normalizedExcerpt) return body;

  const blockPattern = /<li\b[^>]*>[\s\S]*?<\/li>|<p\b[^>]*>[\s\S]*?<\/p>/gi;
  let match: RegExpExecArray | null;
  while ((match = blockPattern.exec(section)) !== null) {
    const candidate = match[0];
    if (!normalizeForMatch(candidate).includes(normalizedExcerpt)) continue;

    const replacement = getBlockAwareReplacement(candidate, afterXhtml);
    const updatedSection =
      section.slice(0, match.index) +
      replacement +
      section.slice(match.index + candidate.length);
    return body.slice(0, targetRange.start) + updatedSection + body.slice(targetRange.end);
  }

  //Do not append for failed update matches; preserve source when anchor is ambiguous.
  return body;
}

function appendAfterHeading(body: string, heading: string, afterXhtml: string): string {
  const anyHeadingPattern = /<h([1-6])[^>]*>[\s\S]*?<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = anyHeadingPattern.exec(body)) !== null) {
    const innerText = match[0].replace(/<[^>]+>/g, '').trim();
    if (innerText.toLowerCase() === heading.trim().toLowerCase()) {
      const insertAt = match.index + match[0].length;
      return body.slice(0, insertAt) + '\n' + afterXhtml.trim() + body.slice(insertAt);
    }
  }
  return body + '\n' + afterXhtml.trim();
}

function prependBeforeHeading(body: string, heading: string, afterXhtml: string): string {
  const anyHeadingPattern = /<h([1-6])[^>]*>[\s\S]*?<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = anyHeadingPattern.exec(body)) !== null) {
    const innerText = match[0].replace(/<[^>]+>/g, '').trim();
    if (innerText.toLowerCase() === heading.trim().toLowerCase()) {
      return body.slice(0, match.index) + afterXhtml.trim() + '\n' + body.slice(match.index);
    }
  }
  return afterXhtml.trim() + '\n' + body;
}

function deleteSection(body: string, _heading: string, beforeExcerpt: string): string {
  if (!beforeExcerpt) return body;
  return body.replace(beforeExcerpt.trim(), '');
}

function findSectionRange(body: string, heading: string): { start: number; end: number } | null {
  if (!heading.trim()) return null;

  //Find all heading tags and check their inner text (after stripping child tags)
  const anyHeadingPattern = /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi;
  let headingMatch: RegExpExecArray | null;
  let foundMatch: { index: number; length: number; level: string } | null = null;

  while ((headingMatch = anyHeadingPattern.exec(body)) !== null) {
  core.info(`findSectionRange: raw heading tag: ${headingMatch[0]}`);
    const level = headingMatch[1];
    const innerText = headingMatch[2].replace(/<[^>]+>/g, '').trim(); // strip child tags
    core.info(`findSectionRange: innerText="${innerText}" looking for="${heading.trim()}"`);
    if (innerText.toLowerCase() === heading.trim().toLowerCase()) {
      foundMatch = {
        index: headingMatch.index,
        length: headingMatch[0].length,
        level,
      };
      break;
    }
  }

  if (!foundMatch) return null;

  const sectionStart = foundMatch.index + foundMatch.length;
  const rest = body.slice(sectionStart);

  //Find the next heading of same or higher level
  const nextHeadingPattern = new RegExp(`<h[1-${foundMatch.level}][^>]*>`, 'i');
  const nextMatch = nextHeadingPattern.exec(rest);
  const sectionEnd = nextMatch ? sectionStart + nextMatch.index : body.length;

  return { start: sectionStart, end: sectionEnd };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeForMatch(input: string): string {
  return decodeHtmlEntities(input)
    .replace(/\\([\\`*_{}\[\]()#+\-.!|])/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[`*_]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getBlockAwareReplacement(currentBlock: string, afterXhtml: string): string {
  const trimmed = afterXhtml.trim();
  if (!/^<li\b/i.test(currentBlock)) return trimmed;

  const singleListItem = trimmed.match(/^<ul>\s*(<li\b[\s\S]*<\/li>)\s*<\/ul>$/i);
  return singleListItem ? singleListItem[1] : trimmed;
}
