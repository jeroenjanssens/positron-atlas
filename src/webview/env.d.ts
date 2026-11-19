/// <reference types="svelte" />
/// <reference types="vite/client" />

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  getState(): any;
  setState(state: any): void;
};
