# Salesforce Copilot Inspector

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![VS Code](https://img.shields.io/badge/VS%20Code-%3E%3D1.120-blue?logo=visualstudiocode)](https://code.visualstudio.com/)
[![GitHub Copilot](https://img.shields.io/badge/GitHub%20Copilot-Compatible-black?logo=githubcopilot)](https://github.com/features/copilot)
[![Salesforce Skills](https://img.shields.io/badge/Salesforce-Skills%20Library-00A1E0?logo=salesforce)](https://github.com/forcedotcom/sf-skills)
[![agentskills.io](https://img.shields.io/badge/agentskills.io-Validation-8A2BE2)](https://agentskills.io)
[![Security Audit](https://github.com/alcabon/salesforce-copilot-inspector/actions/workflows/audit.yml/badge.svg)](https://github.com/alcabon/salesforce-copilot-inspector/actions/workflows/audit.yml)

A VS Code extension that audits your GitHub Copilot configuration from the Activity Bar — covering instructions, skills, prompts, agents, hooks, extensions, and Salesforce MCP server configuration across both workspace and personal scopes.

---

## Quick Installation

**1. Download the latest `.vsix` from the [Releases page](https://github.com/alcabon/salesforce-copilot-inspector/releases/latest)**

Under **Assets**, click `salesforce-copilot-inspector-<version>.vsix` to download it.

**2. Install it**

```bash
# replace <version> with the actual version number
code --install-extension salesforce-copilot-inspector-<version>.vsix

# concrete example
code --install-extension salesforce-copilot-inspector-0.1.0.vsix
```

Or via the VS Code UI: open the Extensions side-bar (`Ctrl+Shift+P` → **Extensions: Install from VSIX…**) and browse to the downloaded file.

**3. Reload VS Code** when prompted — the **Salesforce Copilot Inspector** icon <img width="43" height="41" alt="image" src="https://github.com/user-attachments/assets/7b806915-c486-4728-a1d2-d4a784b47e4e" />
  will appear in the Activity Bar.

---

<img alt="image" src="https://github.com/user-attachments/assets/23b14d95-9c30-49ea-b059-d4b39d1ebec2" />

<img alt="image" src="https://github.com/user-attachments/assets/34f942d0-2876-445a-863a-4a3e83da5374" />

---

## Overview

**Salesforce Copilot Inspector** gives you a live dashboard for everything Copilot-related in your workspace. Four sidebar tabs let you inspect what is configured, create new files from templates, manage personal files stored in your user profile, and configure the Salesforce DX MCP server. Two full editor panels handle the Salesforce Skills Library and skill spec validation.

---

## Features

### Checks tab

Scans both the open workspace and your user profile and displays results grouped by category.

| Category | What is checked |
|---|---|
| **Instructions** | `.github/copilot-instructions.md`, root `copilot-instructions.md`, all `*.instructions.md` files |
| **Skills** | `SKILL.md` files in `.github/skills/`, `.claude/skills/`, `.agents/skills/`, and the personal equivalents under `~/.copilot/skills/`, `~/.claude/skills/`, `~/.agents/skills/` |
| **Prompts** | All `*.prompt.md` files in the workspace |
| **Agents** | All `*.agent.md` files and `AGENTS.md` |
| **Copilot Hooks** | `.github/hooks/*.json`, `.claude/settings.json`, `.claude/settings.local.json` — lists active lifecycle events |
| **Extensions** | GitHub Copilot and GitHub Copilot Chat installed/active status and version |
| **Settings** | `.vscode/settings.json` — flags whether Copilot keys are present |

Each result shows a status indicator:

- `✓` **ok** — file present and well-formed
- `⚠` **warn** — file present but has an issue
- `✗` **missing** — expected file not found
- `·` **info** — optional item, no action required

A **workspace** or **personal** scope badge appears next to items so you know immediately which files are committed to the repository and which live in your user profile.

**Actions available on each row:**

- Click any row with a file path to open that file in the editor.
- Click **delete** to remove a file (with a confirmation prompt).
- Click **check** on any skill to validate it against the agentskills.io spec and open the [Skill Validation Report](#skill-validation-report).
- Click **↻** in the toolbar to re-run all checks.

---

### Create (Workspace) tab

Creates Copilot files committed to the open workspace — shared with the whole team.

| File | Target path |
|---|---|
| Copilot Instructions | `.github/copilot-instructions.md` |
| Instructions File | `.github/instructions/{name}.instructions.md` |
| Prompt File | `.github/prompts/{name}.prompt.md` |
| Agent File | `.vscode/{name}.agent.md` |
| AGENTS.md | `AGENTS.md` |
| Claude Rules File | `.claude/rules/{name}.md` |
| Agent File (Claude) | `.claude/agents/{name}.agent.md` |
| Hook File | `.github/hooks/{name}.json` |
| Salesforce Skills Pack | Downloads three quality skills from [awesome-copilot](https://github.com/github/awesome-copilot) into `.github/skills/` |
| Salesforce Skills Library | Opens the [Salesforce Skills Library](#salesforce-skills-library) panel |

Files that already exist show an **Open** button instead of **Create**. Files that require a name prompt for `{name}` open an input box before creation. Every new file is pre-populated with a task-appropriate template.

---

### Create (Personal) tab

Creates Copilot files in your user profile — available in every workspace on this machine, not committed to any repository.

| File | Target path |
|---|---|
| Personal Instructions | `~/.copilot/instructions/{name}.instructions.md` |
| Personal Rules (Claude) | `~/.claude/rules/{name}.md` |
| Personal Skill | `~/.copilot/skills/{name}/SKILL.md` |
| Personal Prompt | `~/.copilot/prompts/{name}.prompt.md` |
| Personal Agent | `~/.copilot/agents/{name}.agent.md` |
| Personal Hook | `~/.copilot/hooks/{name}.json` |
| Salesforce Skills Pack | Downloads the same three awesome-copilot skills into `~/.copilot/skills/` |
| Salesforce Skills Library | Opens the [Salesforce Skills Library](#salesforce-skills-library) panel |

---

### MCP tab

Verifies and configures the [Salesforce DX MCP server](https://github.com/salesforcecli/mcp) (`@salesforce/mcp`) for your MCP clients.

#### Configuration detection

Checks three locations in priority order:

| File | Scope | Client |
|---|---|---|
| `.mcp.json` | workspace | Claude Code |
| `.vscode/mcp.json` | workspace | VS Code |
| `~/.claude/mcp.json` | personal | Claude Code (global) |

Each row shows a status indicator, a **workspace** or **personal** scope badge, and a **SHOW** button (if the file exists) to open it directly in the editor. The detected server name, orgs, toolsets, and individual tools are listed under each configured file.

#### Toolsets

Fifteen toolsets are documented with descriptions and tool lists. Non-GA (pilot/beta) tools are highlighted with an amber badge. Check a **toolset** to enable all its tools via `--toolsets`, or check individual tools to use `--tools` for a more targeted configuration. See the [MCP Reference](https://developer.salesforce.com/docs/platform/lwc/guide/mcp-reference.html) for the full toolset documentation.

| Toolset | Always on | Description |
|---|---|---|
| `core` | ✓ | Org context, metadata retrieval |
| `orgs` | | Org management (create, delete, open, snapshot) |
| `deploy-retrieve` | | Deploy and retrieve metadata |
| `apex` | | Apex development and execution |
| `data` | | Data queries and manipulation |
| `sobjects` | | SObject schema inspection |
| `code-analysis` | | Static analysis with Code Analyzer |
| `source-tracking` | | Track local vs org differences |
| `documentation` | | Fetch Salesforce developer docs |
| `agent` | | AI agent (Agentforce) configuration |
| `testing` | | Apex test execution and results |
| `flow` | | Flow building and debugging |
| `template` | | Project and scratch org templates |
| `lwc-experts` | | LWC component guidance and SLDS styling |
| `enrichment` | | Metadata enrichment for improved LLM context |

#### Non-GA Tools (Pilot / Beta)

Thirteen tools across four toolsets are currently in pilot or beta and require the `--allow-non-ga-tools` flag. Check the **--allow-non-ga-tools** checkbox before installing to include them. Checking it automatically pre-selects all non-GA tool checkboxes; unchecking clears them. On load or refresh, if `--allow-non-ga-tools` is already present in the existing config it is restored automatically.

| Tool | Toolset |
|---|---|
| `create_scratch_org`, `delete_org`, `open_org`, `create_org_snapshot` | `orgs` |
| `create-custom-rule`, `generate_xpath_prompt` | `code-analysis` |
| `explore_slds_blueprints`, `guide_slds_blueprints`, `guide_utam_generation`, `guide_slds_styling`, `explore_slds_styling`, `orchestrate_lwc_slds2_uplift` | `lwc-experts` |
| `enrich_metadata` | `enrichment` |

#### Install buttons

Requires an active default org (`sf org display`). The detected username is embedded in the generated JSON config. Two install targets are supported:

- **Install for Workspace (VS Code)** — creates or updates `.vscode/mcp.json` using the VS Code `servers` format (includes `type: "stdio"`).
- **Install for Workspace (Claude Code)** — creates or updates `.mcp.json` using the Claude Code `mcpServers` format.

Both merge with any existing content in the target file.

#### Refresh

Click **↻** next to the **Configuration** heading to re-read all MCP config files and update the status rows and pre-checked selections without reloading VS Code.

---

### Skill Validation Report

A full editor panel that validates locally installed skills against the [agentskills.io](https://agentskills.io) specification. Opened automatically when you click a **check** button on a skill row.

The report checks each installed copy of a skill for:

- **Name** — kebab-case, max 64 characters, gerund form recommended
- **Frontmatter** — valid YAML `---` block with no unquoted `: ` sequences
- **`name` field** — present and matches the directory name
- **`description` field** — double-quoted, 20–1024 words, includes trigger language
- **`metadata` block** — present as a key-value map with a valid `version: x.y` field
- **Body** — non-empty, max 500 lines recommended

Results appear in a table with error/warning counts per skill. Click any row to expand the full list of issues with links to the installed file. Use **Re-run** on an individual row or **↺ Re-run All** in the toolbar to re-validate after editing.

---

### Salesforce Skills Library

A full editor panel that browses the [forcedotcom/sf-skills](https://github.com/forcedotcom/sf-skills) repository live from GitHub.

- **Search** skills by name or description.
- **Expand** any row to see the full description, reference files, and asset files.
- **Install** a skill into `.github/skills/` (workspace) or `~/.copilot/skills/` (personal) with a single click.
- **Check** validates a locally installed copy and shows the result inline in the detail row.
- **✓ Validate Installed** runs all installed skills through the Skill Validation Report at once.

Installed skills are marked with a `✓ installed` badge and the Install button becomes **Reinstall**.

---

## Getting Started

1. Open a workspace in VS Code.
2. Click the **Salesforce Copilot Inspector** icon in the Activity Bar (left sidebar).
3. The **Checks** tab runs automatically and shows the current state of your configuration.
4. Switch to **Create (Workspace)** or **Create (Personal)** to scaffold new files.
5. Click **check** on any skill to open the Skill Validation Report.
6. Open the **Salesforce Skills Library** from the Create tabs to browse and install community skills.
7. Switch to the **MCP** tab to verify and configure the Salesforce DX MCP server for VS Code or Claude Code.

---

## Requirements

- VS Code 1.120 or later.
- An internet connection is required for the Salesforce Skills Library and the Salesforce Skills Pack installer (both fetch from GitHub). All other checks run entirely offline.
- **To use the Salesforce MCP server**: Node.js ≥ 20.19.0 or ≥ 22.12.0 is required by `@salesforce/mcp`. Node.js v20.18.x and earlier are **not** supported — the MCP tab's CHECK button will report the exact version mismatch.

---

## Installation

### 1. Build the `.vsix` package

```bash
npm install
npm run package
```

This produces `salesforce-copilot-inspector-<version>.vsix` in the project root (e.g. `salesforce-copilot-inspector-0.0.1.vsix`).

---

### 2. Install the `.vsix`

Three equivalent methods — pick whichever fits your workflow.

#### a) VS Code command palette

1. Open the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`).
2. Run **Extensions: Install from VSIX…**
3. Browse to the `.vsix` file and confirm.

#### b) Extensions view context menu

1. Open the Extensions side-bar (`Ctrl+Shift+X`).
2. Click the **`···`** menu (top-right of the panel).
3. Choose **Install from VSIX…** and select the file.

#### c) Terminal / CLI

```bash
# replace <version> with the actual version number
code --install-extension salesforce-copilot-inspector-<version>.vsix

# concrete example
code --install-extension salesforce-copilot-inspector-0.0.1.vsix
```

The `code` CLI is bundled with VS Code. On Windows it may need to be added to `PATH` via **Command Palette → Shell Command: Install 'code' command in PATH**.

---

### 3. Reload VS Code

After installation VS Code will prompt **Reload Window** — click it, or run **Developer: Reload Window** from the Command Palette. The **Salesforce Copilot Inspector** icon will then appear in the Activity Bar.

---

### Uninstall

Open the Extensions side-bar, search for **Salesforce Copilot Inspector**, click the gear icon, and choose **Uninstall**.

---

## Development

### Install and build

```bash
npm install          # install all dependencies
npm run compile      # compile TypeScript once (output → out/)
npm run watch        # recompile on every file change (keep open in a terminal)
npm run bundle       # bundle with esbuild for distribution (output → dist/)
npm run bundle:watch # bundle in watch mode
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### Run tests

```bash
npm test             # compile + lint, then run all 56 tests inside VS Code test host
npm run test         # identical — npm test is a built-in alias for npm run test
```

**`npm test` vs `npm run test`** — these two commands are exactly equivalent. `test` is one of the few lifecycle script names (`start`, `stop`, `test`, `restart`) that npm exposes as a shorthand without the `run` keyword. There is no meaningful difference between them.

**What `npm test` actually runs (in order):**

| Step | Script | Command |
|---|---|---|
| 1 | `pretest` (auto) | `npm run compile && npm run lint` |
| 2 | `test` | `vscode-test` |

`pretest` is a lifecycle hook — npm executes it automatically before `test` every time. There is no way to skip it with `npm test` alone.

**Filtering tests** — the `vscode-test` runner picks up all files matching `out/test/**/*.test.js` (configured in `.vscode-test.mjs`). To run a specific suite pass a grep pattern via the `--grep` flag:

```bash
npx vscode-test --grep "validateSkillLocal"   # run only that suite
npx vscode-test --grep "getNonce|getTemplate"  # run two suites
```

### Quality and packaging

```bash
npm run lint         # lint TypeScript sources with ESLint (eslint src)
npm run package      # production bundle + create .vsix file for manual install
```

`npm run package` runs the full pipeline:
1. `npm run bundle -- --production` — minified esbuild bundle
2. `npx @vscode/vsce package` — packages the extension into a `.vsix` file

The `.vsix` can be installed locally with **Extensions → Install from VSIX…** in VS Code.

### Lifecycle scripts reference

| Command | Alias | Triggered automatically |
|---|---|---|
| `npm run compile` | — | no |
| `npm run watch` | — | no |
| `npm run bundle` | — | no |
| `npm run bundle:watch` | — | no |
| `npm run lint` | — | no |
| `npm test` | `npm run test` | `pretest` runs first |
| `npm run package` | — | calls `vscode:prepublish` internally |

---

## Author

**Alain Cabon** — Powered by [Anthropic Claude](https://www.anthropic.com/claude)
