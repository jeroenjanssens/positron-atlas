import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

// Every command the extension contributes (and binds keys to) must be registered, or
// Positron shows "command '…' not found" when the key is pressed.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const src = readFileSync('src/extension/extension.ts', 'utf8');

describe('contributed commands are registered', () => {
  const contributed: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
  const bound: string[] = pkg.contributes.keybindings.map((k: { command: string }) => k.command);

  it.each([...new Set([...contributed, ...bound])])('%s', (id) => {
    const nav = id.match(/^positronAtlas\.nav\.(.+)$/);
    if (nav) {
      // Navigation commands are registered from a list of action ids.
      expect(src).toContain(`'${nav[1]}'`);
    } else {
      expect(src).toContain(`'${id}'`);
    }
  });

  it('every keybinding targets a contributed command', () => {
    for (const id of bound) expect(contributed).toContain(id);
  });
});
