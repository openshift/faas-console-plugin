import { isSystemNamespace } from './utils';

describe('isSystemNamespace', () => {
  it.each([
    ['default', true],
    ['openshift', true],
    ['kube-system', true],
    ['kube-public', true],
    ['kube-node-lease', true],
    ['openshift-monitoring', true],
    ['openshift-image-registry', true],
    ['kube-anything', true],
    ['knative-serving', true],
    ['my-functions', false],
    ['demo', false],
    ['', false],
    ['   ', false],
  ])('returns %s -> %s', (namespace, expected) => {
    expect(isSystemNamespace(namespace)).toBe(expected);
  });
});
