// Minimal ESM load hook: transpiles .ts/.tsx with the project's TypeScript so node:test can import app modules.
// (The distro Node build ships without built-in type stripping.)
import ts from 'typescript'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function load (url, context, nextLoad) {
  if (/\.tsx?$/.test(url) && url.startsWith('file:')) {
    const source = fs.readFileSync(fileURLToPath(url), 'utf8')
    const { outputText } = ts.transpileModule(source, {
      fileName: fileURLToPath(url),
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, rewriteRelativeImportExtensions: false }
    })
    return { format: 'module', source: outputText, shortCircuit: true }
  }
  return nextLoad(url, context)
}
