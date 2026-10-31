import { Button, DialogDescription, DialogHeader, DialogTitle, Input } from '@openbot/ui';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { meQuery } from '../../app/api.js';
import { useManaged } from '../../app/deployment.js';
import {
  downloadTemplate,
  parseTemplateFile,
  templateLink,
  templateModelNotice,
  templatesQuery,
  tokenFromLink,
  useTemplateActions,
  type BotFromTemplate,
  type Template,
  type TemplateFile,
  type TemplateVisibility,
} from './api.js';

// "Create from template" in New (B6): pick one of the workspace's templates,
// paste a template link, or import an exported JSON file. The owner of a
// template can also make it public (while the admin allows public links) or
// workspace-only again.

export function CopyLinkButton({ token }: { token: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() =>
        void navigator.clipboard.writeText(templateLink(token)).then(() => setCopied(true))
      }
    >
      {copied ? 'Copied' : 'Copy link'}
    </Button>
  );
}

export function FromTemplate({ onBack, onDone }: { onBack(): void; onDone(): void }) {
  const { data } = useQuery(templatesQuery);
  const me = useQuery(meQuery);
  const { createBot, remove, setVisibility } = useTemplateActions();
  const publicEnabled = data?.publicEnabled ?? false;
  const navigate = useNavigate();
  const [link, setLink] = useState('');
  const [fileError, setFileError] = useState<string | null>(null);
  // A Bot whose template model was not available here, kept open to say so.
  const [made, setMade] = useState<BotFromTemplate | null>(null);

  const open = (bot: BotFromTemplate) => {
    onDone();
    void navigate({ to: '/bots/$botId', params: { botId: bot.id } });
  };
  const create = (body: { token: string } | { file: TemplateFile }) =>
    createBot.mutate(body, {
      onSuccess: (bot) => (templateModelNotice(bot) ? setMade(bot) : open(bot)),
    });

  if (made) return <TemplateModelNotice bot={made} onOpen={() => open(made)} />;

  const submitLink = (event: FormEvent) => {
    event.preventDefault();
    const token = tokenFromLink(link);
    if (token) create({ token });
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const picked = event.target.files?.[0];
    event.target.value = '';
    if (!picked) return;
    const parsed = parseTemplateFile(await picked.text());
    if ('error' in parsed) return setFileError(parsed.error);
    setFileError(null);
    create({ file: parsed.file });
  };

  const items = data?.items ?? [];
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>Create from template</DialogTitle>
        <DialogDescription>
          Starts with the template&apos;s profile, settings, Skills and Routines.
        </DialogDescription>
      </DialogHeader>
      {items.length ? (
        <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
          {items.map((template) => (
            <TemplateItem
              key={template.id}
              template={template}
              mine={template.owner.id === me.data?.user.id}
              busy={createBot.isPending}
              publicEnabled={publicEnabled}
              onCreate={() => create({ token: template.token })}
              onDelete={() => remove.mutate(template.token)}
              onVisibility={(visibility) =>
                setVisibility.mutate({ token: template.token, visibility })
              }
            />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No templates yet. Save one from a Bot&apos;s menu.
        </p>
      )}
      <form className="flex gap-2" onSubmit={submitLink}>
        <Input
          value={link}
          onChange={(event) => setLink(event.target.value)}
          placeholder="Paste a template link"
          aria-label="Template link"
        />
        <Button type="submit" disabled={!tokenFromLink(link) || createBot.isPending}>
          Create
        </Button>
      </form>
      <label className="text-sm">
        <span className="text-muted-foreground">Or import a template file: </span>
        <input
          type="file"
          accept="application/json,.json"
          aria-label="Template file"
          onChange={(event) => void importFile(event)}
        />
      </label>
      {(fileError || createBot.error || setVisibility.error) && (
        <p className="text-sm text-destructive">
          {fileError ?? createBot.error?.message ?? setVisibility.error?.message}
        </p>
      )}
      <div className="flex">
        <Button type="button" variant="ghost" className="ml-auto" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

/** After creating: the Bot exists, but not on the template's model (plan 3, B6). */
export function TemplateModelNotice({ bot, onOpen }: { bot: BotFromTemplate; onOpen(): void }) {
  return (
    <div className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{`Created ${bot.name}`}</DialogTitle>
        <DialogDescription>{templateModelNotice(bot)}</DialogDescription>
      </DialogHeader>
      <div className="flex">
        <Button type="button" className="ml-auto" onClick={onOpen} autoFocus>
          {`Open ${bot.name}`}
        </Button>
      </div>
    </div>
  );
}

function TemplateItem({
  template,
  mine,
  busy,
  publicEnabled,
  onCreate,
  onDelete,
  onVisibility,
}: {
  template: Template;
  mine: boolean;
  busy: boolean;
  publicEnabled: boolean;
  onCreate(): void;
  onDelete(): void;
  onVisibility(visibility: TemplateVisibility): void;
}) {
  const isPublic = template.visibility === 'public';
  // Self-hosted keeps public links off, so it offers no Make public at all.
  const managed = useManaged();
  const offerVisibility = isPublic || publicEnabled || managed;
  const counts = [
    `${template.skills} ${template.skills === 1 ? 'Skill' : 'Skills'}`,
    `${template.routines} ${template.routines === 1 ? 'Routine' : 'Routines'}`,
  ].join(', ');
  return (
    <li className="flex items-center gap-2 rounded-md border px-3 py-2">
      <span className="flex min-w-0 flex-col leading-tight">
        <span className="truncate text-sm">
          {template.name}
          {template.visibility === 'public' && (
            <span className="ml-2 text-xs text-muted-foreground">public</span>
          )}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {`${mine ? 'Yours' : template.owner.name}, ${counts}`}
        </span>
      </span>
      <span className="ml-auto flex shrink-0 gap-1">
        <CopyLinkButton token={template.token} />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => void downloadTemplate(template)}
        >
          Download
        </Button>
        {mine && offerVisibility && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!isPublic && !publicEnabled}
            title={!isPublic && !publicEnabled ? 'An admin has public links off' : undefined}
            onClick={() => onVisibility(isPublic ? 'workspace' : 'public')}
          >
            {isPublic ? 'Make workspace only' : 'Make public'}
          </Button>
        )}
        {mine && (
          <Button type="button" variant="ghost" size="sm" onClick={onDelete}>
            Delete
          </Button>
        )}
        <Button type="button" size="sm" disabled={busy} onClick={onCreate}>
          Create
        </Button>
      </span>
    </li>
  );
}
