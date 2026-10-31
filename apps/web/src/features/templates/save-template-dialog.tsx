import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from '@openbot/ui';
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useManaged } from '../../app/deployment.js';
import type { Bot } from '../bots/queries.js';
import { CopyLinkButton } from './template-list.js';
import { downloadTemplate, templatesQuery, useTemplateActions, type Template } from './api.js';

// "Save as template" from the Bot menu (B6). The template carries the
// profile, settings, avatar, enabled Skills and Routines; never the
// conversation, memories or attachments. Once saved it shows the link to
// copy and the JSON file to download.

export function SaveTemplateDialog({ bot, onClose }: { bot: Bot | null; onClose(): void }) {
  return (
    <Dialog open={bot !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        {bot && <SaveTemplate key={bot.id} bot={bot} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function SaveTemplate({ bot, onClose }: { bot: Bot; onClose(): void }) {
  const [name, setName] = useState(bot.name);
  const [isPublic, setPublic] = useState(false);
  const [saved, setSaved] = useState<Template | null>(null);
  const { data } = useQuery(templatesQuery);
  const { save } = useTemplateActions();
  const publicEnabled = data?.publicEnabled ?? false;
  // Self-hosted keeps public links off, so it offers no Public link at all.
  const managed = useManaged();
  const offerPublic = publicEnabled || managed;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    save.mutate(
      { botId: bot.id, name: name.trim(), visibility: isPublic ? 'public' : 'workspace' },
      { onSuccess: setSaved },
    );
  };

  if (saved) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Template saved</DialogTitle>
          <DialogDescription>
            {saved.visibility === 'public'
              ? 'Anyone with the link can download it.'
              : 'Workspace members can open the link or pick it under New.'}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => void downloadTemplate(saved)}>
            Download JSON
          </Button>
          <CopyLinkButton token={saved.token} />
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      <DialogHeader>
        <DialogTitle>Save {bot.name} as a template</DialogTitle>
        <DialogDescription>
          Saves the profile, settings, Skills and Routines, not the conversation.
        </DialogDescription>
      </DialogHeader>
      <Input
        value={name}
        onChange={(event) => setName(event.target.value)}
        aria-label="Template name"
        maxLength={80}
        required
        autoFocus
      />
      {offerPublic && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={isPublic}
            disabled={!publicEnabled}
            onChange={(event) => setPublic(event.target.checked)}
          />
          Public link
          {!publicEnabled && (
            <span className="text-xs text-muted-foreground">(an admin has public links off)</span>
          )}
        </label>
      )}
      {save.error && <p className="text-sm text-destructive">{save.error.message}</p>}
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim() || save.isPending}>
          Save template
        </Button>
      </DialogFooter>
    </form>
  );
}
