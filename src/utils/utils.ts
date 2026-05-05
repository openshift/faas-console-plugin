import { Language } from '@patternfly/react-code-editor';

const extensionMap: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  go: 'go',
  py: 'python',
  yaml: 'yaml',
  yml: 'yaml',
  json: 'json',
  md: 'markdown',
  sh: 'shell',
  bash: 'shell',
  html: 'html',
  css: 'css',
  xml: 'xml',
  toml: 'plaintext',
  txt: 'plaintext',
};

const filenameMap: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'plaintext',
};

export function getLanguageFromPath(path: string): Language {
  const filename = path.split('/').pop() ?? '';
  if (filenameMap[filename]) return filenameMap[filename] as Language;

  const ext = filename.split('.').pop() ?? '';
  return (extensionMap[ext] as Language) ?? Language.plaintext;
}

export function parseNamespaceAndRuntime(funcYaml: string): {
  namespace: string;
  runtime: string;
} {
  const runtimeMatch = funcYaml.match(/^runtime:\s*(.+)$/m);
  const namespaceMatch = funcYaml.match(/^namespace:\s*(.+)$/m);
  if (!runtimeMatch) throw new Error(`func.yaml missing runtime field`);
  return { namespace: namespaceMatch?.[1]?.trim() ?? '', runtime: runtimeMatch[1].trim() };
}

export const handlerMap: Record<string, string> = {
  node: 'index.js',
  python: 'function/func.py',
  go: 'handle.go',
  quarkus: 'src/main/java/functions/Function.java',
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error && 'status' in err) {
    return `http code: ${err.status}\nmessage: ${err.message}`;
  }

  return err instanceof Error ? err.message : String(err);
}
