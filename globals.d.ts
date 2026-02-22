export {};

declare global {
  interface Window {
    sonacoveElectronAPI?: {
      openExternalLink: (url: string) => void;
      setupRenderer: (api: any, options?: any) => void;
      ipc: {
        on: (channel: string, listener: (event: any, ...args: any[]) => void) => void;
        send: (channel: string, ...args: any[]) => void;
        removeListener: (channel: string, listener: (...args: any[]) => void) => void;
      };
    };
  }
}
