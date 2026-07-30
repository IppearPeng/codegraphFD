import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { extractFromSource, scanDirectory } from '../src/extraction';
import {
  detectLanguage,
  getSupportedLanguages,
  initGrammars,
  isLanguageSupported,
  isSourceFile,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['d']);
});

describe('D language support', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-d-'));
    tempDirs.push(dir);
    return dir;
  };

  const write = (root: string, relative: string, source: string): void => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  };

  it('detects .d and .di files and reports D as supported', () => {
    expect(detectLanguage('source/app.d')).toBe('d');
    expect(detectLanguage('source/app.di')).toBe('d');
    expect(isSourceFile('source/app.d')).toBe(true);
    expect(isSourceFile('source/app.di')).toBe(true);
    expect(isLanguageSupported('d')).toBe(true);
    expect(getSupportedLanguages()).toContain('d');
  });

  it('extracts D modules, declarations, members, templates, calls, and construction', () => {
    const source = `
module app.service;

import std.stdio;
import log = app.logging;
import app.model : User, PersonAlias = Person;

alias Id = long;
enum Status : int { ready = 1, running }
enum MAX_RETRIES = 3;

interface Repository {
    User find(Id id);
}

class BaseService {
    protected void audit() { writeln("audit"); }
}

class UserService : BaseService, Repository {
    private int count = 0;
    static int sharedCount;
    enum DEFAULT_LIMIT = 10;

    this(int initial) { count = initial; }
    ~this() { cleanup(); }

    override User find(Id id) {
        auto model = new User(id);
        model.save();
        audit();
        return model;
    }
}

struct Point { double x; double y; }
union Value { int integer; double floating; }

template Box(T) {
    T value;
    T get() { return value; }
}

mixin template Timestamped() { long updatedAt; }

void topLevel() {
    auto service = new UserService(1);
    service.find(1);
}

immutable string APP_NAME = "demo";
int globalCount;
`;
    const result = extractFromSource('source/app/service.d', source);
    const names = (kind: string): string[] =>
      result.nodes.filter((node) => node.kind === kind).map((node) => node.name);

    expect(names('namespace')).toContain('app.service');
    expect(names('class')).toEqual(
      expect.arrayContaining(['BaseService', 'UserService', 'Box', 'Timestamped'])
    );
    expect(names('interface')).toContain('Repository');
    expect(names('struct')).toEqual(expect.arrayContaining(['Point', 'Value']));
    expect(names('enum')).toContain('Status');
    expect(names('enum_member')).toEqual(expect.arrayContaining(['ready', 'running']));
    expect(names('type_alias')).toContain('Id');
    expect(names('function')).toContain('topLevel');
    expect(names('method')).toEqual(
      expect.arrayContaining(['audit', 'this', '~this', 'find', 'get'])
    );
    expect(names('field')).toEqual(
      expect.arrayContaining([
        'count',
        'sharedCount',
        'x',
        'y',
        'integer',
        'floating',
        'value',
        'updatedAt',
      ])
    );
    expect(names('constant')).toEqual(
      expect.arrayContaining(['MAX_RETRIES', 'DEFAULT_LIMIT', 'APP_NAME'])
    );
    expect(names('variable')).toContain('globalCount');

    const namespace = result.nodes.find(
      (node) => node.kind === 'namespace' && node.name === 'app.service'
    );
    const find = result.nodes.find(
      (node) => node.kind === 'method' && node.qualifiedName.endsWith('UserService::find')
    );
    const sharedCount = result.nodes.find(
      (node) => node.kind === 'field' && node.name === 'sharedCount'
    );
    expect(namespace?.qualifiedName).toBe('app.service');
    expect(find?.qualifiedName).toBe('app.service::UserService::find');
    expect(find?.returnType).toBe('User');
    expect(sharedCount?.isStatic).toBe(true);

    const refs = result.unresolvedReferences ?? [];
    const refsOf = (kind: string): string[] =>
      refs.filter((ref) => ref.referenceKind === kind).map((ref) => ref.referenceName);
    expect(refsOf('imports')).toEqual(
      expect.arrayContaining(['std.stdio', 'app.logging', 'app.model'])
    );
    expect(refsOf('extends')).toEqual(
      expect.arrayContaining(['BaseService', 'Repository'])
    );
    expect(refsOf('calls')).toEqual(
      expect.arrayContaining(['writeln', 'cleanup', 'model.save', 'audit', 'service.find'])
    );
    expect(refsOf('instantiates')).toEqual(
      expect.arrayContaining(['User', 'UserService'])
    );
    expect(refsOf('references')).toEqual(
      expect.arrayContaining(['User', 'PersonAlias', 'Id'])
    );

    // A D constructor is an outer call_expression wrapping new_expression.
    // It must produce one instantiation ref and no bogus `calls: new User`.
    expect(
      refs.filter(
        (ref) => ref.referenceKind === 'instantiates' && ref.referenceName === 'User'
      )
    ).toHaveLength(1);
    expect(
      refs.some(
        (ref) => ref.referenceKind === 'calls' && /\bnew\s+User\b/.test(ref.referenceName)
      )
    ).toBe(false);
  });

  it('parses .di interface files and degrades safely on partial syntax', () => {
    const interfaceResult = extractFromSource(
      'source/app/model.di',
      `
module app.model;
class User {
    this(long id);
    void save();
}
`
    );
    expect(
      interfaceResult.nodes.some(
        (node) => node.language === 'd' && node.kind === 'class' && node.name === 'User'
      )
    ).toBe(true);
    expect(interfaceResult.nodes.some((node) => node.kind === 'method' && node.name === 'save')).toBe(true);

    expect(() =>
      extractFromSource('broken.d', 'module broken; class Broken { void run( {')
    ).not.toThrow();
    const partial = extractFromSource(
      'broken.d',
      'module broken; class Broken { void run( {'
    );
    expect(partial.nodes.some((node) => node.kind === 'file')).toBe(true);
  });

  it('resolves D module aliases, selective imports, .di symbols, receiver calls, and inheritance', async () => {
    const root = makeTempDir();
    write(
      root,
      'source/app/model.di',
      `
module app.model;
class User {
    this(long id);
    void save();
}
class Person {}
`
    );
    write(
      root,
      'source/app/logging.d',
      `
module app.logging;
void info() {}
`
    );
    write(
      root,
      'source/app/service.d',
      `
module app.service;
import log = app.logging;
import app.model : User, PersonAlias = Person;

interface Repository { User find(long id); }
class BaseService {}
class UserService : BaseService, Repository {
    override User find(long id) {
        auto model = new User(id);
        model.save();
        return model;
    }
}
void topLevel() {
    auto service = new UserService();
    service.find(1);
    log.info();
}
`
    );

    const graph = await CodeGraph.init(root, { silent: true });
    await graph.indexAll();
    const db = (graph as any).db.db;
    const edges = db.prepare(`
      SELECT s.name AS source_name, s.file_path AS source_file, e.kind,
             t.name AS target_name, t.file_path AS target_file
      FROM edges e
      JOIN nodes s ON s.id = e.source
      JOIN nodes t ON t.id = e.target
    `).all() as Array<{
      source_name: string;
      source_file: string;
      kind: string;
      target_name: string;
      target_file: string;
    }>;
    graph.close?.();

    const hasEdge = (
      source: string,
      kind: string,
      target: string,
      targetFile?: string
    ): boolean =>
      edges.some(
        (edge) =>
          edge.source_name === source &&
          edge.kind === kind &&
          edge.target_name === target &&
          (!targetFile || edge.target_file === targetFile)
      );

    expect(hasEdge('app.service', 'imports', 'logging.d', 'source/app/logging.d')).toBe(true);
    expect(hasEdge('app.service', 'imports', 'model.di', 'source/app/model.di')).toBe(true);
    expect(hasEdge('app.service', 'references', 'User', 'source/app/model.di')).toBe(true);
    expect(hasEdge('app.service', 'references', 'Person', 'source/app/model.di')).toBe(true);
    expect(hasEdge('UserService', 'extends', 'BaseService')).toBe(true);
    expect(hasEdge('UserService', 'implements', 'Repository')).toBe(true);
    expect(hasEdge('find', 'instantiates', 'User', 'source/app/model.di')).toBe(true);
    expect(hasEdge('find', 'calls', 'save', 'source/app/model.di')).toBe(true);
    expect(hasEdge('topLevel', 'instantiates', 'UserService')).toBe(true);
    expect(hasEdge('topLevel', 'calls', 'find')).toBe(true);
    expect(hasEdge('topLevel', 'calls', 'info', 'source/app/logging.d')).toBe(true);
  });

  it('prefers .d implementations over .di and package module fallbacks', async () => {
    const root = makeTempDir();
    write(
      root,
      'source/app/main.d',
      `
module app.main;
import app.model;
`
    );
    write(root, 'source/app/model.d', 'module app.model; class Implementation {}');
    write(root, 'app/model.di', 'module app.model; class InterfaceOnly {}');
    write(root, 'app/model/package.d', 'module app.model; class PackageFallback {}');

    const graph = await CodeGraph.init(root, { silent: true });
    await graph.indexAll();
    const db = (graph as any).db.db;
    const importTarget = db.prepare(`
      SELECT t.file_path AS target_file
      FROM edges e
      JOIN nodes s ON s.id = e.source
      JOIN nodes t ON t.id = e.target
      WHERE s.name = 'app.main' AND e.kind = 'imports'
      LIMIT 1
    `).get() as { target_file: string } | undefined;
    graph.close?.();

    expect(importTarget?.target_file).toBe('source/app/model.d');
  });

  it('ignores DUB build/cache source under .dub by default', () => {
    const root = makeTempDir();
    write(root, 'source/main.d', 'module main; void main() {}');
    write(root, '.dub/build/generated.d', 'module generated; void generated() {}');

    const files = scanDirectory(root).map((file) => file.replace(/\\/g, '/'));
    expect(files).toContain('source/main.d');
    expect(files).not.toContain('.dub/build/generated.d');
  });
});
