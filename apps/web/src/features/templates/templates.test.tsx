import { Dialog } from '@openbot/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterContextProvider } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { meQuery } from '../../app/api.js';
import { NewFlow } from '../../app/new-dialog.js';
import { TemplateModelNotice } from './template-list.js';
import { createAppRouter } from '../../app/router.js';
import { me } from '../../test-utils.js';
import { botsQuery } from '../bots/queries.js';
import {
  parseTemplateFile,
  templateFileName,
  templateLink,
  templateModelNotice,
  templatesQuery,
  tokenFromLink,
  type BotFromTemplate,
  type Template,
} from './api.js';

const template = (fields: Partial<Template> = {}): Template => ({
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Morning analyst',
  visibility: 'workspace',
  token: 'tok_abc',
  owner: { id: '00000000-0000-4000-8000-000000000099', name: 'Grace' },
  botName: 'Analyst',
  skills: 2,
  routines: 1,
  createdAt: '2026-10-20T00:00:00.000Z',
  ...fields,
});

function render(node: ReactNode, items: Template[]) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(meQuery.queryKey, me('member') as never);
  queryClient.setQueryData(botsQuery.queryKey, { items: [] });
  queryClient.setQueryData(templatesQuery.queryKey, { items, publicEnabled: false });
  const router = createAppRouter(queryClient, createMemoryHistory());
  return renderToString(
    <QueryClientProvider client={queryClient}>
      <RouterContextProvider router={router}>
        <Dialog open>{node}</Dialog>
      </RouterContextProvider>
    </QueryClientProvider>,
  );
}

describe('template links and files', () => {
  it('reads the token from a pasted link or a bare token', () => {
    const link = templateLink('tok_abc', 'https://bots.example.com');
    expect(link).toBe('https://bots.example.com/api/v1/templates/tok_abc');
    expect(tokenFromLink(link)).toBe('tok_abc');
    expect(tokenFromLink(` ${link}?x=1 `)).toBe('tok_abc');
    expect(tokenFromLink('tok_abc')).toBe('tok_abc');
    expect(tokenFromLink('  ')).toBeNull();
  });

  it('accepts only an OpenBot template file', () => {
    expect(parseTemplateFile('nope')).toEqual({ error: 'That file is not JSON.' });
    expect(parseTemplateFile('{"format":"other"}')).toEqual({
      error: 'That file is not an OpenBot template.',
    });
    const file = { format: 'openbot.template', version: 1, name: 'A', snapshot: {} };
    expect(parseTemplateFile(JSON.stringify(file))).toEqual({ file });
  });

  it('names the export after the template', () => {
    expect(templateFileName('Morning Analyst!')).toBe('morning-analyst.openbot.json');
    expect(templateFileName('***')).toBe('template.openbot.json');
  });
});

describe('Create from template', () => {
  it('is offered in New', () => {
    expect(render(<NewFlow onDone={() => {}} />, [])).toContain('Create from template');
  });

  it("lists the workspace's templates with link, file and create actions", () => {
    const html = render(<NewFlow onDone={() => {}} initial={{ kind: 'template' }} />, [
      template(),
      template({
        id: '00000000-0000-4000-8000-000000000011',
        name: 'Mine',
        owner: me('member').user,
      }),
    ]);
    expect(html).toContain('Morning analyst');
    expect(html).toContain('Grace, 2 Skills, 1 Routine');
    expect(html).toContain('Yours');
    expect(html).toContain('Copy link');
    expect(html).toContain('Download');
    // Only the owner deletes a template.
    expect(html.match(/>Delete</g)).toHaveLength(1);
    expect(html).toContain('aria-label="Template link"');
    expect(html).toContain('aria-label="Template file"');
  });

  it('says how to make one when there are none', () => {
    const html = render(<NewFlow onDone={() => {}} initial={{ kind: 'template' }} />, []);
    expect(html).toContain('No templates yet');
  });
});

describe("a template's model that is not available here (B6, plan 3)", () => {
  const made = (fields: Partial<BotFromTemplate>) =>
    ({
      name: 'Analyst',
      modelConfig: {
        provider_id: '00000000-0000-4000-8000-000000000001',
        model_id: 'claude-opus-5-5',
      },
      templateModel: { modelId: 'gpt-elsewhere', used: false },
      ...fields,
    }) as BotFromTemplate;

  it('says which model the Bot got instead, or that it needs one', () => {
    expect(templateModelNotice(made({}))).toBe(
      "The template's model, gpt-elsewhere, isn't available here, so Analyst uses claude-opus-5-5 instead.",
    );
    expect(templateModelNotice(made({ modelConfig: null }))).toBe(
      "The template's model, gpt-elsewhere, isn't available here. Pick a model in Analyst's Settings.",
    );
    expect(templateModelNotice(made({ templateModel: { modelId: 'm', used: true } }))).toBeNull();
    expect(templateModelNotice(made({ templateModel: null }))).toBeNull();
  });

  it('keeps New open on the notice with a way to the new Bot', () => {
    const html = render(<TemplateModelNotice bot={made({})} onOpen={() => {}} />, []);
    expect(html).toContain('Created Analyst');
    expect(html).toContain('gpt-elsewhere');
    expect(html).toContain('Open Analyst');
  });
});
