import { isComputerTool } from '@openbot/shared';
import { cn } from '@openbot/ui';
import type { SVGProps } from 'react';
import type { Bot } from '../bots/queries.js';

// Status (I5, K3, plan 9.4): the title-bar computer icon, lit while the Bot's
// current tool is a computer tool and dim otherwise.

export function ComputerIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} {...props}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" strokeLinecap="round" />
    </svg>
  );
}

/** Whether the Bot is using its computer right now. */
export const computerActive = (state: Bot['state']) =>
  state.state === 'working' && isComputerTool(state.currentTool);

export function ComputerStatusIcon({ bot }: { bot: Bot }) {
  const active = computerActive(bot.state);
  return (
    <span
      role="img"
      aria-label={active ? 'Using its computer' : 'Computer idle'}
      title={active ? (bot.state.currentAction ?? 'Using its computer') : undefined}
      data-active={active || undefined}
      className={cn(
        'inline-flex size-9 items-center justify-center transition-colors',
        active ? 'text-emerald-500' : 'text-muted-foreground/40',
      )}
    >
      <ComputerIcon className="size-4" />
    </span>
  );
}
