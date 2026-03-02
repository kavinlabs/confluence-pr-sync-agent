/**
 * "propose" mode: runs on pull_request events.
 * This is invoked on PR events and creates the confluence changes comment.
 *
 * 1. Collect PR context + filtered diff
 * 2. Fetch Confluence pages
 * 3. Convert XHTML -> Markdown for LLM
 * 4. Call LLM to generate proposal
 * 5. Upsert PR comment with proposal
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionInputs, LLMProposal, PageProposal } from './types';
import { ConfluenceClient } from './confluence';
import { callLLM, PageWithMarkdown } from './llm';
import { xhtmlToMarkdown } from './converter';
import { getFilteredDiff } from './diff';
import {
  buildProposalComment,
  upsertProposalComment,
} from './comment';

export async function runPropose(
  inputs: ActionInputs,
  context: typeof github.context,
  octokit: ReturnType<typeof github.getOctokit>
): Promise<void> {
  const { owner, repo } = context.repo;
  const pr = context.payload.pull_request;

  if (!pr) {
    throw new Error('No pull_request payload found. Is this triggered by a pull_request event?');
  }

  const prNumber = pr.number as number;
  const prTitle = (pr.title as string) ?? '';
  const prBody = (pr.body as string) ?? '';
  const prLabels: string[] = ((pr.labels as { name: string }[]) ?? []).map((l) => l.name);
  const base = (pr.base as { sha: string }).sha;
  const head = (pr.head as { sha: string }).sha;

  core.info(`PR #${prNumber}: "${prTitle}"`);
  core.info(`Diff base=${base} head=${head}`);

  //Get filtered diff
  const diff = getFilteredDiff({
    base,
    head,
    includePaths: inputs.includePaths,
    excludePaths: inputs.excludePaths,
    maxBytes: inputs.maxDiffBytes,
  });
  core.info(`Diff size: ${Buffer.byteLength(diff, 'utf8')} bytes`);

  //Fetch Confluence pages
  const confluenceClient = new ConfluenceClient(
    inputs.confluenceBaseUrl,
    inputs.confluenceType,
    inputs.confluenceToken,
    inputs.confluenceUser
  );

  const pages: PageWithMarkdown[] = [];
  for (const pageId of inputs.pageIds) {
    try {
      const page = await confluenceClient.getPage(pageId);
      const markdownBody = xhtmlToMarkdown(page.storageBody);
      core.info(`Fetched page ${pageId}: "${page.title}" (${page.storageBody.length} chars)`);
      pages.push({ ...page, markdownBody });
    } catch (err) {
      core.warning(`Failed to fetch Confluence page ${pageId}: ${err}`);
    }
  }

  if (!pages.length) {
    core.warning('No Confluence pages could be fetched. Skipping LLM call.');
    return;
  }

  //Call LLM once per page to keep context focused and bounded
  const mergedPageProposals: PageProposal[] = [];
  for (const page of pages) {
    core.info(`Calling LLM for page ${page.id}: "${page.title}"`);
    const pageProposal = await callLLM(inputs, prTitle, prBody, prLabels, diff, [page]);

    if (!Array.isArray(pageProposal.pages) || pageProposal.pages.length === 0) {
      core.info(`No documentation changes proposed for page ${page.id}`);
      continue;
    }

    // In per-page mode we only accept one page result, anchored to the current page id.
    const matched = pageProposal.pages.find((p) => p.id === page.id) ?? pageProposal.pages[0];
    if (matched.id !== page.id) {
      core.warning(
        `LLM returned page id "${matched.id}" while evaluating page "${page.id}". Remapping to current page id.`
      );
    }

    mergedPageProposals.push({
      id: page.id,
      changes: Array.isArray(matched.changes) ? matched.changes : [],
      risks: Array.isArray(matched.risks) ? matched.risks : [],
    });
  }

  const proposal: LLMProposal =
    mergedPageProposals.length > 0
      ? {
          summary: `Proposed documentation changes for ${mergedPageProposals.length} page(s).`,
          pages: mergedPageProposals,
        }
      : {
          summary: 'No documentation changes required.',
          pages: [],
        };

  //Create or update PR comment
  const commentBody = buildProposalComment(
    proposal,
    pages.map((p) => ({
      id: p.id,
      title: p.title,
      storageBody: p.storageBody,
      version: p.version,
      webUrl: p.webUrl,
    }))
  );

  const commentId = await upsertProposalComment(
    octokit,
    owner,
    repo,
    prNumber,
    commentBody,
    inputs.dryRun
  );

  core.setOutput('proposal_comment_id', String(commentId));
  core.info(`Proposal comment id=${commentId}`);
}
