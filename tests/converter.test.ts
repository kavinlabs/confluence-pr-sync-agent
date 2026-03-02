import { applyChange, markdownToXhtml, xhtmlToMarkdown } from '../src/converter';

describe('converter utilities', () => {
  it('xhtmlToMarkdown converts basic XHTML to markdown', () => {
    const input = '<h1>Title</h1><p>Hello <strong>world</strong></p>';
    const out = xhtmlToMarkdown(input);

    expect(out).toContain('# Title');
    expect(out).toContain('Hello **world**');
  });

  it('markdownToXhtml converts fenced code blocks to confluence code macro', () => {
    const markdown = '```ts\nconst x = 1 < 2 && 3 > 2;\n```';
    const out = markdownToXhtml(markdown);

    expect(out).toContain('<ac:structured-macro ac:name="code">');
    expect(out).toContain('<ac:parameter ac:name="language">ts</ac:parameter>');
    expect(out).toContain('<ac:plain-text-body><![CDATA[const x = 1 < 2 && 3 > 2;');
  });

  it('applyChange update replaces matched before excerpt', () => {
    const body = '<p>Old auth flow</p>';
    const out = applyChange(body, 'update', 'Authentication', 'Old auth flow', 'New auth flow');

    expect(out).not.toContain('Old auth flow');
    expect(out).toContain('<p>New auth flow</p>');
  });

  it('applyChange append inserts content after matching heading', () => {
    const body = '<h2>Authentication</h2><p>Existing section</p>';
    const out = applyChange(body, 'append', 'Authentication', '', 'Appended details');

    expect(out).toContain('<h2>Authentication</h2>\n<p>Appended details</p>');
  });

  it('applyChange prepend inserts content before matching heading', () => {
    const body = '<h2>Authentication</h2><p>Existing section</p>';
    const out = applyChange(body, 'prepend', 'Authentication', '', 'Prepended details');

    expect(out).toContain('<p>Prepended details</p>\n<h2>Authentication</h2>');
  });

  it('applyChange delete_section removes matching excerpt', () => {
    const body = '<h2>Authentication</h2><p>Delete me</p><p>Keep me</p>';
    const out = applyChange(body, 'delete_section', 'Authentication', 'Delete me', '');

    expect(out).not.toContain('Delete me');
    expect(out).toContain('Keep me');
  });

  it('applyChange update replaces list item with markdown-escaped excerpt', () => {
    const body =
      '<h2>API Endpoint</h2><ul><li><code>personality</code> (STRICT | PASSIVE_AGGRESSIVE)</li></ul>';

    const out = applyChange(
      body,
      'update',
      'API Endpoint',
      '-   `personality` (STRICT | PASSIVE\\_AGGRESSIVE)',
      '-   `personality` (STRICT | PASSIVE\\_AGGRESSIVE | VIBE_CODER)'
    );

    expect(out).toContain('VIBE_CODER');
    expect(out).not.toContain('</li></ul><ul><li>');
    expect(out).not.toContain('PASSIVE_AGGRESSIVE)</li></ul><ul>');
  });
});
