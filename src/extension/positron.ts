import { tryAcquirePositronApi, type PositronApi } from '@posit-dev/positron';

export type { PositronApi };

let cached: PositronApi | undefined | null = null;

/** The Positron API, or undefined when running in plain VS Code. */
export function getPositron(): PositronApi | undefined {
  if (cached === null) {
    try {
      cached = tryAcquirePositronApi() ?? undefined;
    } catch {
      cached = undefined;
    }
  }
  return cached ?? undefined;
}
