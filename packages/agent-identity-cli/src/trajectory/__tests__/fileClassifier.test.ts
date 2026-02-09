import { classifyFileRole, classifyPackage, clearPackageCache } from '../fileClassifier';

beforeEach(() => {
  clearPackageCache();
});

describe('classifyFileRole', () => {
  it('.test.ts → test', () => {
    expect(classifyFileRole('/src/foo.test.ts')).toBe('test');
  });

  it('.spec.js → test', () => {
    expect(classifyFileRole('/src/bar.spec.js')).toBe('test');
  });

  it('__tests__/ directory → test', () => {
    expect(classifyFileRole('/src/__tests__/foo.ts')).toBe('test');
  });

  it('test/ directory → test', () => {
    expect(classifyFileRole('/test/integration.ts')).toBe('test');
  });

  it('package.json → config', () => {
    expect(classifyFileRole('/packages/cli/package.json')).toBe('config');
  });

  it('tsconfig.json → config', () => {
    expect(classifyFileRole('/tsconfig.json')).toBe('config');
  });

  it('.config. file → config', () => {
    expect(classifyFileRole('/jest.config.js')).toBe('config');
  });

  it('normal .ts → source', () => {
    expect(classifyFileRole('/src/index.ts')).toBe('source');
  });

  it('Windows backslash paths normalized', () => {
    expect(classifyFileRole('C:\\src\\__tests__\\foo.ts')).toBe('test');
    expect(classifyFileRole('C:\\src\\index.ts')).toBe('source');
  });
});

describe('classifyPackage', () => {
  const roots = [
    '/project/packages/agent-identity/',
    '/project/packages/agent-identity-cli/',
  ];

  it('matches correct package root', () => {
    expect(classifyPackage('/project/packages/agent-identity/src/index.ts', roots))
      .toBe('agent-identity');
    expect(classifyPackage('/project/packages/agent-identity-cli/src/hook.ts', roots))
      .toBe('agent-identity-cli');
  });

  it('returns null for unrecognized path', () => {
    expect(classifyPackage('/other/path/file.ts', roots)).toBeNull();
  });

  it('returns null for empty roots', () => {
    expect(classifyPackage('/any/path.ts', [])).toBeNull();
  });

  it('longest match wins (most specific)', () => {
    // agent-identity-cli/ is longer than agent-identity/
    expect(classifyPackage('/project/packages/agent-identity-cli/src/test.ts', roots))
      .toBe('agent-identity-cli');
  });
});
