/**
 * readGrammarWasmBytes + bytes-based grammar loading (#1231, Phase 2.1).
 *
 * The orchestrator pre-reads each needed grammar's WASM once on the main
 * thread and hands the bytes to every parse worker, so a worker respawn loads
 * grammars from memory instead of re-reading them from a (possibly slow) disk.
 * These tests pin that the byte reader resolves the same artifacts the loader
 * would, and that web-tree-sitter genuinely accepts the bytes.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { Parser, Language as WasmLanguage } from 'web-tree-sitter';
import { readGrammarWasmBytes } from '../src/extraction/grammars';

describe('readGrammarWasmBytes', () => {
  it('reads bytes for a tree-sitter-wasms grammar and a vendored grammar', async () => {
    const bytes = await readGrammarWasmBytes(['typescript', 'lua']);
    expect(bytes.typescript).toBeInstanceOf(Uint8Array); // from tree-sitter-wasms
    expect(bytes.typescript.byteLength).toBeGreaterThan(10_000);
    expect(bytes.lua).toBeInstanceOf(Uint8Array); // vendored under src/extraction/wasm/
    expect(bytes.lua.byteLength).toBeGreaterThan(10_000);
  });

  it('expands delegating languages to the grammars they need (svelte → ts/js)', async () => {
    const bytes = await readGrammarWasmBytes(['svelte']);
    expect(Object.keys(bytes).sort()).toEqual(['javascript', 'typescript']);
  });

  it('omits languages without a WASM grammar instead of failing', async () => {
    const bytes = await readGrammarWasmBytes(['yaml', 'unknown']);
    expect(Object.keys(bytes)).toEqual([]);
  });

  it('produces bytes web-tree-sitter can load into a working parser', async () => {
    await Parser.init();
    const bytes = await readGrammarWasmBytes(['javascript']);
    const language = await WasmLanguage.load(bytes.javascript);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('function hello() { return 1; }');
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.toString()).toContain('function_declaration');
  });

  it('loads the pinned vendored D grammar bytes', async () => {
    await Parser.init();
    const bytes = await readGrammarWasmBytes(['d']);
    expect(bytes.d).toBeInstanceOf(Uint8Array);
    expect(
      createHash('sha256').update(bytes.d).digest('hex')
    ).toBe('c5811b0fbefd94ec8f95d78e69ebae4dc7583e75cd34ac16b9600428da80f818');

    const language = await WasmLanguage.load(bytes.d);
    const parser = new Parser();
    parser.setLanguage(language);
    const tree = parser.parse('module app; class Service { void run() {} }');
    expect(tree!.rootNode.hasError).toBe(false);
    expect(tree!.rootNode.toString()).toContain('class_declaration');
  });
});
