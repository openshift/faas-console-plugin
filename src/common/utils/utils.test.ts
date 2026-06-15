import { getLanguageFromPath, parseFuncYaml } from './utils';

describe('getLanguageFromPath', () => {
  it.each([
    ['index.js', 'javascript'],
    ['handler.ts', 'typescript'],
    ['main.go', 'go'],
    ['app.py', 'python'],
    ['func.yaml', 'yaml'],
    ['config.yml', 'yaml'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['Dockerfile', 'dockerfile'],
    ['.gitignore', 'plaintext'],
    ['Makefile', 'plaintext'],
    ['', 'plaintext'],
  ])('returns correct language for %s', (path, expected) => {
    expect(getLanguageFromPath(path)).toBe(expected);
  });
});

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
