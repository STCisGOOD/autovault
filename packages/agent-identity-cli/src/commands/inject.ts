/**
 * inject command - Update CLAUDE.md with identity section.
 *
 * Injects or updates the persistent identity section in CLAUDE.md
 * or another specified config file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  loadConfig,
} from '../utils/config';
import {
  sanitizePath,
} from '../utils/security';
import {
  success,
  error,
  info,
  colors,
} from '../utils/display';
import { AgentIdentity } from '../facade/AgentIdentity';

// =============================================================================
// COMMAND DEFINITION
// =============================================================================

export function createInjectCommand(): Command {
  const cmd = new Command('inject')
    .description('Update CLAUDE.md (or other config) with identity section')
    .option('--path <path>', 'Path to config file (default: .claude/CLAUDE.md)')
    .option('--preview', 'Show what would be injected without writing')
    .option('--full', 'Include full intuition (not just summary)')
    .option('--create', 'Create file if it does not exist')
    .action(async (options) => {
      await runInject(options);
    });

  return cmd;
}

// =============================================================================
// INJECT IMPLEMENTATION
// =============================================================================

interface InjectOptions {
  path?: string;
  preview?: boolean;
  full?: boolean;
  create?: boolean;
}

async function runInject(options: InjectOptions): Promise<void> {
  // Validate config exists
  const config = loadConfig();
  if (!config.did) {
    error('No identity found. Run: persistence-identity init');
    process.exit(1);
  }

  // Determine target path
  let targetPath: string;
  if (options.path) {
    try {
      targetPath = sanitizePath(options.path);
    } catch (err) {
      error(`Invalid path: ${err}`);
      process.exit(1);
    }
  } else {
    // Default: .claude/CLAUDE.md in current directory
    targetPath = path.join(process.cwd(), '.claude', 'CLAUDE.md');
  }

  // Check if file exists
  const fileExists = fs.existsSync(targetPath);

  if (!fileExists && !options.create) {
    error(`File not found: ${targetPath}`);
    info(`Use --create to create the file, or specify a different path with --path`);
    process.exit(1);
  }

  // Load identity and generate section
  let agent: AgentIdentity;
  try {
    agent = await AgentIdentity.load({ offline: true });
  } catch (err) {
    error(`Failed to load identity: ${err}`);
    process.exit(1);
  }

  const section = agent.getCLAUDEmdSection();

  // Preview mode
  if (options.preview) {
    console.log('');
    console.log(colors.bold('Preview of identity section:'));
    console.log('');
    console.log(colors.muted('─'.repeat(60)));
    console.log(section);
    console.log(colors.muted('─'.repeat(60)));
    console.log('');
    info(`Would write to: ${targetPath}`);
    return;
  }

  // Ensure directory exists
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  }

  // Read existing content or create new
  let content: string;
  if (fileExists) {
    content = fs.readFileSync(targetPath, 'utf8');

    // Check if section already exists
    if (content.includes('PERSISTENCE-IDENTITY:START')) {
      // Replace existing section
      content = content.replace(
        /<!-- PERSISTENCE-IDENTITY:START[\s\S]*?PERSISTENCE-IDENTITY:END -->/,
        section
      );
      info('Replaced existing identity section');
    } else {
      // Append section at the beginning (after any existing header)
      const lines = content.split('\n');
      let insertIndex = 0;

      // Skip past any initial header (# Title) and blank lines
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('# ')) {
          insertIndex = i + 1;
          // Skip blank lines after header
          while (insertIndex < lines.length && lines[insertIndex].trim() === '') {
            insertIndex++;
          }
          break;
        }
      }

      // Insert section
      lines.splice(insertIndex, 0, '', section, '');
      content = lines.join('\n');
      info('Added identity section to existing file');
    }
  } else {
    // Create new file with just the section
    content = section;
    info('Creating new file with identity section');
  }

  // Write file
  fs.writeFileSync(targetPath, content, { encoding: 'utf8', mode: 0o644 });

  console.log('');
  success(`Updated: ${targetPath}`);
  console.log('');

  // Show summary
  const lineCount = section.split('\n').length;
  console.log(colors.muted(`  Identity section: ${lineCount} lines`));
  console.log(colors.muted(`  DID: ${config.did.slice(0, 40)}...`));
  console.log('');
}

// =============================================================================
// EXPORTS
// =============================================================================

export default createInjectCommand;
