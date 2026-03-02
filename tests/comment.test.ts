import * as core from '@actions/core';
import {
  MARKER,
  buildProposalComment,
  extractProposalFromComment,
  findExistingComment,
  upsertProposalComment,
} from '../src/comment';
import { ConfluencePage, LLMProposal } from '../src/types';

jest.mock('@actions/core', () => ({
  info: jest.fn(),
  warning: jest.fn(),
}));

const mockedInfo = core.info as jest.MockedFunction<typeof core.info>;

function makeProposal(): LLMProposal {
  return {
    summary: 'Docs update needed',
    pages: [
      {
        id: '123',
        changes: [
          {
            type: 'update',
            heading: 'Authentication',
            before_excerpt: 'Old auth flow',
            after_markdown: 'New auth flow',
            rationale: 'Reflect new token model',
          },
        ],
        risks: ['Could be stale if API shifts'],
      },
    ],
  };
}

function makePages(): ConfluencePage[] {
  return [
    {
      id: '123',
      title: 'Backend Guide',
      webUrl: 'https://example.atlassian.net/wiki/spaces/ENG/pages/123',
      storageBody: '<p>Body</p>',
      version: 1,
    },
  ];
}

describe('comment utilities', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('buildProposalComment includes marker, linear change blocks, risks, and raw JSON', () => {
    const proposal = makeProposal();
    const pages = makePages();

    const body = buildProposalComment(proposal, pages);

    expect(body).toContain(MARKER);
    expect(body).toContain('<details open>');
    expect(body).toContain('<summary><strong>Page 1:</strong> Backend Guide</summary>');
    expect(body).toContain('- Page Link: [Backend Guide](https://example.atlassian.net/wiki/spaces/ENG/pages/123)');
    expect(body).toContain('- Section: **Authentication**');
    expect(body).toContain('- Type: `update`');
    expect(body).toContain('- Before:');
    expect(body).toContain('```text');
    expect(body).toContain('Old auth flow');
    expect(body).toContain('- After:');
    expect(body).toContain('```markdown');
    expect(body).toContain('New auth flow');
    expect(body).toContain('- Rationale: Reflect new token model');
    expect(body).toContain('### Risks & Caveats');
    expect(body).toContain('Could be stale if API shifts');
    expect(body).toContain('```json');
  });

  it('extractProposalFromComment returns parsed JSON proposal', () => {
    const proposal = makeProposal();
    const body = buildProposalComment(proposal, makePages());

    const extracted = extractProposalFromComment(body);

    expect(extracted).toEqual(proposal);
  });

  it('extractProposalFromComment returns null for invalid JSON block', () => {
    const body = `${MARKER}\n\`\`\`json\n{ invalid json }\n\`\`\``;
    expect(extractProposalFromComment(body)).toBeNull();
  });

  it('findExistingComment returns marker comment when present', async () => {
    const octokit = {
      rest: {
        issues: {
          listComments: jest.fn().mockResolvedValue({
            data: [
              { id: 10, body: 'normal comment' },
              { id: 20, body: `${MARKER}\ntracked` },
            ],
          }),
        },
      },
    } as any;

    const found = await findExistingComment(octokit, 'owner', 'repo', 7);

    expect(found).toEqual({ id: 20, body: `${MARKER}\ntracked` });
  });

  it('upsertProposalComment creates when no existing comment', async () => {
    const listComments = jest.fn().mockResolvedValue({ data: [] });
    const createComment = jest.fn().mockResolvedValue({ data: { id: 99 } });
    const updateComment = jest.fn();
    const octokit = {
      rest: {
        issues: {
          listComments,
          createComment,
          updateComment,
        },
      },
    } as any;

    const id = await upsertProposalComment(octokit, 'owner', 'repo', 12, 'body text', false);

    expect(id).toBe(99);
    expect(createComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      issue_number: 12,
      body: 'body text',
    });
    expect(updateComment).not.toHaveBeenCalled();
  });

  it('upsertProposalComment updates when existing comment exists', async () => {
    const listComments = jest.fn().mockResolvedValue({
      data: [{ id: 55, body: `${MARKER}\nold` }],
    });
    const createComment = jest.fn();
    const updateComment = jest.fn().mockResolvedValue({});
    const octokit = {
      rest: {
        issues: {
          listComments,
          createComment,
          updateComment,
        },
      },
    } as any;

    const id = await upsertProposalComment(octokit, 'owner', 'repo', 12, 'new body', false);

    expect(id).toBe(55);
    expect(updateComment).toHaveBeenCalledWith({
      owner: 'owner',
      repo: 'repo',
      comment_id: 55,
      body: 'new body',
    });
    expect(createComment).not.toHaveBeenCalled();
  });

  it('upsertProposalComment dry-run returns existing id and does not write', async () => {
    const listComments = jest.fn().mockResolvedValue({
      data: [{ id: 1234, body: `${MARKER}\nold` }],
    });
    const createComment = jest.fn();
    const updateComment = jest.fn();
    const octokit = {
      rest: {
        issues: {
          listComments,
          createComment,
          updateComment,
        },
      },
    } as any;

    const id = await upsertProposalComment(octokit, 'owner', 'repo', 12, 'new body', true);

    expect(id).toBe(1234);
    expect(updateComment).not.toHaveBeenCalled();
    expect(createComment).not.toHaveBeenCalled();
    expect(mockedInfo).toHaveBeenCalledWith(expect.stringContaining('[dry-run] Would upsert PR comment:'));
  });
});
