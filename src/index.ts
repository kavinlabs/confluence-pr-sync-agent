/**
 * Entry point for the `confluence-pr-sync-agent` GitHub Action.
 *
 * Routes to either the "propose" handler (pull_request event)
 * or the "apply" handler (issue_comment event).
 */

import * as core from '@actions/core';
import * as github from '@actions/github';
import { ActionInputs } from './types';
import { runPropose } from './propose';
import { runApply } from './apply';

//Parse inputs

function parseInputs(): ActionInputs {
  const mode = core.getInput('mode') || 'propose';
  if (mode !== 'propose' && mode !== 'apply') {
    throw new Error(`Invalid mode "${mode}". Must be "propose" or "apply".`);
  }

  const confluenceType = core.getInput('confluence_type');
  if (confluenceType !== 'cloud' && confluenceType !== 'datacenter') {
    throw new Error(
      `Invalid confluence_type "${confluenceType}". Must be "cloud" or "datacenter".`
    );
  }

  const llmProvider = core.getInput('llm_provider');
  if (!['openai', 'anthropic', 'google', 'openai-compatible'].includes(llmProvider)) {
    throw new Error(`Invalid llm_provider "${llmProvider}".`);
  }

  const rawPageIds = core.getInput('page_ids');
  const pageIds = rawPageIds
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!pageIds.length) throw new Error('page_ids is required');

  const parseGlobs = (name: string) =>
    core
      .getInput(name)
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

  const maxDiffBytes = parseInt(core.getInput('max_diff_bytes') || '200000', 10);
  const dryRun = core.getInput('dry_run').toLowerCase() === 'true';

  //Mask secrets
  const confluenceToken = core.getInput('confluence_token');
  const llmApiKey = core.getInput('llm_api_key');
  core.setSecret(confluenceToken);
  core.setSecret(llmApiKey);

  return {
    mode: mode as 'propose' | 'apply',
    confluenceType: confluenceType as 'cloud' | 'datacenter',
    confluenceBaseUrl: core.getInput('confluence_base_url'),
    confluenceToken,
    confluenceUser: core.getInput('confluence_user'),
    pageIds,
    llmProvider: llmProvider as ActionInputs['llmProvider'],
    llmModel: core.getInput('llm_model'),
    llmApiKey,
    llmBaseUrl: core.getInput('llm_base_url'),
    customPrompt: core.getInput('custom_prompt'),
    includePaths: parseGlobs('include_paths'),
    excludePaths: parseGlobs('exclude_paths'),
    maxDiffBytes,
    dryRun,
    githubToken: core.getInput('github_token'),
  };
}


async function main(): Promise<void> {
  try {
    const inputs = parseInputs();
    const context = github.context;
    const octokit = github.getOctokit(inputs.githubToken);

    core.info(`Running confluence-pr-sync-agent in "${inputs.mode}" mode`);
    core.info(`Event: ${context.eventName} / Action: ${context.payload.action}`);

    if (inputs.mode === 'propose') {
      //Expected on pull_request events (opened, synchronize, reopened)
      if (context.eventName !== 'pull_request') {
        core.warning(
          `Mode "propose" is designed for pull_request events, got "${context.eventName}"`
        );
      }
      await runPropose(inputs, context, octokit);
    } else {
      //Expected on issue_comment events
      if (context.eventName !== 'issue_comment') {
        core.warning(
          `Mode "apply" is designed for issue_comment events, got "${context.eventName}"`
        );
      }
      await runApply(inputs, context, octokit);
    }
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message);
    } else {
      core.setFailed(String(error));
    }
  }
}

main();
