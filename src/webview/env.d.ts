/// <reference types="svelte" />
/// <reference types="vite/client" />

declare module 'embedding-atlas-umap' {
  export * from '../../node_modules/embedding-atlas/dist/umap';
}

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  getState(): any;
  setState(state: any): void;
};
