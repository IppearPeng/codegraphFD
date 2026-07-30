/**
 * D language extraction configuration.
 *
 * Grammar: gdamore/tree-sitter-d v0.9.1
 * (commit 64f27931b4e6fdd75af1102c79bacbca68a8dacc).
 *
 * The grammar intentionally exposes very few named fields, so the hooks below
 * read direct children instead of relying on name/body fields. The generic
 * extractor still owns declaration walking, scope creation, call extraction,
 * and edge attribution; only D's multi-import shape needs a custom visitor.
 */

import { Node as SyntaxNode } from 'web-tree-sitter';
import type {
  ExtractorContext,
  LanguageExtractor,
  VariableInfo,
} from '../tree-sitter-types';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';

export const D_BUILTIN_TYPES = new Set([
  'void', 'bool', 'byte', 'ubyte', 'short', 'ushort', 'int', 'uint', 'long',
  'ulong', 'cent', 'ucent', 'char', 'wchar', 'dchar', 'float', 'double',
  'real', 'ifloat', 'idouble', 'ireal', 'cfloat', 'cdouble', 'creal',
  'size_t', 'ptrdiff_t', 'string', 'wstring', 'dstring', 'noreturn',
]);

function directChild(node: SyntaxNode, type: string): SyntaxNode | null {
  return node.namedChildren.find((child: SyntaxNode) => child.type === type) ?? null;
}

function firstIdentifier(node: SyntaxNode): SyntaxNode | null {
  if (node.type === 'identifier') return node;
  for (const child of node.namedChildren) {
    const found = firstIdentifier(child);
    if (found) return found;
  }
  return null;
}

function directIdentifier(node: SyntaxNode): SyntaxNode | null {
  return directChild(node, 'identifier');
}

function compact(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function declarationName(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'constructor') return 'this';
  if (node.type === 'destructor') return '~this';
  if (node.type === 'unittest_declaration') {
    return `unittest@${node.startPosition.row + 1}`;
  }
  if (node.type === 'invariant_declaration') return 'invariant';

  if (node.type === 'alias_declaration') {
    const initializer = directChild(node, 'alias_initializer');
    const id = initializer ? firstIdentifier(initializer) : null;
    return id ? getNodeText(id, source) : undefined;
  }

  const id = directIdentifier(node);
  return id ? getNodeText(id, source) : undefined;
}

function declarationBody(node: SyntaxNode): SyntaxNode | null {
  const body =
    directChild(node, 'aggregate_body') ??
    directChild(node, 'function_body');
  if (body) return body;

  // D templates and enums place declarations/members directly on the
  // declaration node rather than under a named body field.
  if (node.type === 'template_declaration' || node.type === 'enum_declaration') {
    return node;
  }
  return null;
}

function declarationSignature(node: SyntaxNode, source: string): string | undefined {
  const body = declarationBody(node);
  const end = body && body !== node ? body.startIndex : node.endIndex;
  const signature = compact(source.substring(node.startIndex, end));
  return signature || undefined;
}

function visibilityOf(
  node: SyntaxNode
): 'public' | 'private' | 'protected' | 'internal' | undefined {
  for (const child of node.namedChildren) {
    if (child.type === 'public' || child.type === 'export') return 'public';
    if (child.type === 'private') return 'private';
    if (child.type === 'protected') return 'protected';
    if (child.type === 'package') return 'internal';
  }
  return undefined;
}

function containsModifier(node: SyntaxNode, modifier: string): boolean {
  if (node.namedChildren.some((child: SyntaxNode) => child.type === modifier)) return true;
  const storage = directChild(node, 'storage_class');
  return !!storage && storage.namedChildren.some((child: SyntaxNode) => child.type === modifier);
}

function simpleTypeName(node: SyntaxNode, source: string): string | undefined {
  const identifiers: SyntaxNode[] = [];
  const collect = (current: SyntaxNode): void => {
    if (current.type === 'identifier') identifiers.push(current);
    for (const child of current.namedChildren) collect(child);
  };
  collect(node);
  const last = identifiers[identifiers.length - 1];
  if (!last) return undefined;
  const name = getNodeText(last, source);
  return D_BUILTIN_TYPES.has(name) ? undefined : name;
}

function returnTypeOf(node: SyntaxNode, source: string): string | undefined {
  if (node.type === 'constructor' || node.type === 'destructor') return undefined;
  const type = directChild(node, 'type');
  return type ? simpleTypeName(type, source) : undefined;
}

