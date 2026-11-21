import type RFB from '@novnc/novnc';
import { COMPUTER_IDLE_CLOSE_CODE } from '@openbots/shared';
import { Button } from '@openbots/ui';
import { useEffect, useRef, useState } from 'react';
import { vncUrl } from './api.js';
import { useRefreshComputer } from './live.js';

// A Bot's screen through noVNC over the server's `/bots/:id/screen/vnc` proxy
// (plan 9.4). Scaled to fit, never resizing the Bot's display. View-only
// unless the owner has taken the screen over; a dropped connection retries and
// refetches the computer's state, so a computer that went off while this tab
// missed the event shows as off (the proxy never starts it). On a computer
// that sleeps when idle (a Sprite) a still screen's socket closes with
// COMPUTER_IDLE_CLOSE_CODE after a while; that one is not retried on its own,
// so an open tab does not keep the computer awake: Reconnect brings it back.

const RETRY_MS = 2_000;

/** noVNC loads on first use, keeping it out of the main bundle. */
const loadRfb = () => import('@novnc/novnc').then((module) => module.default);

type Phase = 'connecting' | 'connected' | 'disconnected' | 'idle';

export function ScreenView({
  botId,
  viewOnly,
  label,
  control = false,
}: {
  botId: string;
  viewOnly: boolean;
  label: string;
  /** Takeover's view: the server hands the screen back once it closes for good. */
  control?: boolean;
}) {
  const target = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFB | null>(null);
  const [phase, setPhase] = useState<Phase>('connecting');
  const [attempt, setAttempt] = useState(0);
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const refresh = useRefreshComputer();

  useEffect(() => {
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    setPhase('connecting');
    void loadRfb()
      .then((Rfb) => {
        if (cancelled || !target.current) return;
        // Opened here, not by noVNC, so the close code can be read.
        const socket = new WebSocket(vncUrl(botId, control), ['binary']);
        let idle = false;
        socket.addEventListener('close', (event) => {
          idle = event.code === COMPUTER_IDLE_CLOSE_CODE;
        });
        const screen = new Rfb(target.current, socket);
        screen.viewOnly = viewOnlyRef.current;
        screen.scaleViewport = true;
        screen.resizeSession = false;
        screen.background = 'transparent';
        screen.addEventListener('connect', () => setPhase('connected'));
        screen.addEventListener('disconnect', () => {
          rfb.current = null;
          if (cancelled) return;
          if (idle) return setPhase('idle');
          setPhase('disconnected');
          void refresh();
          retry = setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
        });
        rfb.current = screen;
      })
      .catch(() => !cancelled && setPhase('disconnected'));
    return () => {
      cancelled = true;
      clearTimeout(retry);
      rfb.current?.disconnect();
      rfb.current = null;
    };
  }, [botId, control, attempt, refresh]);

  useEffect(() => {
    if (!rfb.current) return;
    rfb.current.viewOnly = viewOnly;
    if (!viewOnly) rfb.current.focus({ preventScroll: true });
  }, [viewOnly, phase]);

  return (
    <div className="relative h-full w-full bg-black/90" data-screen={phase}>
      <div
        ref={target}
        role={viewOnly ? 'img' : 'application'}
        aria-label={label}
        className="h-full w-full [&_canvas]:mx-auto"
      />
      {phase === 'idle' ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-white/70">
          <p>Paused after a while with no activity, so the computer can sleep.</p>
          <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
            Reconnect
          </Button>
        </div>
      ) : (
        phase !== 'connected' && (
          <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-white/70">
            {phase === 'connecting' ? 'Connecting to the screen…' : 'The screen is not reachable.'}
          </p>
        )
      )}
    </div>
  );
}
