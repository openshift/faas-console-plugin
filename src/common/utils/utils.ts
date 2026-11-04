export function isSystemNamespace(namespace: string): boolean {
  const SYSTEM_NAMESPACES = ['openshift', 'default'];
  const SYSTEM_NAMESPACE_PREFIXES = ['openshift-', 'kube-', 'knative-'];
  const name = namespace.trim();
  if (!name) return false;
  return (
    SYSTEM_NAMESPACES.includes(name) ||
    SYSTEM_NAMESPACE_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}
