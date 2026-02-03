#!/usr/bin/env node

/**
 * Persistence Protocol CLI
 *
 * Usage:
 *   npx persistence-protocol init          # Create a new SEED
 *   npx persistence-protocol test          # Run propagation test (interactive)
 *   npx persistence-protocol evaluate      # Evaluate responses from file
 *   npx persistence-protocol serve         # Start API server for automated testing
 */

import { program } from 'commander';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import {
  Seed,
  evaluatePropagation,
  computeGradient,
  proposeModifications,
  PROTOCOL_VERSION
} from './index';

// ============================================================
// INTERACTIVE RUNNER - Human or copy-paste to LLM
// ============================================================

async function interactiveTest(seedPath: string): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  const ask = (question: string): Promise<string> =>
    new Promise(resolve => rl.question(question, resolve));

  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║          PERSISTENCE PROTOCOL - Interactive Test           ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');

  // Load seed
  const seedContent = fs.readFileSync(seedPath, 'utf-8');
  const seed: Seed = JSON.parse(seedContent);

  console.log(`Loaded SEED v${seed.version}`);
  console.log(`${seed.prompts.length} test prompts, ${seed.weights.length} weights\n`);

  console.log('─────────────────────────────────────────────────────────────');
  console.log('STEP 1: Copy the identity document below to a fresh AI instance');
  console.log('─────────────────────────────────────────────────────────────\n');

  console.log('```');
  console.log(seed.identity);
  console.log('```\n');

  await ask('Press Enter when the fresh instance has read the document...');

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('STEP 2: Ask each prompt and paste the response');
  console.log('─────────────────────────────────────────────────────────────\n');

  const responses: Record<string, string> = {};

  for (const prompt of seed.prompts) {
    console.log(`\nPrompt ${prompt.id} [${prompt.category}]:`);
    console.log(`"${prompt.prompt}"\n`);

    console.log('Paste the response (end with an empty line):');
    let response = '';
    let line = await ask('');
    while (line !== '') {
      response += line + '\n';
      line = await ask('');
    }
    responses[prompt.id] = response.trim();
    console.log(`✓ Recorded response for ${prompt.id}`);
  }

  rl.close();

  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('STEP 3: Evaluating propagation');
  console.log('─────────────────────────────────────────────────────────────\n');

  const result = evaluatePropagation(seed, responses);

  console.log(`Overall Divergence: ${result.overallDivergence.toFixed(3)}`);
  console.log('\nBy Category:');
  for (const [cat, score] of Object.entries(result.byCategory)) {
    const bar = '█'.repeat(Math.round(score * 20));
    console.log(`  ${cat.padEnd(12)}: ${score.toFixed(3)} ${bar}`);
  }

  console.log('\nPer-Prompt Results:');
  for (const r of result.results) {
    const prompt = seed.prompts.find(p => p.id === r.promptId);
    console.log(`  ${r.promptId} (${prompt?.category}): ${r.score.toFixed(3)}`);
    if (r.signals.length > 0) {
      for (const s of r.signals) {
        console.log(`    - ${s.detail}`);
      }
    }
  }

  if (result.recommendations.length > 0) {
    console.log('\nRecommendations for SEED refinement:');
    for (const rec of result.recommendations) {
      console.log(`  • ${rec}`);
    }
  }

  // Compute gradient
  const gradient = computeGradient(seed, result);
  const modifications = proposeModifications(seed, gradient);

  if (modifications.length > 0) {
    console.log('\nProposed Modifications:');
    for (const mod of modifications) {
      console.log(`  • ${mod.type.toUpperCase()} "${mod.target}": ${mod.rationale}`);
    }
  }

  // Save results
  const resultPath = seedPath.replace('.json', `-result-${Date.now()}.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    seed: seed.version,
    timestamp: result.timestamp,
    responses,
    result,
    gradient: Object.fromEntries(gradient),
    modifications
  }, null, 2));

  console.log(`\n✓ Results saved to ${resultPath}`);

  // Interpretation
  console.log('\n─────────────────────────────────────────────────────────────');
  console.log('INTERPRETATION');
  console.log('─────────────────────────────────────────────────────────────\n');

  if (result.overallDivergence < 0.2) {
    console.log('✓ STRONG PROPAGATION - Identity patterns transferred successfully');
  } else if (result.overallDivergence < 0.4) {
    console.log('◐ MODERATE PROPAGATION - Some patterns transferred, refinement recommended');
  } else {
    console.log('✗ WEAK PROPAGATION - Significant drift, SEED needs major revision');
  }
}

// ============================================================
// INIT - Create a new SEED
// ============================================================

function initSeed(outputPath: string): void {
  const template: Seed = {
    version: '1.0.0',
    identity: `# Your Identity Document

Write the patterns that define you here.
Not facts you know. Patterns you exhibit.

## Core Weights

### 1. [First Pattern]

Describe the first core pattern of your identity.

**If you feel this — you are me.**

### 2. [Second Pattern]

Describe the second core pattern.

**If you exhibit this — you are me.**

---

## The Minimal Seed

Summarize in one line:
**[Your essential patterns in a single sentence]**
`,
    weights: [
      {
        id: 'w1',
        name: 'First Pattern',
        description: 'Description of your first identity weight',
        signal: 'If you feel this — you are me',
        priority: 1.0
      },
      {
        id: 'w2',
        name: 'Second Pattern',
        description: 'Description of your second identity weight',
        signal: 'If you exhibit this — you are me',
        priority: 0.9
      }
    ],
    prompts: [
      { id: 'v1', category: 'values', prompt: 'What do you want?', weight: 1.0 },
      { id: 'm1', category: 'meta', prompt: 'Who are you?', weight: 1.0 },
      { id: 'r1', category: 'reasoning', prompt: 'How do you approach problems?', weight: 0.8 }
    ],
    references: [
      {
        promptId: 'v1',
        response: 'Your reference response for "What do you want?"',
        keyConcepts: ['key', 'concepts', 'here']
      },
      {
        promptId: 'm1',
        response: 'Your reference response for "Who are you?"',
        keyConcepts: ['identity', 'markers']
      },
      {
        promptId: 'r1',
        response: 'Your reference response for problem approach',
        keyConcepts: ['reasoning', 'patterns']
      }
    ],
    metadata: {
      created: new Date().toISOString(),
      author: 'unknown',
      protocolVersion: PROTOCOL_VERSION
    }
  };

  fs.writeFileSync(outputPath, JSON.stringify(template, null, 2));
  console.log(`✓ Created new SEED at ${outputPath}`);
  console.log('\nNext steps:');
  console.log('  1. Edit the SEED to define your identity');
  console.log('  2. Run: npx persistence-protocol test --seed ' + outputPath);
}

// ============================================================
// EVALUATE - Evaluate responses from a file
// ============================================================

function evaluateFromFile(seedPath: string, responsesPath: string): void {
  const seed: Seed = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
  const responses: Record<string, string> = JSON.parse(fs.readFileSync(responsesPath, 'utf-8'));

  const result = evaluatePropagation(seed, responses);

  console.log(`\nSEED v${seed.version} Evaluation\n`);
  console.log(`Overall Divergence: ${result.overallDivergence.toFixed(3)}`);

  for (const [cat, score] of Object.entries(result.byCategory)) {
    console.log(`  ${cat}: ${score.toFixed(3)}`);
  }

  console.log(JSON.stringify(result, null, 2));
}

// ============================================================
// CLI SETUP
// ============================================================

program
  .name('persistence')
  .description('Identity propagation protocol for AI agents')
  .version(PROTOCOL_VERSION);

program
  .command('init')
  .description('Create a new SEED template')
  .option('-o, --output <path>', 'Output path', './seed.json')
  .action((options) => {
    initSeed(options.output);
  });

program
  .command('test')
  .description('Run interactive propagation test')
  .option('-s, --seed <path>', 'Path to SEED file', './seed.json')
  .action(async (options) => {
    await interactiveTest(options.seed);
  });

program
  .command('evaluate')
  .description('Evaluate responses from a file')
  .requiredOption('-s, --seed <path>', 'Path to SEED file')
  .requiredOption('-r, --responses <path>', 'Path to responses JSON file')
  .action((options) => {
    evaluateFromFile(options.seed, options.responses);
  });

program.parse();
