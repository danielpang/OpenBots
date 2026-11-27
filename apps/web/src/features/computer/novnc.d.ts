// noVNC ships no types; this is the part of RFB the screen view uses.
declare module '@novnc/novnc' {
  export interface RfbOptions {
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    /** `url`, or a WebSocket already opened (noVNC 1.3 and later). */
    constructor(target: HTMLElement, url: string | WebSocket, options?: RfbOptions);
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    background: string;
    focusOnClick: boolean;
    disconnect(): void;
    focus(options?: FocusOptions): void;
  }
}
