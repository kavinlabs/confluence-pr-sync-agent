/**
 * GitHub PR comment utilities.
 *
 * The bot maintains a single comment per PR, identified by the
 * HTML marker:  <!-- confluence-pr-sync-agent-marker -->
 *
 * The proposal JSON is stored inside a hidden <details> block so it can
 * be extracted during the "apply" run without any external state.
 */

import * as github from '@actions/github';
import * as core from '@actions/core';
import { LLMProposal, PageProposal } from './types';
import { ConfluencePage } from './types';

export const MARKER = '<!-- confluence-pr-sync-agent-marker -->';

//Build comment body

export function buildProposalComment(
  proposal: LLMProposal,
  pages: ConfluencePage[]
): string {
  const pageMap = new Map(pages.map((p) => [p.id, p]));

  const changesSection = proposal.pages
    .map((pp: PageProposal, pageIndex: number) => {
      const page = pageMap.get(pp.id);
      const pageLabel = `Page ${pageIndex + 1}`;
      const pageTitle = page ? page.title : `Page ${pp.id}`;
      const detailsOpen = pageIndex === 0 ? ' open' : '';
      const pageLinkLine = page
        ? `- Page Link: [${page.title}](${page.webUrl})`
        : `- Page ID: \`${pp.id}\``;

      if (!pp.changes.length) {
        return [
          `<details${detailsOpen}>`,
          `<summary><strong>${pageLabel}:</strong> ${pageTitle}</summary>`,
          '',
          pageLinkLine,
          '',
          '_No proposed section changes._',
          '</details>',
        ].join('\n');
      }

      const changeBlocks = pp.changes
        .map((c, index) => {
          const beforeValue = c.before_excerpt?.trim() || '(none)';
          const afterValue = c.after_markdown?.trim() || '(none)';
          return [
            `**Change ${index + 1}**`,
            `- Section: **${c.heading || '(unspecified)'}**`,
            `- Type: \`${c.type}\``,
            `- Before:`,
            codeFence(beforeValue, 'text'),
            `- After:`,
            codeFence(afterValue, 'markdown'),
            `- Rationale: ${c.rationale}`,
          ].join('\n');
        })
        .join('\n\n');

      return [
        `<details${detailsOpen}>`,
        `<summary><strong>${pageLabel}:</strong> ${pageTitle}</summary>`,
        '',
        pageLinkLine,
        '',
        changeBlocks,
        '</details>',
      ].join('\n');
    })
    .join('\n\n');

  const risksSection = proposal.pages
    .filter((pp) => pp.risks?.length)
    .map((pp) => {
      const page = pageMap.get(pp.id);
      const title = page ? page.title : pp.id;
      return `**${title}:**\n${pp.risks.map((r) => `- ⚠️ ${r}`).join('\n')}`;
    })
    .join('\n\n');

  const hasChanges = proposal.pages.some((p) => p.changes.length > 0);

  const body = `${MARKER}
## Confluence Documentation Sync

**Summary:** ${proposal.summary}

${
  hasChanges
    ? `### Proposed Changes

${changesSection}

${
  risksSection
    ? `### Risks & Caveats

${risksSection}

`
    : ''
}### How to apply

Post a **new comment** on this PR containing:

\`\`\`
approve-confluence
\`\`\`

A collaborator with write access must post the approval.`
    : `> No documentation changes are required for this PR.`
}

<details>
<summary>Raw proposal JSON (used by apply step)</summary>

\`\`\`json
${JSON.stringify(proposal, null, 2)}
\`\`\`

</details>
`;

  return body;
}

function codeFence(content: string, language: string): string {
  const maxTickRun = Math.max(
    0,
    ...Array.from(content.matchAll(/`+/g), (match) => match[0].length)
  );
  const fence = '`'.repeat(Math.max(3, maxTickRun + 1));
  return `${fence}${language}\n${content}\n${fence}`;
}

//Find existing bot comment

export async function findExistingComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number
): Promise<{ id: number; body: string } | null> {
  const { data: comments } = await octokit.rest.issues.listComments({
    owner,
    repo,
    issue_number: prNumber,
    per_page: 100,
  });

  const found = comments.find((c) => c.body?.includes(MARKER));
  return found ? { id: found.id, body: found.body ?? '' } : null;
}

//Upsert comment

export async function upsertProposalComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  dryRun: boolean
): Promise<number> {
  const existing = await findExistingComment(octokit, owner, repo, prNumber);

  if (dryRun) {
    core.info('[dry-run] Would upsert PR comment:\n' + body);
    return existing?.id ?? 0;
  }

  if (existing) {
    core.info(`Updating existing bot comment (id=${existing.id})`);
    await octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: existing.id,
      body,
    });
    return existing.id;
  }

  core.info('Creating new bot comment on PR');
  const { data } = await octokit.rest.issues.createComment({
    owner,
    repo,
    issue_number: prNumber,
    body,
  });
  return data.id;
}

//Extract proposal JSON from comment

export function extractProposalFromComment(commentBody: string): LLMProposal | null {
  const match = commentBody.match(/```json\s*([\s\S]*?)```/);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim()) as LLMProposal;
  } catch {
    return null;
  }
}

//React to a comment

export async function reactToComment(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  commentId: number,
  reaction: '+1' | '-1' | 'laugh' | 'confused' | 'heart' | 'hooray' | 'rocket' | 'eyes' = 'rocket'
): Promise<void> {
  await octokit.rest.reactions.createForIssueComment({
    owner,
    repo,
    comment_id: commentId,
    content: reaction,
  });
}
