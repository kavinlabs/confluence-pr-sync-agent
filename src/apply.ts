/**
 * "apply" mode: runs on issue_comment events.
 * This is invoked when a reviewer approves a confluence change comment created by the "propose" action
 *
 * Validates that:
 *   1. The commenter has write access to the repo
 *   2. The comment body is exactly "approve-confluence" (case-insensitive)
 *   3. The comment is on a PR that has our bot's proposal comment
 *
 * Then applies the changes to Confluence.
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionInputs } from './types';
import { ConfluenceClient } from './confluence';
import { applyChange } from './converter';
import {
  MARKER,
  findExistingComment,
  extractProposalFromComment,
  reactToComment,
} from './comment';

export async function runApply(
  inputs: ActionInputs,
  context: typeof github.context,
  octokit: ReturnType<typeof github.getOctokit>
): Promise<void> {
  const { owner, repo } = context.repo;
  const payload = context.payload;

  const comment = payload.comment as {
    id: number;
    body: string;
    user: { login: string };
  } | undefined;

  const issue = payload.issue as {
    number: number;
    pull_request?: unknown;
  } | undefined;

  if (!comment || !issue) {
    core.info('Skipping as its not an issue_comment event');
    return;
  }

  //Verify this is on a PR
  if (!issue.pull_request) {
    core.info('Skipping as comment is not on a PR');
    return;
  }
  const prNumber = issue.number;

  //Verify comment body is exactly "approve-confluence"
  const body = comment.body.trim().toLowerCase();
  if (body !== 'approve-confluence') {
    core.info(`Skipping as comment body is "${comment.body.trim()}" (not "approve-confluence")`);
    return;
  }

  //Verify actor has write/admin access
  const actor = comment.user.login;
  core.info(`Validating write permission for user "${actor}"`);

  const { data: permData } = await octokit.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor,
  });

  const permission = permData.permission;
  if (!['write', 'admin', 'maintain'].includes(permission)) {
    core.warning(
      `User "${actor}" has permission "${permission}", insufficient to apply changes`
    );
    await octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: comment.id,
      content: '-1',
    });
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `User @${actor} need **write** access to apply Confluence changes.`,
    });
    return;
  }
  core.info(`User "${actor}" has permission "${permission}"`);

  //Find the bot's proposal comment
  const proposalComment = await findExistingComment(octokit, owner, repo, prNumber);
  if (!proposalComment) {
    core.warning('Skipping as no bot proposal comment found on this PR');
    return;
  }

  if (!proposalComment.body.includes(MARKER)) {
    core.warning('Skipping as comment does not contain the bot marker');
    return;
  }

  //Extract JSON proposal
  const proposal = extractProposalFromComment(proposalComment.body);
  if (!proposal) {
    core.error('Could not extract proposal JSON from bot comment');
    return;
  }

  if (!proposal.pages || proposal.pages.length === 0) {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body: `@${actor}, the proposal contains no page changes to apply.`,
    });
    return;
  }

  //Apply changes to Confluence
  const confluenceClient = new ConfluenceClient(
    inputs.confluenceBaseUrl,
    inputs.confluenceType,
    inputs.confluenceToken,
    inputs.confluenceUser
  );

  const updatedPageIds: string[] = [];
  const updatedLinks: string[] = [];
  const unchangedPageIds: string[] = [];

  for (const pageProposal of proposal.pages) {
    try {
      //Re-fetch latest version
      const currentPage = await confluenceClient.getPage(pageProposal.id);
      let newStorageBody = currentPage.storageBody;

      for (const change of pageProposal.changes) {
        core.info(
          `Applying change type="${change.type}" heading="${change.heading}" to page ${pageProposal.id}`
        );
        const previousBody = newStorageBody;
        newStorageBody = applyChange(
          newStorageBody,
          change.type,
          change.heading,
          change.before_excerpt,
          change.after_markdown
        );

        if (newStorageBody === previousBody) {
          core.warning(
            `No-op change type="${change.type}" heading="${change.heading}" on page ${pageProposal.id} (anchor not found or content already up-to-date)`
          );
        }
      }

      if (newStorageBody === currentPage.storageBody) {
        core.warning(
          `No effective content changes for page ${pageProposal.id}; skipping Confluence update`
        );
        unchangedPageIds.push(pageProposal.id);
        continue;
      }

      if (inputs.dryRun) {
        core.info(`[dry-run] Would update page ${pageProposal.id}`);
        core.info('New body preview:\n' + newStorageBody.slice(0, 500));
        updatedPageIds.push(pageProposal.id);
        updatedLinks.push(currentPage.webUrl);
        continue;
      }

      const updated = await confluenceClient.updatePage(
        pageProposal.id,
        currentPage.title,
        newStorageBody,
        `Updated by confluence-pr-sync-agent - PR #${prNumber}`
      );

      core.info(`Updated page "${updated.title}" : ${updated.webUrl}`);
      updatedPageIds.push(updated.id);
      updatedLinks.push(updated.webUrl);
    } catch (err) {
      core.error(`Failed to update page ${pageProposal.id}: ${err}`);
    }
  }

  //Feedback
  if (updatedPageIds.length > 0) {
    const prefix = inputs.dryRun ? '(dry-run) ' : '';
    const linksMarkdown = updatedLinks
      .map((url, i) => `- [Page ${updatedPageIds[i]}](${url})`)
      .join('\n');

    await reactToComment(octokit, owner, repo, comment.id, 'rocket');

    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body:
        `${prefix}Confluence pages updated by @${actor}!\n\n${linksMarkdown}` +
        (unchangedPageIds.length
          ? `\n\nNo-op (not updated): ${unchangedPageIds.map((id) => `\`${id}\``).join(', ')}`
          : ''),
    });

    core.setOutput('updated_page_ids', updatedPageIds.join(','));
  } else {
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body:
        unchangedPageIds.length > 0
          ? `@${actor}, no pages were updated because no effective content changes were detected (anchors not found or content already up-to-date): ${unchangedPageIds.map((id) => `\`${id}\``).join(', ')}. Check Action logs for no-op warnings.`
          : `@${actor}, no pages were updated. Check the Action logs for errors.`,
    });
  }
}
