import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';

const sourceRoot = resolve(process.cwd(), 'src');
const nativeDialogNames = new Set(['prompt', 'confirm', 'alert']);
const nativeDialogObjects = new Set(['window', 'globalThis', 'self']);

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return walk(path);
    if (!/\.(?:ts|tsx)$/u.test(entry) || /\.test\.(?:ts|tsx)$/u.test(entry) || entry === 'routeTree.gen.ts') return [];
    return [path];
  });
}

function locallyBound(expression: ts.Identifier, checker: ts.TypeChecker): boolean {
  const symbol = checker.getSymbolAtLocation(expression);
  return Boolean(symbol?.declarations?.some((declaration) => {
    const sourceFile = declaration.getSourceFile();
    return !sourceFile.isDeclarationFile && resolve(sourceFile.fileName).startsWith(`${sourceRoot}/`);
  }));
}

function nativeDialogName(call: ts.CallExpression, checker?: ts.TypeChecker): string | null {
  const expression = call.expression;
  if (ts.isIdentifier(expression) && nativeDialogNames.has(expression.text)) {
    return checker && locallyBound(expression, checker) ? null : expression.text;
  }
  if (
    ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && nativeDialogObjects.has(expression.expression.text)
    && nativeDialogNames.has(expression.name.text)
  ) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && nativeDialogObjects.has(expression.expression.text)
    && ts.isStringLiteral(expression.argumentExpression)
    && nativeDialogNames.has(expression.argumentExpression.text)
  ) return expression.argumentExpression.text;
  return null;
}

function fixtureNativeDialogs(source: string): string[] {
  const sourceFile = ts.createSourceFile('fixture.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const names: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const name = nativeDialogName(node);
      if (name) names.push(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

describe('native browser dialog policy', () => {
  it('detects every blocking native dialog invocation form', () => {
    const forbiddenCalls = [
      'prompt("title")',
      'confirm("continue?")',
      'alert("failed")',
      'globalThis.prompt("title")',
      'self.confirm("continue?")',
      'window["alert"]("failed")',
    ];

    for (const source of forbiddenCalls) expect(fixtureNativeDialogs(source)).toHaveLength(1);
    expect(fixtureNativeDialogs('artifactTitlePrompt.prompt("title")')).toEqual([]);
  });

  it('uses accessible app dialogs instead of blocking native dialogs', () => {
    const sourcePaths = walk(sourceRoot);
    const program = ts.createProgram(sourcePaths, {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ESNext,
      noEmit: true,
    });
    const checker = program.getTypeChecker();
    const offenders: string[] = [];

    for (const sourceFile of program.getSourceFiles()) {
      const fileName = resolve(sourceFile.fileName);
      if (!fileName.startsWith(`${sourceRoot}/`) || sourceFile.isDeclarationFile) continue;
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const name = nativeDialogName(node, checker);
          if (name) {
            const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
            offenders.push(`${relative(process.cwd(), fileName)}:${pos.line + 1}: ${name}`);
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }

    expect(offenders).toEqual([]);
  });
});
