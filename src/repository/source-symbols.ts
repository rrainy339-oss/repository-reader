import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Language, Node, Parser } from '@vscode/tree-sitter-wasm';

export const symbolKinds = ['function', 'class', 'method'] as const;
export type SymbolRecord = {
  id: string;
  name: string;
  kind: typeof symbolKinds[number];
  filePath: string;
  startLine: number;
  endLine: number;
  qualifiedName: string;
  parentSymbolId?: string;
};

type Grammar = 'javascript' | 'typescript' | 'tsx';
export type EntryHint = {
  kind: 'cloud_export' | 'page_handler' | 'cloud_call' | 'network_request';
  name: string;
  startLine: number;
  endLine: number;
  symbolId?: string;
};

const require = createRequire(import.meta.url);
const grammars: Grammar[] = ['javascript', 'typescript', 'tsx'];
let loaded: Promise<{ createParser: () => Parser; languages: Map<Grammar, Language> }> | undefined;

export function grammarFor(path: string): Grammar | undefined {
  if (/\.(?:jsx?|[mc]js)$/i.test(path)) return 'javascript';
  if (/\.tsx$/i.test(path)) return 'tsx';
  if (/\.(?:ts|[mc]ts)$/i.test(path)) return 'typescript';
}

export function stableId(prefix: string, parts: readonly unknown[]) {
  return prefix + '-' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

async function loadGrammars() {
  const { Parser, Language } = require('@vscode/tree-sitter-wasm') as typeof import('@vscode/tree-sitter-wasm');
  await Parser.init();
  const languages = new Map<Grammar, Language>();
  for (const grammar of grammars) {
    const file = require.resolve('@vscode/tree-sitter-wasm/wasm/tree-sitter-' + grammar + '.wasm');
    languages.set(grammar, await Language.load(file));
  }
  return { createParser: () => new Parser(), languages };
}

export async function createSourceParser() {
  const { createParser, languages } = await (loaded ??= loadGrammars());
  const parser = createParser();
  return {
    parse(path: string, grammar: Grammar, text: string) {
      parser.setLanguage(languages.get(grammar)!);
      const tree = parser.parse(text);
      if (!tree) throw new Error('Tree-sitter returned no syntax tree.');
      try {
        if (tree.rootNode.hasError) throw new Error('The source contains syntax errors.');
        return collectDefinitions(path, tree.rootNode);
      } finally {
        tree.delete();
      }
    },
    close() { parser.delete(); },
  };
}

const functionDeclarations = new Set(['function_declaration', 'generator_function_declaration']);
const functionExpressions = new Set(['function_expression', 'generator_function', 'arrow_function']);
const classDeclarations = new Set(['class_declaration', 'abstract_class_declaration']);
const wrappers = new Set(['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression']);
const scopeBlocks = new Set(['statement_block', 'switch_body', 'for_statement', 'for_in_statement', 'catch_clause']);
const cloudExports = new Set(['exports.main', 'module.exports.main', 'module.exports']);

function propertyName(node: Node | null): string | undefined {
  if (!node) return;
  if (['identifier', 'property_identifier', 'private_property_identifier', 'number'].includes(node.type)) return node.text;
  if (node.type === 'string') {
    const fragment = node.namedChild(0);
    if (node.namedChildCount === 1 && fragment?.type === 'string_fragment') return fragment.text;
  }
}

function staticName(node: Node | null): string | undefined {
  if (!node) return;
  if (node.type === 'member_expression' || node.type === 'subscript_expression') {
    const names: string[] = [];
    let current: Node | null = node;
    while (current?.type === 'member_expression' || current?.type === 'subscript_expression') {
      const property = current.type === 'member_expression'
        ? current.childForFieldName('property') : current.childForFieldName('index');
      if (current.type === 'subscript_expression' && property?.type !== 'string' && property?.type !== 'number') return;
      const name = propertyName(property);
      if (!name) return;
      names.push(name);
      current = current.childForFieldName('object');
    }
    const base = current?.type === 'this' ? 'this' : propertyName(current);
    return base === undefined ? undefined : [base, ...names.reverse()].join('.');
  }
  return propertyName(node);
}

function binding(node: Node) {
  let value = node;
  let parent = value.parent;
  while (parent && wrappers.has(parent.type) && parent.namedChild(0)?.id === value.id) {
    value = parent;
    parent = parent.parent;
  }
  if (!parent) return;
  const field = parent.type === 'assignment_expression' ? 'right' : 'value';
  if (parent.childForFieldName(field)?.id !== value.id) return;
  if (parent.type === 'assignment_expression') return { name: staticName(parent.childForFieldName('left')), node: parent };
  if (parent.type === 'pair') return { name: propertyName(parent.childForFieldName('key')), node: parent };
  if (parent.type === 'variable_declarator' || parent.type === 'field_definition' || parent.type === 'public_field_definition') {
    return { name: propertyName(parent.childForFieldName('name') ?? parent.childForFieldName('property')), node: parent };
  }
}

function sourceLines(node: Node) {
  const startLine = node.startPosition.row + 1;
  const end = node.endPosition;
  return { startLine, endLine: Math.max(startLine, end.row + Number(end.column > 0)) };
}

function pageObject(node: Node | null) {
  if (node?.type !== 'object' || node.parent?.type !== 'arguments' || node.parent.namedChild(0)?.id !== node.id) return false;
  const call = node.parent.parent;
  const target = call?.childForFieldName('function');
  return call?.type === 'call_expression' && target?.type === 'identifier' && target.text === 'Page';
}

type Scope = {
  key: string;
  qualifiedName?: string;
  parentSymbolId?: string;
  inFunction?: boolean;
};

function collectDefinitions(filePath: string, root: Node) {
  const symbols: SymbolRecord[] = [];
  const hints: EntryHint[] = [];
  const exportBindings = new Map<number, EntryHint>();
  const occurrences = new Map<string, number>();
  const stack: { node: Node; scope: Scope }[] = [{ node: root, scope: { key: '' } }];

  function scopedId(prefix: string, scope: Scope, kind: string, name: string) {
    const key = JSON.stringify([scope.key, kind, name]);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    return stableId(prefix, [filePath, key, occurrence]);
  }

  while (stack.length) {
    let { node, scope } = stack.pop()!;
    const type = node.type;
    let kind: SymbolRecord['kind'] | undefined;
    let name: string | undefined;
    let location = node;
    let bound: ReturnType<typeof binding>;

    if (functionDeclarations.has(type) || classDeclarations.has(type) || type === 'method_definition') {
      kind = type === 'method_definition' ? 'method' : classDeclarations.has(type) ? 'class' : 'function';
      const declared = node.childForFieldName('name');
      name = declared?.type === 'type_identifier' ? declared.text : propertyName(declared);
    } else if (functionExpressions.has(type) || type === 'class') {
      bound = binding(node);
      kind = type === 'class' ? 'class' : bound?.node.type === 'pair' ? 'method' : 'function';
      name = bound?.name ?? propertyName(node.childForFieldName('name'));
      if (!name && type === 'class' && node.childForFieldName('name')?.type === 'type_identifier') {
        name = node.childForFieldName('name')!.text;
      }
      if (bound?.name) location = bound.node;
    }

    if (kind && name) {
      const id = scopedId('sym', scope, kind, name);
      const qualifiedName = scope.qualifiedName ? scope.qualifiedName + '.' + name : name;
      const symbol = { id, name, kind, filePath, qualifiedName, ...sourceLines(location),
        ...(scope.parentSymbolId ? { parentSymbolId: scope.parentSymbolId } : {}) };
      symbols.push(symbol);
      const exportHint = bound && exportBindings.get(bound.node.id);
      if (exportHint) exportHint.symbolId = id;
      const object = node.type === 'method_definition' ? node.parent : bound?.node.parent;
      if (object && pageObject(object)) hints.push({ kind: 'page_handler', name, ...sourceLines(location), symbolId: id });
      if (name === 'main' && kind === 'method' && object?.type === 'object' && binding(object)?.name === 'module.exports'
        && !scope.inFunction && !scope.parentSymbolId) {
        hints.push({ kind: 'cloud_export', name: 'module.exports.main', ...sourceLines(location), symbolId: id });
      }
      scope = { key: id, qualifiedName, parentSymbolId: id, inFunction: scope.inFunction || kind !== 'class' };
    } else if (kind || scopeBlocks.has(type)) {
      scope = { ...scope, key: scopedId('scope', scope, type, ''),
        inFunction: scope.inFunction || kind === 'function' || kind === 'method' };
    } else if (type === 'object') {
      const owner = binding(node)?.name ?? (pageObject(node) ? 'Page' : undefined);
      if (owner) {
        const qualifiedName = scope.qualifiedName ? scope.qualifiedName + '.' + owner : owner;
        scope = { ...scope, qualifiedName, key: scopedId('scope', scope, type, owner) };
      }
    } else if (type === 'assignment_expression' && !scope.inFunction && !scope.parentSymbolId) {
      const exportName = staticName(node.childForFieldName('left'));
      const right = node.childForFieldName('right');
      if (exportName && cloudExports.has(exportName) && right
        && (exportName !== 'module.exports' || functionExpressions.has(right.type) || wrappers.has(right.type))) {
        const hint: EntryHint = { kind: 'cloud_export', name: exportName, ...sourceLines(node) };
        hints.push(hint);
        exportBindings.set(node.id, hint);
      }
    } else if (type === 'call_expression') {
      const called = staticName(node.childForFieldName('function'));
      if (called === 'wx.cloud.callFunction' || called === 'wx.request') {
        hints.push({ kind: called === 'wx.request' ? 'network_request' : 'cloud_call', name: called, ...sourceLines(node) });
      }
    }

    for (const child of node.namedChildren.reverse()) {
      if (child) stack.push({ node: child, scope });
    }
  }

  return { symbols, hints };
}
