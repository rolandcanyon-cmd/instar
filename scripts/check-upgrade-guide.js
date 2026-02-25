#!/usr/bin/env node
/**
 * Pre-publish check: validates that EVERY version has an upgrade guide.
 *
 * Every release — patch, minor, or major — must ship with an upgrade guide
 * so agents understand what changed and can relay meaningful context to users.
 *
 * Workflow:
 *   1. Developer writes `upgrades/NEXT.md` alongside their code changes
 *   2. CI bumps version, renames NEXT.md → {version}.md
 *   3. This script verifies the guide exists and is well-formed
 *   4. If no guide → publish is BLOCKED
 *
 * Required sections in every guide:
 *   - "## What Changed" — technical description of the changes
 *   - "## What to Tell Your User" — user-facing summary the agent can relay
 *   - "## Summary of New Capabilities" — concise capability list for MEMORY.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
const version = pkg.version;
const guidePath = path.join(ROOT, 'upgrades', `${version}.md`);
const nextPath = path.join(ROOT, 'upgrades', 'NEXT.md');
const guideExists = fs.existsSync(guidePath);
const nextExists = fs.existsSync(nextPath);

// Required sections for a well-formed guide
const REQUIRED_SECTIONS = [
  '## What Changed',
  '## What to Tell Your User',
  '## Summary of New Capabilities',
];

const MIN_LENGTH = 200;

/**
 * Validate a guide file and return any issues found.
 */
function validateGuide(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const issues = [];

  for (const section of REQUIRED_SECTIONS) {
    if (!content.includes(section)) {
      issues.push(`missing "${section}" section`);
    }
  }

  if (content.length < MIN_LENGTH) {
    issues.push(`guide is too short (${content.length} chars, minimum ${MIN_LENGTH}) — probably incomplete`);
  }

  return issues;
}

// Report
console.log(`\n  Upgrade Guide Check — v${version}`);
console.log(`  ${'─'.repeat(40)}`);
console.log(`  Guide (${version}.md): ${guideExists ? 'YES' : 'NO'}`);
console.log(`  NEXT.md fallback:     ${nextExists ? 'YES' : 'NO'}`);

// Validate all existing guides
const upgradesDir = path.join(ROOT, 'upgrades');
let malformedGuides = [];

if (fs.existsSync(upgradesDir)) {
  const guideFiles = fs.readdirSync(upgradesDir).filter(f => f.endsWith('.md') && f !== 'NEXT.md');
  for (const file of guideFiles) {
    const issues = validateGuide(path.join(upgradesDir, file));
    if (issues.length > 0) {
      malformedGuides.push({ file, issues });
    }
  }
}

if (malformedGuides.length > 0) {
  console.log(`\n  ⚠ Malformed upgrade guides:`);
  for (const { file, issues } of malformedGuides) {
    console.log(`    ${file}: ${issues.join(', ')}`);
  }
}

// Enforce — every version needs a guide
let exitCode = 0;

if (guideExists) {
  // Version-specific guide exists (either pre-existing or renamed from NEXT.md by CI)
  const issues = validateGuide(guidePath);
  if (issues.length > 0) {
    console.log(`\n  ERROR: Guide for v${version} exists but is malformed:`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
    exitCode = 1;
  } else {
    console.log(`\n  ✓ Upgrade guide validated for v${version}.`);
  }
} else if (nextExists) {
  // NEXT.md exists but wasn't renamed — this means CI didn't run the rename step.
  // Validate it anyway so the developer gets feedback.
  console.log(`\n  NOTE: NEXT.md exists but hasn't been renamed to ${version}.md yet.`);
  console.log(`  CI will rename it during publish. Validating content...`);
  const issues = validateGuide(nextPath);
  if (issues.length > 0) {
    console.log(`  ERROR: NEXT.md is malformed:`);
    for (const issue of issues) {
      console.log(`    - ${issue}`);
    }
    exitCode = 1;
  } else {
    console.log(`  ✓ NEXT.md content is valid.`);
  }
} else {
  // No guide at all — block the publish
  console.log(`\n  ERROR: No upgrade guide found for v${version}.`);
  console.log(`  Every release must include an upgrade guide so agents understand what changed.`);
  console.log(`\n  Create: upgrades/NEXT.md`);
  console.log(`  Required sections:`);
  for (const section of REQUIRED_SECTIONS) {
    console.log(`    - ${section}`);
  }
  console.log(`\n  The guide should tell the story of what changed, how it improves the`);
  console.log(`  user's experience, and what it means for the agent. This is how agents`);
  console.log(`  learn about updates and relay meaningful context to their users.`);
  exitCode = 1;
}

console.log('');
process.exit(exitCode);
