export {};

declare global {
  interface Window {
    sonacoveElectronAPI?: {
      openExternalLink: (url: string) => void;
      setupRenderer: (api: any, options?: any) => void;
      analytics: {
        capture: (event: string, properties?: Record<string, any>) => void;
      };
      ipc: {
        on: (channel: string, listener: (...args: any[]) => void) => () => void;
        addListener: (channel: string, listener: (...args: any[]) => void) => () => void;
        send: (channel: string, ...args: any[]) => void;
      };
    };
  }
}