function variablesFrom(node: SyntaxNode, source: string): VariableInfo[] {
  if (node.type === 'manifest_constant') {
    return node.namedChildren
      .filter((child: SyntaxNode) => child.type === 'manifest_declarator')
      .flatMap((declarator: SyntaxNode) => {
        const id = firstIdentifier(declarator);
        return id
          ? [{
              name: getNodeText(id, source),
              kind: 'constant' as const,
              signature: compact(getNodeText(node, source)),
              positionNode: id,
            }]
          : [];
      });
  }

  const raw = getNodeText(node, source);
  const isConstant = /\b(?:const|immutable)\b/.test(raw);
  return node.namedChildren
    .filter(
      (child: SyntaxNode) =>
        child.type === 'declarator' || child.type === 'bitfield_declarator'
    )
    .flatMap((declarator: SyntaxNode) => {
      const id = firstIdentifier(declarator);
      return id
        ? [{
            name: getNodeText(id, source),
            kind: isConstant ? ('constant' as const) : ('variable' as const),
            signature: compact(getNodeText(node, source)),
            positionNode: id,
          }]
        : [];
    });
}

function moduleNameFromImported(imported: SyntaxNode, source: string): string | null {
  const fqn = directChild(imported, 'module_fqn');
  return fqn ? getNodeText(fqn, source).trim() : null;
}

function handleImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const signature = compact(getNodeText(node, ctx.source));
  const importedNodes = node.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'imported'
  );

  let lastModule: string | null = null;
  for (const imported of importedNodes) {
    const moduleName = moduleNameFromImported(imported, ctx.source);
    if (!moduleName) continue;
    lastModule = moduleName;
    const aliasNode = getChildByField(imported, 'alias');
    const localName = aliasNode
      ? getNodeText(aliasNode, ctx.source)
      : moduleName.split('.').pop()!;

    ctx.createNode('import', moduleName, imported, { signature });
    if (parentId && localName) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: imported.startPosition.row + 1,
        column: imported.startPosition.column,
      });
    }
  }

  // `import app.model : User, Local = Person;` binds individual symbols from
  // the final module. Import mappings in the resolver preserve the alias; these
  // refs ensure even an imported-but-not-called symbol records a dependency.
  if (parentId && lastModule) {
    for (const bind of node.namedChildren.filter(
      (child: SyntaxNode) => child.type === 'import_bind'
    )) {
      const ids = bind.namedChildren.filter(
        (child: SyntaxNode) => child.type === 'identifier'
      );
      const local = ids[0];
      if (!local) continue;
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: getNodeText(local, ctx.source),
        referenceKind: 'references',
        line: local.startPosition.row + 1,
        column: local.startPosition.column,
      });
    }
  }

  return true;
}

function handleAnonymousEnum(node: SyntaxNode, ctx: ExtractorContext): boolean {
  for (const member of node.namedChildren.filter(
    (child: SyntaxNode) => child.type === 'anonymous_enum_member'
  )) {
    const id = firstIdentifier(member);
    if (id) {
      ctx.createNode('constant', getNodeText(id, ctx.source), member, {
        signature: compact(getNodeText(member, ctx.source)),
      });
    }
  }
  return true;
}

export const dExtractor: LanguageExtractor = {
  functionTypes: ['function_declaration', 'unittest_declaration'],
  classTypes: ['class_declaration', 'template_declaration'],
  methodTypes: [
    'function_declaration',
    'constructor',
    'destructor',
    'invariant_declaration',
    'unittest_declaration',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration', 'union_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: ['alias_declaration'],
  importTypes: [],
  callTypes: ['call_expression'],
  variableTypes: ['variable_declaration', 'manifest_constant'],
  fieldTypes: ['variable_declaration', 'manifest_constant'],

  // The grammar has no fields for these declarations; hooks use direct AST
  // children and keep these names only as generic fallbacks.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',

  resolveName: declarationName,
  resolveBody: declarationBody,
  extractVariables: variablesFrom,
  getSignature: declarationSignature,
  getVisibility: visibilityOf,
  isExported: (node) => {
    const visibility = visibilityOf(node);
    return visibility !== 'private' && visibility !== 'protected' && visibility !== 'internal';
  },
  isAsync: () => false,
  isStatic: (node) => containsModifier(node, 'static'),
  isConst: (node) => /\b(?:const|immutable|enum)\b/.test(node.text),
  getReturnType: returnTypeOf,

  packageTypes: ['module_def'],
  extractPackage: (node, source) => {
    const declaration = directChild(node, 'module_declaration');
    const fqn = declaration ? directChild(declaration, 'module_fqn') : null;
    return fqn ? getNodeText(fqn, source).trim() : null;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'import_declaration') return handleImport(node, ctx);
    if (node.type === 'anonymous_enum_declaration') return handleAnonymousEnum(node, ctx);
    return false;
  },
};
