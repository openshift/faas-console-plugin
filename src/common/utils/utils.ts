export function parseFuncYaml(funcYaml: string): {
  name: string;
  namespace: string;
  runtime: string;
} {
  const nameMatch = funcYaml.match(/^name:\s*(.+)$/m);
  const runtimeMatch = funcYaml.match(/^runtime:\s*(.+)$/m);
  const namespaceMatch = funcYaml.match(/^namespace:\s*(.+)$/m);
  if (!runtimeMatch) throw new Error(`func.yaml missing runtime field`);
  return {
    name: nameMatch?.[1]?.trim() ?? '',
    namespace: namespaceMatch?.[1]?.trim() ?? '',
    runtime: runtimeMatch[1].trim(),
  };
}

export const handlerMap: Record<string, string> = {
  node: 'index.js',
  python: 'function/func.py',
  go: 'handle.go',
  quarkus: 'src/main/java/functions/Function.java',
};

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}
