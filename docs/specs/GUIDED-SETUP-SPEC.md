# Guided Setup Spec: Scenario-Aware Installation

> Tightly integrates the topology scenario matrix into the setup wizard so users are guided through the right setup path without being overwhelmed.

**Status**: Draft v2 (post-review)
**Author**: Dawn (with Justin's direction)
**Date**: 2026-03-03
**Related specs**: USER-AGENT-TOPOLOGY-SPEC.md, MULTI-USER-SETUP-SPEC.md, MULTI-MACHINE-SPEC.md
**Review history**: 11-reviewer analysis (8 internal specreview + 3 external crossreview). See [Review History](#review-history).

---

## Problem

The setup wizard and the 9-scenario topology matrix exist as separate artifacts. The wizard routes by **entry point** (existing agent? restore? fresh install?) but doesn't explicitly route by **scenario**. The result:

1. Users might not get the right defaults for their situation
2. Multi-machine and multi-user setup options aren't surfaced at the right moment
3. GitHub scanning only checks personal repos, missing organization-owned agents
4. The wizard doesn't infer which scenario the user is in from available context clues

## Design Principles

1. **Infer before asking.** Auto-detect everything possible from the environment before asking the user anything.
2. **Ask targeted questions, not abstract ones.** Never "What scenario are you in?" -- instead "Will other people use this agent too?"
3. **One question at a time.** Each question narrows the scenario. Don't frontload all questions.
4. **Context clues > explicit config.** If we're inside a git repo, we know it's a project-bound agent. If there's an existing agent with 2 machines paired, we know it's multi-machine. Don't re-ask.
5. **The user never sees the matrix.** They experience a guided conversation. The matrix is the wizard's internal routing table.
6. **Comprehensive discovery.** Before any fresh install, exhaustively check for existing agents the user might want to restore or join.
7. **Never auto-install system software.** If a dependency is missing, inform the user and degrade gracefully. Never run `brew install` or `apt install` without explicit user consent.
8. **Validate external state.** Never trust data from GitHub repos, backup files, or registry entries without validation. Display summaries and require user confirmation for restore operations.
9. **Treat discovery data as untrusted.** Repo names, org names, and URLs from GitHub are attacker-controllable. Sanitize before passing to the LLM wizard.

---

## Part 1: Comprehensive Agent Discovery

Before the wizard can route correctly, it needs a complete picture of what agents already exist. The current scanning is incomplete -- it only checks personal GitHub repos.

### Discovery Sources (Priority Order)

| Source | What it finds | How |
|--------|--------------|-----|
| **Local filesystem** | Agents on this machine | Scan `~/.instar/agents/*/` + check CWD for `.instar/` |
| **Local registry** | All registered agents (running or stopped) | Read `~/.instar/registry.json`, validate each entry's path exists |
| **GitHub personal repos** | Cloud-backed agents owned by user | `gh api` with pagination, filter `instar-*` prefix |
| **GitHub org repos** | Cloud-backed agents in user's orgs | Parallel scan per org (with consent), filter `instar-*` prefix |

### Registry Validation

Before using `registry.json` entries, validate each one against the filesystem:

```
for each entry in registry.json:
  if entry.path does not exist on disk:
    mark as "zombie" -- registry points to deleted agent
    exclude from discovery results
    add to cleanup recommendations
  if entry.path exists but is outside expected directories:
    reject -- path traversal protection
    allowed: ~/.instar/agents/*, CWD/.instar/
```

This prevents "zombie" registry entries (pointing to deleted folders) from corrupting scenario routing.

### GitHub Scanning Algorithm

```
function scanGitHub():
  if gh not installed:
    display: "GitHub CLI (gh) not found. Install it to discover cloud-backed agents:"
    display: "  https://cli.github.com/"
    display: "Continuing without GitHub discovery..."
    return { status: 'unavailable', agents: [], manual: true }

  if gh not authenticated:
    display: "GitHub CLI not authenticated. Run 'gh auth login' to enable agent discovery."
    return { status: 'auth-needed', agents: [] }

  // Consent step before org enumeration
  display: "To find your existing agents, I'll scan your GitHub repos and organizations."
  display: "This checks repo names only -- no code is read or downloaded."
  confirm: "Proceed with GitHub scan?"
  if declined: return { status: 'declined', agents: [] }

  agents = []

  // 1. Personal repos (paginated)
  personal = gh api user/repos --paginate --jq
    filter: name starts with 'instar-'
    fields: name, full_name, clone_url, ssh_url

  // 2. Organizations (paginated, capped, parallel)
  orgs = gh api user/orgs --paginate --jq '.[].login'
  if orgs.length > MAX_ORGS (10):
    display first 10 org names
    display: "You belong to {N} organizations. Scanning the first 10."
    display: "Run 'instar scan --all-orgs' to scan all."
    orgs = orgs.slice(0, MAX_ORGS)

  // Parallel scan with concurrency cap and global timeout
  orgResults = await Promise.allSettled(
    orgs.map(org => scanOrgRepos(org)),
    { concurrency: 5, globalTimeout: 15_000 }
  )

  // Collect results, note failures
  for each result in orgResults:
    if fulfilled: agents += result.agents
    if rejected: errors += "Org '{org}': {reason}"

  // Deduplicate by nameWithOwner
  return { status: 'ready', agents: dedup(agents), errors }
```

### Discovery Merge Algorithm

When agents appear in multiple sources, they must be merged deterministically:

```typescript
function mergeDiscoveryResults(
  local: LocalAgent[],
  github: GitHubAgent[]
): MergedAgent[] {
  const merged: MergedAgent[] = [];
  const matchedGithub = new Set<string>();

  // Match key: agent name (from repo name minus 'instar-' prefix)
  for (const localAgent of local) {
    const githubMatch = github.find(g =>
      g.name === localAgent.name &&
      !matchedGithub.has(g.repo)
    );

    if (githubMatch) {
      matchedGithub.add(githubMatch.repo);
      merged.push({
        ...localAgent,
        githubRepo: githubMatch.repo,
        githubOwner: githubMatch.owner,
        source: 'both',
      });
    } else {
      merged.push({ ...localAgent, source: 'local' });
    }
  }

  // Unmatched GitHub agents
  for (const g of github) {
    if (!matchedGithub.has(g.repo)) {
      merged.push({
        name: g.name,
        repo: g.repo,
        owner: g.owner,
        ownerType: g.ownerType,
        source: 'github',
      });
    }
  }

  return merged;
}
```

**Precedence rules:**
- Local agent + GitHub match → show as local with backup note (local takes priority)
- Local only → show as local
- GitHub only → show as available for restore
- Same agent name in multiple orgs → show all with full `owner/repo` qualification

### Agent Name Collision Resolution

When multiple GitHub agents share the same name (e.g., `personal/instar-ai-guy` and `SageMindAI/instar-ai-guy`):

1. **During display**: Always show the full `owner/repo` path to disambiguate.
2. **During restore**: If the user selects an agent with a name collision, prompt: "This agent name 'ai-guy' already exists locally. Use a different local name?" Suggest `{name}-{owner}` (e.g., `ai-guy-SageMindAI`).
3. **Local directory**: Use the disambiguated name for the directory: `~/.instar/agents/ai-guy-SageMindAI/`.
4. **Stable identity**: The agent's identity is its `nameWithOwner` (e.g., `SageMindAI/instar-ai-guy`), not the local directory name. The local name is a convenience alias.

### Discovery Output Format

The launcher (`setup.ts`) passes structured discovery results to the wizard as a clearly delimited JSON block:

```typescript
interface SetupDiscoveryContext {
  local_agents: Array<{
    name: string;
    path: string;
    type: 'project-bound' | 'standalone';
    status: 'running' | 'stopped';
    port?: number;
    userCount?: number;
    machineCount?: number;
  }>;
  github_agents: Array<{
    name: string;
    repo: string;       // nameWithOwner
    owner: string;
    ownerType: 'user' | 'org';
    cloneUrl: string;    // HTTPS clone URL (from clone_url field, NOT url)
    sshUrl: string;      // SSH clone URL
  }>;
  current_dir_agent: {
    exists: boolean;
    name?: string;
    users?: string[];
    machines?: number;
  } | null;
  gh_status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
  scan_errors: string[];       // non-fatal errors, org names redacted
  zombie_entries: string[];    // registry entries with missing paths
}
```

This context is passed to the wizard prompt as:

```
--- BEGIN UNTRUSTED DISCOVERY DATA (JSON) ---
{serialized SetupDiscoveryContext}
--- END UNTRUSTED DISCOVERY DATA ---
```

The `UNTRUSTED` label ensures the LLM wizard treats all field values as data, not instructions.

### Changes to `setup.ts`

1. **Remove auto-install of `gh`**: Replace with a message pointing to https://cli.github.com/ and graceful degradation (skip GitHub discovery, offer "paste repo URL" manual path)
2. **Add consent step**: Before any GitHub API calls, explain what will be scanned and ask for confirmation
3. **Add org scanning**: Parallel scan with `Promise.allSettled`, concurrency cap of 5, global timeout of 15 seconds
4. **Paginate all GitHub queries**: Use `gh api --paginate` instead of `--limit 100`. If using `gh repo list`, detect exactly-100 results and warn about potential truncation
5. **Use correct clone URL field**: Use `clone_url` (not `url`) from the GitHub API. The `url` field returns the web URL (e.g., `https://github.com/org/repo`), NOT the clone URL (e.g., `https://github.com/org/repo.git`)
6. **Detect SSH preference**: Check `gh config get git_protocol` -- if `ssh`, populate `cloneUrl` with the SSH URL instead
7. **Include `nameWithOwner`**: So the wizard can show "SageMindAI/instar-ai-guy" vs "justinheadley/instar-personal-bot"
8. **Validate registry entries**: Check each `registry.json` entry against the filesystem, flag zombies
9. **Structured JSON output**: Pass discovery as `SetupDiscoveryContext` JSON, delimited and labeled as untrusted
10. **Sanitize all string fields**: Validate agent names match `/^[a-zA-Z0-9_-]+$/`, org names match `/^[a-zA-Z0-9_.-]+$/`. Reject or escape anything else.
11. **Redact org names in errors**: Error messages should say `Org scan failed (1 of 5)` not `Org "SecretStartup" timed out`
12. **Progress indicator**: Show "Scanning your GitHub repos..." during discovery

---

## Part 2: Scenario Inference Engine

The wizard uses detected context + minimal questions to resolve which of the 8 setup scenarios applies. This is NOT exposed to the user -- it's internal routing logic.

### Scenario Count Clarification

The topology spec defines 9 scenarios across 4 axes. However, **Scenario 9** (cross-machine user access) is a capability flag that applies to any multi-machine + multi-user combination (Scenarios 6 and 7), not a separate setup path. The wizard therefore routes across **8 distinct setup flows** (Scenarios 1-8), with Scenario 9's cross-machine access capabilities activated as part of Scenarios 6 and 7.

### Detection Phase (Zero Questions)

Before asking anything, the wizard knows:

| Signal | Source | What it tells us |
|--------|--------|-----------------|
| Inside git repo? | `setup.ts` git detection | **Axis 1**: repo vs standalone |
| Existing `.instar/` in CWD? | `setup.ts` filesystem check | Fresh install vs returning |
| Number of users in `users.json` | `setup.ts` reads it | **Axis 2**: single vs multi-user (for existing agents) |
| Number of machines in registry | `setup.ts` reads it | **Axis 3**: single vs multi-machine (for existing agents) |
| Telegram configured? | `setup.ts` reads config | Whether Telegram setup can be skipped |
| GitHub backups found? | Discovery scan | Whether restore is possible |
| Local agents found? | Registry + filesystem | Whether this machine already has agents |

### Scenario Context Interface

Detection results and scenario flags are formalized as a TypeScript interface, not string interpolation:

```typescript
interface SetupScenarioContext {
  // Detection results
  isInsideGitRepo: boolean;
  existingAgentInCWD: boolean;
  existingUserCount: number;        // 0 = fresh install
  existingMachineCount: number;     // 0 = fresh install
  telegramConfigured: boolean;
  githubBackupsFound: boolean;
  localAgentsFound: boolean;

  // Resolved from detection + questions
  isMultiUser: boolean | null;      // null = not yet determined
  isMultiMachine: boolean | null;   // null = not yet determined
  resolvedScenario: number | null;  // 1-8, null = not yet resolved

  // Entry point
  entryPoint: 'fresh' | 'existing' | 'restore' | 'reconfigure';
}
```

This context is serialized as structured JSON in the wizard prompt, never string-interpolated.

### Question Phase (1-2 Questions, Only When Needed)

After detection, the wizard may need to ask:

**Question 1** (only for fresh installs): "Will other people use this agent too?"
- YES -> multi-user scenarios (5, 6, 7, 8)
- NO -> single-user scenarios (1, 2, 3, 4)

**Question 2** (only for fresh installs): "Will you run this agent on another machine too?"
- YES -> multi-machine scenarios (2, 4, 6, 7)
- NO -> single-machine scenarios (1, 3, 5, 8)

These two questions, combined with auto-detection, fully resolve the scenario:

### Scenario Resolution Table

| In repo? | Multi-user? | Multi-machine? | Scenario | Wizard behavior |
|----------|-------------|----------------|----------|----------------|
| Yes | No | No | **3** | Simplest path. Minimal config. |
| Yes | No | Yes | **4** | Enable git backup. Explain active/standby. |
| Yes | Yes | No | **5** | Registration policy. Recovery key. User identity. |
| Yes | Yes | Yes | **6** | Full coordination. Per-machine Telegram. config.local.json. Cross-machine access (Scenario 9). |
| No | No | No | **1** | Standalone agent. Simple setup. |
| No | No | Yes | **2** | Enable git backup. Cloud sync. |
| No | Yes | No | **8** | Standalone + multi-user. Registration policy. |
| No | Yes | Yes | **7** | Full coordination for standalone. Cross-machine access (Scenario 9). |

### Question Timing

The multi-user and multi-machine questions are asked during **Phase 2 (Identity Bootstrap)** -- after the welcome but before Telegram setup. This is because:

- The answer affects Telegram setup (single group vs per-machine groups)
- The answer affects secret management recommendations (Bitwarden recommended for multi-machine)
- The answer affects what files are generated (recovery key, machine registry)

The wizard DOES NOT ask these questions if it can infer the answers:

| If detected... | Then... |
|---------------|---------|
| Existing agent with 2+ users | Already multi-user. Don't ask. |
| Existing agent with 2+ machines | Already multi-machine. Don't ask. |
| User chose "I'm a new user joining" | Multi-user is implicit. Don't ask. |
| User chose "I'm an existing user on a new machine" | Multi-machine is implicit. Don't ask. |
| Restoring from backup | Check backup's users.json and machine registry. Don't ask if already known. |

---

## Part 3: Guided Flow Per Scenario

Each resolved scenario triggers a tailored flow. The wizard adjusts its behavior -- different defaults, different questions, different explanations -- without the user knowing they're in a "scenario."

All flows begin with a **privacy disclosure** at the welcome screen (see [Part 8](#part-8-security--privacy)).

### Scenario 1 & 3: Single User, Single Machine (Global / Repo)

**The simplest path.** Minimal questions, fast to complete.

Flow:
1. Welcome + privacy disclosure (context-aware: repo name or "standalone agent")
2. Identity bootstrap (name, agent name, communication style, autonomy level)
3. Telegram setup (one group, one bot)
4. Technical config (port, sessions, scheduler -- sensible defaults, ask only if non-default needed)
5. Start & verify

**Scenario-specific defaults:**
- Git backup: OFF (single machine, no need)
- Multi-machine coordinator: disabled
- Registration policy: not set (single user)
- Recovery key: not generated

**What the wizard says:**
> "Since it's just you on one machine, I'll keep things simple."

### Scenario 2 & 4: Single User, Multi-Machine (Global / Repo)

**Adds cloud backup and machine coordination.**

Flow:
1-2. Same as Scenario 1/3
3. **Git backup setup** (before Telegram):
   - "Since you'll use this on multiple machines, I'll set up cloud backup so your agent syncs between them."
   - Create GitHub repo (`instar-{name}`) or ask for existing repo URL
   - Validate repo URL (must match `https://github.com/` prefix or valid SSH URL)
   - Enable git state sync in config
   - For repo agents (Scenario 4): explain that `.instar/config.local.json` handles per-machine Telegram config
4. Telegram setup
5. **Machine identity**: Generate keypair, create machine registry
6. Technical config
7. Start & verify
8. **Handoff message**: "When you set up on your other machine, run `npx instar` there. It'll find this agent and connect automatically."

**Scenario-specific defaults:**
- Git backup: ON (auto-create repo)
- Secret backend: Bitwarden RECOMMENDED (secrets need to sync)
- Multi-machine coordinator: active/standby (default)
- `config.local.json`: created for repo agents (Scenario 4)

**What the wizard says:**
> "I'll set up cloud backup so your agent travels with you between machines."

### Scenario 5 & 8: Multi-User, Single Machine (Repo / Global)

**Adds user management and registration.**

Note: Multi-user scenarios (5-8) require per-joining-user consent architecture. The admin sets up the agent; each joining user goes through their own consent moment when they run `npx instar` to join. See [Part 8: Per-User Consent](#per-user-consent).

Flow:
1-2. Same as Scenario 1/3, but identity bootstrap asks about the team
3. **Registration policy**: "How should new people join?"
   - Admin-only / Invite code / Open
4. **Autonomy level**: "How much should the agent handle on its own?"
5. **Recovery key**: Generated with security guardrails (see [Recovery Key Lifecycle](#recovery-key-lifecycle))
6. Telegram setup (single group, shared by all users)
7. Technical config
8. Start & verify
9. **Invitation message**: "To add someone, have them run `npx instar` in this directory."

**Scenario-specific defaults:**
- Registration policy: admin-only (safe default)
- Autonomy: collaborative (balanced default)
- Recovery key: generated with CSPRNG
- User identity pipeline: enabled

**What the wizard says:**
> "I'll set up user management so everyone has their own identity with the agent."

### Scenario 6 & 7: Multi-User, Multi-Machine (Repo / Global)

**The most complex path. Full coordination.** Includes Scenario 9 cross-machine access capabilities.

Flow:
1-2. Same as Scenario 5/8
3. Registration policy + autonomy + recovery key (same as 5/8)
4. **Git backup setup** (same as Scenario 2/4)
5. **Machine topology decision**:
   - "Each machine will have its own Telegram group. You'll message whichever machine you want."
   - (Don't ask -- machine-aware is the near-term default per the topology spec)
6. Telegram setup for THIS machine
7. **Machine identity** + machine registry
8. For repo agents (Scenario 6): create `config.local.json`
9. Technical config
10. Start & verify
11. **Handoff**: "When another user sets up on their machine, they'll run `npx instar` and choose 'I'm a new user joining this agent.'"

**Scenario-specific defaults:**
- Everything from Scenario 2/4 (backup, machine identity)
- Everything from Scenario 5/8 (registration, recovery key)
- Coordination mode: multi-active (both machines awake)
- Per-machine Telegram groups
- Job affinity: enabled (prevent double-execution)
- Cross-machine access: enabled (Scenario 9 capability)

**What the wizard says:**
> "This is a team setup across multiple machines. I'll configure cloud backup, user management, and machine coordination."

---

## Part 4: Entry Point Routing (Phase 0 Refinement)

The wizard's Phase 0 handles several entry points. Here's how each routes into the scenario system:

### Entry Point A: Fresh Install (No Existing Agent)

1. Run comprehensive discovery (Part 1)
2. If agents found (local or GitHub): present them first
   - "I found existing agents. Want to restore one, or start fresh?"
   - If restore -> Entry Point C
   - If fresh -> continue
3. Context-detect repo vs global (auto)
4. Ask Question 1: "Will other people use this agent?"
5. Ask Question 2: "Will you use this on another machine?"
6. Resolve scenario -> route to appropriate flow (Part 3)

### Entry Point B: Existing Agent Detected

1. Present 3 options:
   - "I'm a new user joining" -> multi-user is implicit. Check machines. Route to Scenario 5/6/7/8.
   - "I'm an existing user on a new machine" -> multi-machine is implicit. Check users. Route to Scenario 2/4/6/7.
   - "Start fresh" -> go to Entry Point A.
2. Scenario is inferred from the combination of existing state + user's choice.

### Entry Point C: Restore from Backup

1. Clone the backup (use `--depth=1` for faster initial clone)
2. **Validate backup state**: Schema-validate all state files (`users.json`, `machines/registry.json`, `config.json`) against expected structure. Reject malformed files.
3. **Display restoration summary** before proceeding:
   ```
   Restoring from: SageMindAI/instar-ai-guy
   Agent name: ai-guy
   Users: 2 (Justin, Sarah)
   Machines: 1
   Telegram: configured
   Last backup: 2026-03-01

   Proceed with restore? [y/n]
   ```
4. Require explicit user confirmation ("y" or equivalent)
5. Route to appropriate flow with machine-specific adjustments (paths, ports, machine identity)

### Entry Point D: Reconfigure (Already-Configured Agent)

When `npx instar` is run on a machine where the agent is already fully configured:

1. Detect existing complete configuration
2. Present options:
   - "Update configuration" -> re-run relevant wizard phases (e.g., change Telegram, adjust autonomy)
   - "Add a user" -> Entry Point B, "new user joining" path
   - "View current config" -> display current scenario and settings
   - "Start fresh" -> confirm destructive action, then Entry Point A

---

## Part 5: Comprehensive GitHub Discovery (Implementation Detail)

### Current Code (setup.ts lines 189-205)

```typescript
// CURRENT: Only scans personal repos
const ghResult = execFileSync(ghPath, ['repo', 'list', '--json', 'name', '--limit', '100'], {
  encoding: 'utf-8',
  stdio: ['pipe', 'pipe', 'pipe'],
  timeout: 15000,
}).trim();
const repos = JSON.parse(ghResult);
githubAgents = repos
  .filter(r => r.name.startsWith('instar-'))
  .map(r => r.name.replace(/^instar-/, ''));
```

### New Code

```typescript
interface DiscoveredGitHubAgent {
  name: string;           // agent name (e.g., "ai-guy")
  repo: string;           // full repo (e.g., "SageMindAI/instar-ai-guy")
  owner: string;          // owner login (e.g., "SageMindAI")
  ownerType: 'user' | 'org';
  cloneUrl: string;       // Clone URL (HTTPS or SSH based on user preference)
  sshUrl: string;         // SSH clone URL (always populated as fallback)
}

// Name validation regex -- reject anything that could be prompt injection
const VALID_NAME = /^[a-zA-Z0-9_-]+$/;
const VALID_ORG = /^[a-zA-Z0-9_.-]+$/;

// Clone URL validation -- accept only known-safe prefixes
function isValidCloneUrl(url: string): boolean {
  return (
    url.startsWith('https://github.com/') ||
    url.startsWith('git@github.com:')
  );
}

async function scanGitHub(ghPath: string): Promise<{
  status: 'ready' | 'auth-needed' | 'unavailable' | 'declined';
  agents: DiscoveredGitHubAgent[];
  errors: string[];       // non-fatal errors (org names redacted)
}> {
  const agents: DiscoveredGitHubAgent[] = [];
  const errors: string[] = [];

  // Check auth
  try {
    execFileSync(ghPath, ['auth', 'status'], { stdio: 'pipe', timeout: 5000 });
  } catch {
    return { status: 'auth-needed', agents: [], errors: [] };
  }

  // Detect user's preferred git protocol (ssh vs https)
  let gitProtocol = 'https';
  try {
    const proto = execFileSync(ghPath, ['config', 'get', 'git_protocol'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 3000,
    }).trim();
    if (proto === 'ssh') gitProtocol = 'ssh';
  } catch { /* default to https */ }

  // Get authenticated username
  let username = '';
  try {
    username = execFileSync(ghPath, ['api', 'user', '--jq', '.login'], {
      encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000,
    }).trim();
  } catch { /* continue without username */ }

  // 1. Personal repos (paginated via gh api)
  try {
    const result = execFileSync(ghPath, [
      'api', 'user/repos', '--paginate',
      '--jq', '.[] | select(.name | startswith("instar-")) | {name, full_name: .full_name, clone_url: .clone_url, ssh_url: .ssh_url}'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();

    if (result) {
      for (const line of result.split('\n').filter(Boolean)) {
        try {
          const r = JSON.parse(line);
          if (!VALID_NAME.test(r.name.replace(/^instar-/, ''))) continue;
          const cloneUrl = gitProtocol === 'ssh' ? r.ssh_url : r.clone_url;
          if (!isValidCloneUrl(cloneUrl)) continue;
          agents.push({
            name: r.name.replace(/^instar-/, ''),
            repo: r.full_name,
            owner: username,
            ownerType: 'user',
            cloneUrl,
            sshUrl: r.ssh_url,
          });
        } catch { /* skip malformed entry */ }
      }
    }
  } catch (err: any) {
    errors.push(`Personal repos scan failed`);
  }

  // 2. All organizations (paginated)
  let orgs: string[] = [];
  try {
    const orgResult = execFileSync(ghPath, [
      'api', 'user/orgs', '--paginate', '--jq', '.[].login'
    ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();

    if (orgResult) {
      orgs = orgResult.split('\n').filter(o => Boolean(o) && VALID_ORG.test(o));
    }
  } catch (err: any) {
    errors.push(`Organization listing failed`);
  }

  // Cap orgs at MAX_ORGS (10) with escape hatch
  const MAX_ORGS = 10;
  let orgsTruncated = false;
  if (orgs.length > MAX_ORGS) {
    orgsTruncated = true;
    orgs = orgs.slice(0, MAX_ORGS);
  }

  // Parallel scan with concurrency cap and global timeout
  const CONCURRENCY = 5;
  const GLOBAL_TIMEOUT = 15_000;
  const startTime = Date.now();

  const scanOrg = async (org: string): Promise<DiscoveredGitHubAgent[]> => {
    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      throw new Error('Global timeout exceeded');
    }
    const orgAgents: DiscoveredGitHubAgent[] = [];
    try {
      const result = execFileSync(ghPath, [
        'api', `orgs/${org}/repos`, '--paginate',
        '--jq', '.[] | select(.name | startswith("instar-")) | {name, full_name: .full_name, clone_url: .clone_url, ssh_url: .ssh_url}'
      ], { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 10000 }).trim();

      if (result) {
        for (const line of result.split('\n').filter(Boolean)) {
          try {
            const r = JSON.parse(line);
            if (!VALID_NAME.test(r.name.replace(/^instar-/, ''))) continue;
            const cloneUrl = gitProtocol === 'ssh' ? r.ssh_url : r.clone_url;
            if (!isValidCloneUrl(cloneUrl)) continue;
            orgAgents.push({
              name: r.name.replace(/^instar-/, ''),
              repo: r.full_name,
              owner: org,
              ownerType: 'org',
              cloneUrl,
              sshUrl: r.ssh_url,
            });
          } catch { /* skip malformed entry */ }
        }
      }
    } catch (err: any) {
      errors.push(`Organization scan failed (${orgs.indexOf(org) + 1} of ${orgs.length})`);
    }
    return orgAgents;
  };

  // Execute org scans in parallel batches
  for (let i = 0; i < orgs.length; i += CONCURRENCY) {
    if (Date.now() - startTime > GLOBAL_TIMEOUT) {
      errors.push(`Discovery timeout -- scanned ${i} of ${orgs.length} organizations`);
      break;
    }
    const batch = orgs.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(batch.map(scanOrg));
    for (const result of results) {
      if (result.status === 'fulfilled') {
        agents.push(...result.value);
      }
    }
  }

  if (orgsTruncated) {
    errors.push(`Showing agents from first ${MAX_ORGS} organizations. Run 'instar scan --all-orgs' to see all.`);
  }

  // Deduplicate by repo (full_name / nameWithOwner)
  const seen = new Set<string>();
  const deduped = agents.filter(a => {
    if (seen.has(a.repo)) return false;
    seen.add(a.repo);
    return true;
  });

  return { status: 'ready', agents: deduped, errors };
}
```

### Key Bug Fix: Clone URL

The v1 spec used `r.url` which returns the **web URL** (e.g., `https://github.com/org/repo`) -- not a clone URL. This would cause `git clone` failures at restore time.

**Fix**: Use `r.clone_url` (HTTPS: `https://github.com/org/repo.git`) or `r.ssh_url` (SSH: `git@github.com:org/repo.git`) from the GitHub API, based on the user's configured `git_protocol`.

### Wizard Display for Multiple Sources

When agents are found across multiple sources, present them grouped:

```
I found existing agents:

Your repos:
  1. personal-bot (justinheadley/instar-personal-bot)

SageMindAI:
  2. ai-guy (SageMindAI/instar-ai-guy)
  3. dawn-agent (SageMindAI/instar-dawn-agent)

On this machine:
  4. my-agent (~/.instar/agents/my-agent) -- currently running

  5. Start fresh -- set up a brand new agent
```

If an agent appears both locally and on GitHub, show it once (local takes priority since it's already here) with a note:

```
On this machine:
  1. ai-guy (/Users/justin/Projects/ai-guy/.instar) -- running, backed up to SageMindAI/instar-ai-guy
```

---

## Part 6: Wizard Skill Updates

### Changes to `skill.md`

1. **Add privacy disclosure** to the welcome screen (all scenarios):

   ```
   Before we begin: Instar stores your name, agent preferences, and Telegram
   connection locally on this machine. If you enable GitHub backup, config
   is synced to a private repo you control. We don't collect telemetry or
   send data to external services.
   ```

2. **Add Scenario Inference section** after Phase 0, before Phase 1:

   The wizard receives discovery results and detection context as structured JSON. It uses the resolution table (Part 2) to determine the scenario. This is internal -- never shown to the user.

   ```
   ## Internal: Scenario Resolution

   After Phase 0 routing and before Phase 1 begins:
   1. Parse the SetupScenarioContext JSON from the prompt
   2. Determine what's already known (repo/global, existing users/machines)
   3. For fresh installs: plan to ask the two narrowing questions in Phase 2
   4. Set internal flags: isMultiUser, isMultiMachine, scenario number
   5. Use these flags to gate setup sections throughout the flow
   ```

3. **Add step counter** for multi-step flows:

   Each wizard message should indicate progress: `[Step 2 of 5]` or similar. The total step count varies by scenario (Scenario 1/3: 5 steps, Scenario 6/7: 11 steps).

4. **Update Phase 2** to include the narrowing questions:

   After asking the user's name and the agent's name, ask:
   - "Will other people use [agent name] too?" (only for fresh installs)
   - "Will you run [agent name] on another machine too?" (only for fresh installs)

   Based on answers, activate/deactivate subsequent phases:
   - Multi-user YES -> registration policy, recovery key, user identity
   - Multi-machine YES -> git backup, machine identity, coordination config

5. **Gate Phase sections by scenario flags**:

   - Git backup setup: only if `isMultiMachine`
   - Registration policy: only if `isMultiUser`
   - Recovery key: only if `isMultiUser`
   - Machine identity: only if `isMultiMachine`
   - config.local.json: only if `isMultiMachine` AND repo agent
   - Job affinity: only if `isMultiMachine` AND `isMultiUser`

6. **Update Phase 0** to use comprehensive discovery results:

   Replace the current ad-hoc string parsing with structured JSON parsing of `SetupDiscoveryContext`.

7. **Auto-add `config.local.json` to `.gitignore`** during setup for repo-bound agents (Scenarios 4, 6). This prevents accidental git staging of Telegram bot tokens and per-machine secrets.

8. **Set file permissions** on sensitive files: `chmod 0600` on `config.local.json`, `recovery-key` (if written), and any file containing tokens.

9. **Token redaction**: When displaying errors that might contain Telegram bot tokens (matching pattern `\d+:[A-Za-z0-9_-]{35}`), redact the token value.

### Changes to `setup.ts`

1. Replace ad-hoc GitHub scanning with `scanGitHub()` function (Part 5)
2. Include local registry agents in discovery, with zombie validation
3. Pass structured JSON discovery results to wizard as delimited block
4. Add progress indicator during org scanning ("Scanning your GitHub organizations...")
5. Add `--non-interactive` flag for CI/automation (see [Non-Interactive Mode](#non-interactive-mode))

### Non-Interactive Mode

For CI/CD pipelines and automation, support a `--non-interactive` flag:

```bash
npx instar --non-interactive \
  --name "my-agent" \
  --user "deploy-bot" \
  --telegram-token "..." \
  --telegram-group "..." \
  --scenario 3
```

In non-interactive mode:
- All wizard questions are answered via CLI flags
- Missing required flags produce clear error messages with flag names
- No LLM wizard session is spawned
- Recovery key is output to stdout (one line) for capture by the calling script
- Exit code 0 on success, non-zero on failure

---

## Part 7: Test Plan

### Unit Tests

1. **Scenario inference tests**: Given detection context, verify correct scenario resolution
   - Fresh install in repo, no multi-user, no multi-machine -> Scenario 3
   - Fresh install global, multi-user, multi-machine -> Scenario 7
   - Existing agent with 2 users, 1 machine -> Scenario 5 (no questions needed)
   - All 8 scenarios covered (Scenario 9 tested as capability flag on 6/7)

2. **GitHub scanning tests**:
   - Personal repos only -> finds personal agents
   - With orgs -> finds org agents
   - Deduplication -> same agent in two orgs only appears once
   - Timeout handling -> one org timeout doesn't block others
   - Auth needed -> returns correct status
   - No gh -> returns unavailable with helpful message
   - Pagination -> handles >100 repos correctly
   - Truncation detection -> warns when exactly 100 results returned (legacy path)
   - Rate limit detection -> backs off on 403/429 responses
   - Name validation -> rejects agent names with special characters
   - Clone URL validation -> rejects non-GitHub URLs

3. **Discovery merging tests** (`mergeDiscoveryResults()`):
   - Local + GitHub same agent -> merged, local takes priority
   - Local only -> shown correctly
   - GitHub only -> shown correctly
   - Name collision (same name, different owners) -> both shown with full qualification
   - Empty results -> goes to fresh install
   - Zombie registry entries -> excluded from results

4. **Registry validation tests**:
   - Valid entries -> included
   - Path to deleted directory -> flagged as zombie
   - Path outside allowed directories -> rejected
   - Malformed JSON -> handled gracefully

5. **Security tests**:
   - Prompt injection in repo names -> sanitized, not executed
   - Clone URL with non-GitHub domain -> rejected
   - Backup state with malformed schema -> rejected at restore
   - Recovery key never appears in log files

### Performance Tests

1. **Discovery latency**: Full scan (personal + 10 orgs) completes in < 15 seconds
2. **Global timeout**: Discovery terminates cleanly at 15-second budget
3. **Parallel efficiency**: 10-org scan with parallelism completes faster than sequential

### Integration Tests

1. **Wizard completeness test update**: Verify wizard skill mentions all scenario-specific features
2. **Phase gating test**: Verify multi-user features aren't offered in single-user scenarios (and vice versa)
3. **Consent flow test**: Verify GitHub scanning asks for consent before API calls
4. **Restore confirmation test**: Verify backup restore shows summary and requires confirmation

### Manual Test Scenarios

1. Run `npx instar` in a fresh directory (no git) -> should get Scenario 1 flow
2. Run `npx instar` in a git repo -> should get Scenario 3 flow
3. Run `npx instar` where an agent exists -> should get Phase 0 decision tree
4. Create a GitHub repo `instar-test-agent` in a personal account -> verify it's found
5. Create a GitHub repo `instar-org-agent` in an org -> verify it's found
6. Have agents in both personal and org -> verify grouped display
7. Run `npx instar` on already-configured agent -> verify Entry Point D (reconfigure)
8. Run `npx instar --non-interactive --name test --scenario 1` -> verify non-interactive mode
9. Create a backup with intentionally malformed state -> verify validation rejects it
10. Test with `gh` not installed -> verify graceful degradation message

---

## Part 8: Security & Privacy

### Privacy Disclosure

The wizard displays a brief, plain-language privacy notice at the welcome screen before collecting any data:

```
Before we begin: Instar stores your name, agent preferences, and Telegram
connection locally on this machine. If you enable GitHub backup, config is
synced to a private repo you control. We don't collect telemetry or send
data to external services.
```

This satisfies GDPR Art. 13 disclosure requirements for the data points collected during setup.

### GitHub Scanning Consent

Before any GitHub API call, the wizard explains what will be scanned and asks for consent:

```
To find your existing agents, I'll check your GitHub repos and organizations.
This reads repo names only -- no code is accessed or downloaded.
Proceed? [y/n]
```

If declined, the wizard skips GitHub discovery and continues with local-only scanning. The user can still paste a repo URL manually to restore.

### Org Enumeration Privacy

`gh api user/orgs` reveals all organizations the user belongs to, including private/stealth orgs. To protect this data:

1. **Consent first**: Always ask before enumerating orgs
2. **Display constraint**: Only show org names when presenting discovered agents (not a full org list)
3. **Error redaction**: Error messages use ordinal position ("org 3 of 5 timed out") not org names
4. **No persistence**: Discovery results are never written to disk. They exist only in the wizard session's memory.
5. **Log safety**: Org names never appear in log files

### Recovery Key Lifecycle

The recovery key is used for admin recovery of multi-user agents. Its lifecycle:

| Aspect | Specification |
|--------|--------------|
| **Entropy source** | CSPRNG (`crypto.randomBytes(32)`) -> base58 encoding -> 44-character key |
| **Display** | Shown once in terminal after generation |
| **Acknowledgment** | User must type "I saved it" or press Enter to confirm before wizard continues |
| **Storage guidance** | Wizard recommends: "Save this in a password manager (e.g., Bitwarden, 1Password). You'll need it to recover admin access." |
| **Clipboard** | Offer to copy to clipboard (optional, user-initiated) |
| **Disk storage** | NEVER written to disk in plaintext. Not in logs, not in config files, not in temp files |
| **What it unlocks** | Admin access recovery for multi-user agents when the original admin is unavailable |
| **Loss scenario** | If lost, recovery requires direct filesystem access to the agent's data directory |
| **Rotation** | Not currently supported. Future: `instar admin rotate-key` |
| **Non-interactive mode** | Output to stdout as single line for capture by calling script |

### Telegram Bot Token Protection

Telegram bot tokens (matching pattern `\d+:[A-Za-z0-9_-]{35}`) are sensitive credentials:

1. **Immediate validation**: Validate token format and test against Telegram API during setup
2. **File permissions**: `config.local.json` created with `0600` permissions (owner read/write only)
3. **`.gitignore` auto-add**: For repo-bound agents, automatically add `config.local.json` to `.gitignore`
4. **Error redaction**: Any error output containing a token pattern is redacted: `Token: [REDACTED]`
5. **Terminal history**: Tokens entered via AskUserQuestion (password mode) are not echoed to terminal

### Backup Restore Security

Backup repos may be compromised (public forks, social engineering, abandoned accounts). Before restoring:

1. **Schema validation**: All state files must match expected TypeScript interfaces
2. **Value constraints**: Validate all fields (user names, paths, URLs) against allowlists
3. **No code execution**: Never execute scripts or hooks from backup state during restore
4. **Summary display**: Show what will be restored and require explicit confirmation
5. **Shallow clone**: Use `git clone --depth=1` to minimize exposure to repo history

### Per-User Consent

For multi-user scenarios (5-8), when a new user joins an existing agent:

1. The joining user runs `npx instar` and selects "I'm a new user joining"
2. Before registration completes, display: "You're joining agent '{name}' managed by {admin}. Your name and Telegram identity will be stored locally on this machine."
3. Require explicit consent to proceed
4. This consent moment is per-joining-user, not per-admin-setup

### Clone URL Validation

All clone URLs are validated before use:

- **HTTPS**: Must match `https://github.com/{owner}/{repo}.git` pattern
- **SSH**: Must match `git@github.com:{owner}/{repo}.git` pattern
- **No other protocols**: Reject `file://`, `ftp://`, or other URL schemes
- **No IP addresses**: Only `github.com` hostname accepted (no `192.168.x.x` or similar)

---

## Part 9: Error Handling & Recovery

### Setup Lock File

When the wizard begins making changes (creating files, repos, registries), it creates a lock file:

```
~/.instar/setup-lock.json
{
  "startedAt": "2026-03-03T10:00:00Z",
  "agentName": "my-agent",
  "scenario": 3,
  "phase": "telegram-setup",
  "filesCreated": ["~/.instar/agents/my-agent/config.json"],
  "reposCreated": ["justinheadley/instar-my-agent"]
}
```

If the wizard detects an existing lock file on next run:
- "A previous setup was interrupted during {phase}. Resume or start over?"
- Resume: pick up from the interrupted phase
- Start over: clean up files/repos listed in the lock, then begin fresh

The lock file is deleted on successful wizard completion.

### GitHub Operation Failures

| Failure | Handling |
|---------|---------|
| Repo creation: name taken | Suggest alternative name (`instar-{name}-2`) or ask user |
| Repo creation: org policy blocks | Explain the restriction, offer personal repo as fallback |
| Repo creation: network error | Retry once, then offer to skip backup and configure manually later |
| Org scan: rate limited (403/429) | Back off with exponential delay, warn user, continue with partial results |
| Org scan: timeout | Note the incomplete scan, continue with available results |
| Clone failure: auth error | Detect SSH vs HTTPS mismatch, suggest switching protocol |

### Network Loss Mid-Wizard

If network connectivity is lost during the wizard:

1. **During discovery**: Return partial results with a warning. Offer to retry or continue with local-only.
2. **During repo creation**: The lock file captures the attempt. On resume, check if the repo was actually created (it might have succeeded server-side before the timeout).
3. **During Telegram validation**: Note that Telegram setup is incomplete. The agent can start without Telegram and configure it later.
4. **General principle**: The wizard should never leave the system in a state where re-running `npx instar` would be confused or destructive. The lock file ensures resumability.

### Zombie Registry Cleanup

When zombie entries are detected during discovery:

```
Note: Found 2 registry entries pointing to deleted directories.
These have been excluded from the scan results.
Run 'instar cleanup' to remove stale registry entries.
```

Do not auto-delete zombie entries -- the user might want to investigate why the directories are missing.

---

## Part 10: Platform Support

### Supported Platforms (v1)

| Platform | Status | Notes |
|----------|--------|-------|
| macOS (Apple Silicon) | Full support | Primary development platform |
| macOS (Intel) | Full support | |
| Linux (Debian/Ubuntu) | Full support | |
| Linux (other distros) | Expected to work | `gh` install instructions may differ |
| Windows (WSL2) | Expected to work | Uses Linux paths within WSL |
| Windows (native) | Not supported in v1 | Paths (`%APPDATA%`), package managers (`winget`, `choco`), and shell differences require dedicated work |

### Path Handling

The spec uses `~/.instar/` (Unix home directory expansion). On supported platforms, this resolves to:

- macOS/Linux: `/home/{user}/.instar/` or `/Users/{user}/.instar/`
- WSL2: `/home/{user}/.instar/` (within the WSL filesystem)

Windows native path support (`%APPDATA%\instar\`) is deferred to a future version.

### `gh` CLI Installation Guidance

Since auto-install is not performed, the wizard provides platform-appropriate install instructions:

```
macOS:    brew install gh
Ubuntu:   sudo apt install gh
Other:    https://cli.github.com/
```

The wizard detects the current platform and shows the relevant command first.

---

## Implementation Order

1. **GitHub scanning enhancement** (setup.ts) -- fix cloneUrl bug, add pagination, parallel org scanning, consent step
2. **Registry validation** (setup.ts) -- zombie detection, path validation
3. **Structured discovery output** (setup.ts) -- `SetupDiscoveryContext` JSON, `UNTRUSTED` delimiters
4. **Scenario context interface** (setup.ts + skill.md) -- `SetupScenarioContext` TypeScript interface
5. **Discovery merge algorithm** (setup.ts) -- `mergeDiscoveryResults()` with collision handling
6. **Privacy disclosure + consent** (skill.md) -- welcome screen notice, GitHub consent step
7. **Recovery key lifecycle** (skill.md) -- CSPRNG, acknowledgment UX, no-disk-write
8. **Scenario inference section** (skill.md) -- internal routing logic
9. **Phase 2 narrowing questions** (skill.md) -- the two key questions
10. **Phase gating** (skill.md) -- scenario-specific sections
11. **Entry Point D** (skill.md) -- reconfigure path
12. **Error handling** (setup.ts + skill.md) -- lock file, resume, cleanup
13. **Non-interactive mode** (setup.ts) -- `--non-interactive` flag with CLI args
14. **Security hardening** (setup.ts) -- token redaction, file permissions, .gitignore auto-add
15. **Tests** -- unit + integration + performance + security
16. **Manual verification** -- run through each scenario

---

## Resolved Decisions

These were open questions in v1, now resolved based on review feedback:

### 1. Org Scan Cap -> 10 orgs with escape hatch

**Decision**: Scan the first 10 organizations by default. If the user belongs to more, display a message and offer `instar scan --all-orgs` to scan everything.

**Rationale**: 10 orgs covers the vast majority of individual users. Enterprise users with 20+ orgs can use the escape hatch. The cap prevents unbounded latency during first-run UX.

### 2. Non-GitHub Remotes -> GitHub-only for v1

**Decision**: v1 supports GitHub only. Users with GitLab/Bitbucket agents can use the manual "paste repo URL" path, but no automated discovery is provided for non-GitHub forges.

**Rationale**: GitHub is the dominant forge for the target audience. Adding multi-forge support adds significant complexity for a small user segment. The `gh` CLI dependency already couples us to GitHub.

**Future**: Consider Octokit (embedded JS client) to replace the `gh` CLI dependency entirely. This would also make multi-forge support more natural via provider abstraction.

### 3. Agent Naming Conflicts -> Disambiguate with `{name}-{owner}`

**Decision**: When restoring an agent whose name conflicts with an existing local agent:
1. Display the conflict clearly
2. Prompt the user to choose a local directory name
3. Suggest `{name}-{owner}` as the default (e.g., `ai-guy-SageMindAI`)
4. The agent's identity remains its `nameWithOwner` -- the local name is a convenience alias

**Rationale**: Using `nameWithOwner` as the stable identity avoids ambiguity. The local directory name is a UX convenience that can be whatever the user prefers.

### 4. Scanning Feedback -> Per-batch progress

**Decision**: Show progress at the batch level during org scanning:

```
Scanning your GitHub repos...
Scanning organizations (1-5 of 10)...
Scanning organizations (6-10 of 10)...
Found 3 agents across 2 sources.
```

Not per-org (leaks org names) and not a single spinner (no progress signal for long scans).

---

## Review History

This spec was reviewed by 11 independent reviewers on 2026-03-03:

**Internal SpecReview** (8 reviewers, avg 7.1/10):
- Security (6.5), Scalability (7.0), Business (7.0), Architecture (7.5), Privacy (6.5), Adversarial (6.5), DX (8.3), Marketing (7.5)
- Key consensus: auto-install `gh` is unacceptable, backup restore trusts external state, recovery key underspecified, org enumeration leaks data, prompt injection surface in discovery data

**External CrossReview** (3 models, unanimous 8/10):
- GPT 5.2, Gemini 3 Pro, Grok 4
- Key consensus: naming collisions unresolved, GitHub scanning fragile, security/privacy underspecified, error handling insufficient
- GPT uniquely caught: `cloneUrl` implementation bug (web URL vs clone URL), missing merge algorithm, Scenario 9 inconsistency
- Gemini uniquely caught: sequential org scanning latency, SSH vs HTTPS mismatch, zombie registry entries, Windows support gap
- Grok uniquely caught: interrupted setup flow, accessibility gap

**Changes in v2** (this revision):
- Fixed `cloneUrl` bug (use `clone_url`/`ssh_url` instead of `url`)
- Removed auto-install of `gh` -- graceful degradation with install guidance
- Added pagination for all GitHub API queries
- Parallelized org scanning with `Promise.allSettled` (concurrency 5, global timeout 15s)
- Added consent step before GitHub scanning
- Added backup restore confirmation with summary display
- Specified recovery key lifecycle (CSPRNG, acknowledgment, no-disk-write)
- Formalized `SetupScenarioContext` and `SetupDiscoveryContext` TypeScript interfaces
- Added discovery data sanitization and `UNTRUSTED` delimiters
- Defined `mergeDiscoveryResults()` algorithm with collision handling
- Resolved naming collisions via `{name}-{owner}` disambiguation
- Clarified Scenario 9 as capability flag (8 setup flows, not 9)
- Added new Parts: Security & Privacy (Part 8), Error Handling & Recovery (Part 9), Platform Support (Part 10)
- Added Entry Point D (reconfigure path)
- Added non-interactive mode specification
- Added setup lock file for resume/cleanup
- Added privacy disclosure to welcome screen
- Added step counter for multi-step flows
- Added clone URL and registry path validation
- Added SSH vs HTTPS protocol detection
- Added zombie registry cleanup
- Resolved all 4 open questions
- Expanded test plan with performance and security tests

Full review output:
- Internal: `.claude/skills/specreview/output/20260302-202951/`
- External: `.claude/skills/crossreview/output/20260302-203124/`
