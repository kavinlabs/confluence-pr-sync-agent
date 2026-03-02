import { execSync } from 'child_process';
import * as core from '@actions/core';
import { getFilteredDiff } from '../src/diff';

jest.mock('child_process', () => ({
  execSync: jest.fn(),
}));

jest.mock('@actions/core', () => ({
  warning: jest.fn(),
}));

const mockedExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockedWarning = core.warning as jest.MockedFunction<typeof core.warning>;

describe('getFilteredDiff', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('filters files using include and exclude globs', () => {
    mockedExecSync.mockReturnValue(
      [
        'diff --git a/src/keep.ts b/src/keep.ts',
        '--- a/src/keep.ts',
        '+++ b/src/keep.ts',
        '@@ -1 +1 @@',
        '-old',
        '+new',
        'diff --git a/docs/skip.md b/docs/skip.md',
        '--- a/docs/skip.md',
        '+++ b/docs/skip.md',
        '@@ -1 +1 @@',
        '-old doc',
        '+new doc',
        '',
      ].join('\n')
    );

    const result = getFilteredDiff({
      base: 'baseSha',
      head: 'headSha',
      includePaths: ['src/**'],
      excludePaths: ['**/*.md'],
      maxBytes: 10000,
    });

    expect(mockedExecSync).toHaveBeenCalledWith('git diff baseSha...headSha', {
      maxBuffer: 50 * 1024 * 1024,
      encoding: 'utf8',
    });
    expect(result).toContain('diff --git a/src/keep.ts b/src/keep.ts');
    expect(result).not.toContain('diff --git a/docs/skip.md b/docs/skip.md');
  });

  it('truncates oversized diff and emits a warning', () => {
    mockedExecSync.mockReturnValue(
      [
        'diff --git a/src/file.ts b/src/file.ts',
        '--- a/src/file.ts',
        '+++ b/src/file.ts',
        '@@ -1 +1 @@',
        '-aaaaaa',
        '+bbbbbb',
        '',
      ].join('\n')
    );

    const result = getFilteredDiff({
      base: 'a',
      head: 'b',
      includePaths: [],
      excludePaths: [],
      maxBytes: 20,
    });

    expect(mockedWarning).toHaveBeenCalledWith(
      expect.stringContaining('Diff exceeds max_diff_bytes (20). Truncating to fit.')
    );
    expect(result).toContain('[... diff truncated due to size limit ...]');
  });

  it('returns empty string when git diff fails', () => {
    mockedExecSync.mockImplementation(() => {
      throw new Error('git failed');
    });

    const result = getFilteredDiff({
      base: 'a',
      head: 'b',
      includePaths: [],
      excludePaths: [],
      maxBytes: 10000,
    });

    expect(result).toBe('');
    expect(mockedWarning).toHaveBeenCalledWith(expect.stringContaining('git diff failed'));
  });
});
