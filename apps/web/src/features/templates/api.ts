import { unwrap, type components } from '@openbot/api-client';
import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../app/api.js';
import { botsQuery } from '../bots/queries.js';

// Bot templates (B6): save a Bot as one, share its link, make it public or
// workspace-only, download it as a JSON file, and create a Bot from a link,
// a file or the workspace's list.

export type Template = components['schemas']['Template'];
export type TemplateFile = components['schemas']['TemplateFile'];
export type TemplateVisibility = components['schemas']['TemplateVisibility'];
export type BotFromTemplate = components['schemas']['BotFromTemplate'];

/**
 * What to tell the owner when the template's model is not available here
 * (another instance's provider, say), so the new Bot runs on the default
 * model instead (plan 3); null when there is nothing to say.
 */
export function templateModelNotice(
  bot: Pick<BotFromTemplate, 'name' | 'modelConfig' | 'templateModel'>,
): string | null {
  const { templateModel, modelConfig } = bot;
  if (!templateModel || templateModel.used) return null;
  const missing = `The template's model, ${templateModel.modelId}, isn't available here`;
  return modelConfig
    ? `${missing}, so ${bot.name} uses ${modelConfig.model_id} instead.`
    : `${missing}. Pick a model in ${bot.name}'s Settings.`;
}

export const templatesQuery = queryOptions({
  queryKey: ['templates'],
  queryFn: () => unwrap(api.GET('/api/v1/templates')),
});

const LINK_PATH = '/api/v1/templates/';

/** The share link for a template token on this instance. */
export function templateLink(token: string, origin: string = window.location.origin): string {
  return `${origin}${LINK_PATH}${token}`;
}

/** The token from a pasted link, or the text itself when it is a bare token; null when empty. */
export function tokenFromLink(text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  const at = value.indexOf(LINK_PATH);
  const token = at >= 0 ? value.slice(at + LINK_PATH.length) : value;
  return token.split(/[?#/]/)[0] || null;
}

/** An exported template file's contents, or an error to show. */
export function parseTemplateFile(text: string): { file: TemplateFile } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { error: 'That file is not JSON.' };
  }
  if (
    !value ||
    typeof value !== 'object' ||
    (value as { format?: unknown }).format !== 'openbot.template'
  ) {
    return { error: 'That file is not an OpenBot template.' };
  }
  return { file: value as TemplateFile };
}

/** A file name for the JSON export. */
export function templateFileName(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  return `${base || 'template'}.openbot.json`;
}

/** Downloads a template as its JSON file. */
export async function downloadTemplate(template: Pick<Template, 'token' | 'name'>) {
  const file = await unwrap(
    api.GET('/api/v1/templates/{token}', { params: { path: { token: template.token } } }),
  );
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = templateFileName(template.name);
  a.click();
  URL.revokeObjectURL(url);
}

export function useTemplateActions() {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: templatesQuery.queryKey });
  const save = useMutation({
    mutationFn: ({
      botId,
      ...body
    }: {
      botId: string;
      name?: string;
      visibility?: TemplateVisibility;
    }) => unwrap(api.POST('/api/v1/bots/{id}/template', { params: { path: { id: botId } }, body })),
    onSuccess: refresh,
  });
  const setVisibility = useMutation({
    mutationFn: ({ token, visibility }: { token: string; visibility: TemplateVisibility }) =>
      unwrap(
        api.PATCH('/api/v1/templates/{token}', {
          params: { path: { token } },
          body: { visibility },
        }),
      ),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (token: string) =>
      unwrap(api.DELETE('/api/v1/templates/{token}', { params: { path: { token } } })),
    onSuccess: refresh,
  });
  const createBot = useMutation({
    mutationFn: (body: { token: string } | { file: TemplateFile }) =>
      unwrap(api.POST('/api/v1/bots/from-template', { body })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: botsQuery.queryKey }),
  });
  return { save, setVisibility, remove, createBot };
}
