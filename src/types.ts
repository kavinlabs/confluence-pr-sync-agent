//Shared types

export interface ActionInputs {
  mode: 'propose' | 'apply';
  confluenceType: 'cloud' | 'datacenter';
  confluenceBaseUrl: string;
  confluenceToken: string;
  confluenceUser: string;
  pageIds: string[];
  llmProvider: 'openai' | 'anthropic' | 'google' | 'openai-compatible';
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  customPrompt: string;
  includePaths: string[];
  excludePaths: string[];
  maxDiffBytes: number;
  dryRun: boolean;
  githubToken: string;
}

//LLM schema

export interface PageChange {
  /** 'update' | 'append' | 'prepend' | 'delete_section' */
  type: string;
  /** The heading of the section being modified */
  heading: string;
  /** Short excerpt of the current text (before state) */
  before_excerpt: string;
  /** Full replacement content in Markdown */
  after_markdown: string;
  /** Why this change is needed based on the diff */
  rationale: string;
}

export interface PageProposal {
  id: string;
  changes: PageChange[];
  risks: string[];
}

export interface LLMProposal {
  summary: string;
  pages: PageProposal[];
}

// Confluence types

export interface ConfluencePage {
  id: string;
  title: string;
  /** Storage format (XHTML) body */
  storageBody: string;
  version: number;
  webUrl: string;
}
