/**
 * Git diff utilities: fetch, filter, and truncate diffs.
 */

import { execSync } from 'child_process';
import * as core from '@actions/core';
import micromatch from 'micromatch';

export interface DiffOptions {
  base: string;
  head: string;
  includePaths: string[];
  excludePaths: string[];
  maxBytes: number;
}

/**
 * Run `git diff` between two refs and return the filtered, truncated output.
 */
export function getFilteredDiff(opts: DiffOptions): string {
  const { base, head, includePaths, excludePaths, maxBytes } = opts;

  let raw: string;
  try {
    raw = execSync(`git diff ${base}...${head}`, {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8',
    });
  } catch (err) {
    core.warning(`git diff failed: ${err}`);
    return '';
  }

  const sections = splitByFile(raw);
  const filtered = sections.filter((section) => {
    const filePath = extractFilePath(section);
    if (!filePath) return false;

    if (includePaths.length > 0 && !micromatch([filePath], includePaths).length) {
      return false;
    }
    if (excludePaths.length > 0 && micromatch([filePath], excludePaths).length > 0) {
      return false;
    }
    return true;
  });

  let result = filtered.join('');

  if (Buffer.byteLength(result, 'utf8') > maxBytes) {
    core.warning(
      `Diff exceeds max_diff_bytes (${maxBytes}). Truncating to fit.`
    );
    result = truncateToBytes(result, maxBytes);
    result += '\n\n[... diff truncated due to size limit ...]';
  }

  return result;
}

//Helpers

function splitByFile(diff: string): string[] {
  const sections: string[] = [];
  const lines = diff.split('\n');
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith('diff --git ') && current.length > 0) {
      sections.push(current.join('\n') + '\n');
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) sections.push(current.join('\n') + '\n');
  return sections;
}

function extractFilePath(section: string): string | null {
  const match = section.match(/^diff --git a\/(.+?) b\//m);
  return match ? match[1] : null;
}

function truncateToBytes(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, 'utf8');
  return buf.slice(0, maxBytes).toString('utf8');
}
