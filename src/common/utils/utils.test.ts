import { parseFuncYaml } from './utils';

describe('parseFuncYaml', () => {
  it('parses name, namespace, and runtime', () => {
    const yaml = 'name: my-function\nruntime: node\nnamespace: demo\n';
    expect(parseFuncYaml(yaml)).toEqual({
      name: 'my-function',
      namespace: 'demo',
      runtime: 'node',
    });
  });

  it('returns empty name when name field is missing', () => {
    const yaml = 'runtime: go\nnamespace: demo\n';
    expect(parseFuncYaml(yaml)).toEqual({
      name: '',
      namespace: 'demo',
      runtime: 'go',
    });
  });

  it('throws when runtime field is missing', () => {
    const yaml = 'name: my-func\nnamespace: demo\n';
    expect(() => parseFuncYaml(yaml)).toThrow('func.yaml missing runtime field');
  });
});
