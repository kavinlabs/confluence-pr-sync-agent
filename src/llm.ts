/**
 * LLM integration via Vercel AI SDK.
 * Supports: openai, anthropic, google, openai-compatible (Ollama/LocalAI).
 */

import * as core from '@actions/core';
import { generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { ActionInputs, ConfluencePage, LLMProposal } from './types';

/**
 * Pages passed to the LLM must include markdown content.
 */
export interface PageWithMarkdown extends ConfluencePage {
  markdownBody: string;
}

//System prompt

function buildSystemPrompt(customPrompt: string): string {
  const base = `You are a technical documentation assistant. Your job is to review a Git diff from a Pull Request and propose targeted updates to Confluence documentation pages.

RULES:
1. Base every proposed change STRICTLY on evidence in the provided diff. Do not invent changes.
2. If the diff does not affect the content covered by a page, do not include that page in the response.
3. If no pages need updating, return: {"summary":"No documentation changes required.","pages":[]}
4. Preserve existing Confluence formatting intent. Write proposed content in clean Markdown.
5. Be conservative: only update sections directly impacted by the diff.
6. The "before_excerpt" field should contain a short (≤ 50 word) verbatim excerpt of the current page text near the change point, so the apply step can locate it.
7. Supported change types: "update" (replace a section), "append" (add after a heading), "prepend" (add before/at top), "delete_section" (remove a section - use sparingly).

OUTPUT FORMAT (strict JSON, no markdown fences, no extra keys):
{
  "summary": "<one-sentence summary of all proposed changes>",
  "pages": [
    {
      "id": "<confluence page id>",
      "changes": [
        {
          "type": "update",
          "heading": "<heading of the section being changed>",
          "before_excerpt": "<short verbatim excerpt of existing text>",
          "after_markdown": "<full replacement content in Markdown>",
          "rationale": "<why this change is needed based on the diff>"
        }
      ],
      "risks": ["<optional risk or caveat>"]
    }
  ]
}`;

  return customPrompt ? `${base}\n\nADDITIONAL INSTRUCTIONS:\n${customPrompt}` : base;
}

//User prompt

function buildUserPrompt(
  prTitle: string,
  prBody: string,
  prLabels: string[],
  diff: string,
  pages: PageWithMarkdown[]
): string {
  const pageContext = pages
    .map(
      (p) =>
        `### Page ID: ${p.id}\n**Title:** ${p.title}\n**Current Content (Markdown):**\n${p.markdownBody ?? '*(empty)*'}`
    )
    .join('\n\n---\n\n');

  return `## Pull Request Context

**Title:** ${prTitle}
**Labels:** ${prLabels.length ? prLabels.join(', ') : 'none'}

**Description:**
${prBody || '*(no description)*'}

## Git Diff (filtered)

\`\`\`diff
${diff || '*(empty diff)*'}
\`\`\`

## Confluence Pages to Review

${pageContext}

---

Based on the diff above, propose documentation updates for the Confluence pages.
Remember: return empty pages array if the diff does not warrant documentation changes.`;
}

//Provider factory

function buildModel(inputs: ActionInputs) {
  core.setSecret(inputs.llmApiKey);

  switch (inputs.llmProvider) {
    case 'openai': {
      const client = createOpenAI({ apiKey: inputs.llmApiKey });
      return client(inputs.llmModel);
    }
    case 'anthropic': {
      const client = createAnthropic({ apiKey: inputs.llmApiKey });
      return client(inputs.llmModel);
    }
    case 'google': {
      const client = createGoogleGenerativeAI({ apiKey: inputs.llmApiKey });
      return client(inputs.llmModel);
    }
    case 'openai-compatible': {
      const client = createOpenAI({
        apiKey: inputs.llmApiKey || 'local',
        baseURL: inputs.llmBaseUrl || 'http://localhost:11434/v1',
      });
      return client(inputs.llmModel);
    }
    default:
      throw new Error(`Unknown llm_provider: ${inputs.llmProvider}`);
  }
}


export async function callLLM(
  inputs: ActionInputs,
  prTitle: string,
  prBody: string,
  prLabels: string[],
  diff: string,
  pages: PageWithMarkdown[]
): Promise<LLMProposal> {
  const model = buildModel(inputs);

  const systemPrompt = buildSystemPrompt(inputs.customPrompt);
  const userPrompt = buildUserPrompt(prTitle, prBody, prLabels, diff, pages);

  core.info(`Calling LLM (${inputs.llmProvider} / ${inputs.llmModel}) …`);

  const { text } = await generateText({
    model,
    system: systemPrompt,
    prompt: userPrompt,
    maxTokens: 4096,
    temperature: 0.1,
  });

  //Strip accidental markdown fences
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  let proposal: LLMProposal;
  try {
    proposal = JSON.parse(cleaned) as LLMProposal;
  } catch {
    core.error(`LLM returned non-JSON output:\n${text}`);
    throw new Error('LLM did not return valid JSON');
  }

  //Basic schema validation
  if (typeof proposal.summary !== 'string') {
    throw new Error('LLM response missing "summary" field');
  }
  if (!Array.isArray(proposal.pages)) {
    throw new Error('LLM response missing "pages" array');
  }

  core.info(`LLM proposal: ${proposal.summary}`);
  return proposal;
}
