/**
 * hook.test.ts
 *
 * Tests for hook.ts git commit detection and signal generation.
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractGitCommitSHAs, loadGitVerifiedSignal, consumeGitVerifiedSignal } from './hook';

// =============================================================================
// GIT COMMIT SHA DETECTION
// =============================================================================

describe('extractGitCommitSHAs', () => {
  test('detects standard commit', () => {
    const output = '[main abc1234] Fix authentication bug\n 1 file changed, 2 insertions(+)';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['abc1234']);
  });

  test('detects branch commit', () => {
    const output = '[feature/auth abc1234] Add login validation\n 3 files changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['abc1234']);
  });

  test('detects branch with dots', () => {
    const output = '[fix.auth-flow 1a2b3c4] Fix token refresh\n 1 file changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['1a2b3c4']);
  });

  test('detects amend commit (captures new SHA)', () => {
    const output = '[main deadbeef] (amend) Updated commit message\n 1 file changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['deadbeef']);
  });

  test('detects cherry-pick', () => {
    const output = '[main cafe123] Cherry-picked fix\n 2 files changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['cafe123']);
  });

  test('detects full 40-char SHA', () => {
    const sha = 'a'.repeat(40);
    const output = `[main ${sha}] Full hash commit\n 1 file changed`;
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual([sha]);
  });

  test('handles multiple commits', () => {
    const output = [
      '[main abc1234] First commit',
      ' 1 file changed',
      '[main def5678] Second commit',
      ' 2 files changed',
    ].join('\n');
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['abc1234', 'def5678']);
  });

  test('does NOT match merge output', () => {
    const output = "Merge made by the 'ort' strategy.\n 2 files changed";
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual([]);
  });

  test('does NOT match non-git bracket text', () => {
    const output = '[INFO] Build successful\n[WARNING] Deprecated API';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual([]);
  });

  test('handles empty/null input', () => {
    expect(extractGitCommitSHAs('')).toEqual([]);
    expect(extractGitCommitSHAs(null)).toEqual([]);
    expect(extractGitCommitSHAs(undefined)).toEqual([]);
    expect(extractGitCommitSHAs(42)).toEqual([]);
  });

  test('handles object input (like tool_response)', () => {
    const response = {
      exit_code: 0,
      stdout: '[main abc1234] Fix bug\n 1 file changed',
    };
    const shas = extractGitCommitSHAs(response);
    // JSON.stringify of the object should contain the bracket pattern
    expect(shas).toEqual(['abc1234']);
  });

  test('branch name with slashes', () => {
    const output = '[user/jane/refactor 1234567] Refactor module\n 5 files changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual(['1234567']);
  });

  test('rejects SHA shorter than 7 chars', () => {
    const output = '[main abc12] Short hash\n 1 file changed';
    const shas = extractGitCommitSHAs(output);
    expect(shas).toEqual([]);
  });
});

// =============================================================================
// GIT SIGNAL INTEGRATION
// =============================================================================

describe('loadGitVerifiedSignal', () => {
  test('returns null when no verified file exists', () => {
    // By default, git-verified.json shouldn't exist in test environment
    const signal = loadGitVerifiedSignal();
    expect(signal).toBeNull();
  });
});

// =============================================================================
// CONSUME-ON-READ: SIGNAL FILE LIFECYCLE
// =============================================================================

describe('consumeGitVerifiedSignal', () => {
  const tmpDir = path.join(__dirname, '__test_tmp_git_signal__');
  const originalEnv = process.env.PERSISTENCE_IDENTITY_DIR;

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.env.PERSISTENCE_IDENTITY_DIR = tmpDir;
  });

  afterEach(() => {
    // Restore env
    if (originalEnv === undefined) {
      delete process.env.PERSISTENCE_IDENTITY_DIR;
    } else {
      process.env.PERSISTENCE_IDENTITY_DIR = originalEnv;
    }
    // Clean up tmp
    try { fs.rmSync(tmpDir, { recursive: true }); } catch { /* ignore */ }
  });

  test('loadGitVerifiedSignal reads without deleting file', () => {
    const verifiedPath = path.join(tmpDir, 'git-verified.json');
    fs.writeFileSync(verifiedPath, JSON.stringify({
      survivalRate: 1.0,
      survived: ['abc1234'],
      missing: [],
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
    }));

    const signal = loadGitVerifiedSignal();
    expect(signal).not.toBeNull();
    expect(signal!.value).toBe(0.2); // survival → +0.2

    // File should still exist (not consumed yet)
    expect(fs.existsSync(verifiedPath)).toBe(true);
  });

  test('consumeGitVerifiedSignal deletes the file', () => {
    const verifiedPath = path.join(tmpDir, 'git-verified.json');
    fs.writeFileSync(verifiedPath, JSON.stringify({
      survivalRate: 1.0,
      survived: ['abc1234'],
      missing: [],
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
    }));

    expect(fs.existsSync(verifiedPath)).toBe(true);
    consumeGitVerifiedSignal();
    expect(fs.existsSync(verifiedPath)).toBe(false);
  });

  test('consumeGitVerifiedSignal is safe when no file exists', () => {
    // Should not throw
    expect(() => consumeGitVerifiedSignal()).not.toThrow();
  });

  test('empty-but-valid file returns null but still exists for cleanup', () => {
    // Edge case: verified file with no commits to evaluate.
    // loadGitVerifiedSignal returns null, but the file should still
    // be cleaned up by consumeGitVerifiedSignal (called via hadVerifiedFile).
    const verifiedPath = path.join(tmpDir, 'git-verified.json');
    fs.writeFileSync(verifiedPath, JSON.stringify({
      survivalRate: 1.0,
      survived: [],
      missing: [],
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
    }));

    const signal = loadGitVerifiedSignal();
    expect(signal).toBeNull(); // No actionable commits

    // File still exists — loadGitVerifiedSignal does not delete
    expect(fs.existsSync(verifiedPath)).toBe(true);

    // consumeGitVerifiedSignal cleans it up
    consumeGitVerifiedSignal();
    expect(fs.existsSync(verifiedPath)).toBe(false);
  });

  test('file survives if operation between load and consume throws', () => {
    // This simulates the handleSessionEnd orchestration:
    //   1. loadGitVerifiedSignal() — reads file, does NOT delete
    //   2. endObservation()        — may throw
    //   3. consumeGitVerifiedSignal() — deletes file, only reached on success
    //
    // If step 2 throws, step 3 is skipped and the file persists for retry.
    // This is the data-loss fix: the old code deleted in step 1.
    const verifiedPath = path.join(tmpDir, 'git-verified.json');
    fs.writeFileSync(verifiedPath, JSON.stringify({
      survivalRate: 1.0,
      survived: ['abc1234'],
      missing: [],
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
    }));

    const signal = loadGitVerifiedSignal();
    expect(signal).not.toBeNull();

    // Simulate endObservation() failure
    try {
      throw new Error('ARIL backward pass failed');
    } catch {
      // In handleSessionEnd, this catch skips consumeGitVerifiedSignal
    }

    // File must still exist — the signal is preserved for the next session
    expect(fs.existsSync(verifiedPath)).toBe(true);
  });

  test('file is deleted when full orchestration succeeds', () => {
    // Happy path: load → succeed → consume
    const verifiedPath = path.join(tmpDir, 'git-verified.json');
    fs.writeFileSync(verifiedPath, JSON.stringify({
      survivalRate: 0.5,
      survived: ['abc1234'],
      missing: ['def5678'],
      sessionId: 'test-session',
      timestamp: new Date().toISOString(),
    }));

    const hadVerifiedFile = fs.existsSync(verifiedPath);
    const signal = loadGitVerifiedSignal();
    expect(signal).not.toBeNull();

    // Simulate successful endObservation() — no throw
    // ... (backward pass runs, succeeds)

    // Consume only after success, gated on hadVerifiedFile
    if (hadVerifiedFile) {
      consumeGitVerifiedSignal();
    }

    expect(fs.existsSync(verifiedPath)).toBe(false);
  });
});
