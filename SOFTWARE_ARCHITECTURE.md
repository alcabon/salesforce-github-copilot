# Software Architecture

## Table of Contents

1. [Overview](#1-overview)
2. [Repository Layout](#2-repository-layout)
3. [Extension Lifecycle](#3-extension-lifecycle)
4. [Component Map](#4-component-map)
5. [Webview Message Protocols](#5-webview-message-protocols)
6. [Skill Validation Engine](#6-skill-validation-engine)
7. [MCP Integration](#7-mcp-integration)
8. [Data Models](#8-data-models)
9. [Build & Release Pipeline](#9-build--release-pipeline)
10. [Security Model](#10-security-model)
11. [Skills in This Repository](#11-skills-in-this-repository)

---

## 1. Overview

**Salesforce Github Copilot** is a VS Code extension that audits and configures GitHub Copilot and Salesforce AI tooling in a workspace. It exposes a sidebar with four tabs and two full editor panels.

```mermaid
graph TD
    User["Developer in VS Code"]

    subgraph ext["Extension Host (Node.js)"]
        EP["activate()"]
        Checks["Configuration\nCheckers"]
        Validator["Skill Validation\nEngine"]
        Templates["Template\nSystem"]
        McpCfg["MCP Config\nParser"]
    end

    subgraph ui["Webview Layer (sandboxed HTML/JS)"]
        Sidebar["Sidebar Panel\n(Checks · Workspace · Personal · MCP)"]
        SkillsLib["Salesforce Skills\nLibrary Panel"]
        Report["Skill Validation\nReport Panel"]
        Summary["Summary\nPanel"]
    end

    subgraph external["External Systems"]
        GH["GitHub API\nforcedotcom/sf-skills"]
        SF["Salesforce CLI\nsf org display"]
        FS["Workspace\nFilesystem"]
    end

    User -->|"clicks / types"| Sidebar
    Sidebar <-->|"postMessage"| EP
    EP --> Checks
    EP --> Validator
    EP --> Templates
    EP --> McpCfg
    Checks --> FS
    McpCfg --> SF
    SkillsLib <-->|"postMessage"| GH
    Report <-->|"postMessage"| Validator
    Summary <-->|"postMessage"| Checks
```

**Key design decisions:**

- **Zero production npm dependencies** — all logic is pure TypeScript over Node.js built-ins (`fs`, `path`, `https`, `os`, `child_process`).
- **Single-file architecture** — the entire extension lives in `src/extension.ts` (~3 900 lines), keeping the bundle small and the build fast.
- **Webviews are sandboxed** — each panel communicates exclusively through a typed `postMessage` protocol; no shared memory with the extension host.

---

## 2. Repository Layout

```
salesforce-copilot-inspector/
├── src/
│   ├── extension.ts              # Entire extension source (~3 900 lines)
│   └── test/
│       └── extension.test.ts     # 40+ unit tests for validators
├── dist/                         # esbuild output (git-ignored)
│   └── extension.js              # Bundled, production-minified
├── out/                          # tsc output used by test runner
├── assets/
│   └── logo.png
├── media/
│   └── icon.svg
├── .github/
│   ├── workflows/
│   │   ├── audit.yml             # Weekly npm audit (high + critical)
│   │   └── release.yml           # VSIX release on v* tag
│   └── skills/                   # Repository skills (see §11)
├── .vscode/
│   ├── launch.json               # F5 Extension Development Host
│   ├── tasks.json
│   ├── settings.json
│   ├── extensions.json
│   └── mcp.json                  # Salesforce MCP for this workspace
├── esbuild.js                    # Build script
├── .vscode-test.mjs              # Test runner config
├── tsconfig.json
├── package.json
├── DEVELOPER.md
├── SOFTWARE_ARCHITECTURE.md      # this file
└── README.md
```

---

## 3. Extension Lifecycle

```mermaid
sequenceDiagram
    participant VSC as VS Code
    participant Host as Extension Host
    participant Side as Sidebar Webview
    participant FS as Filesystem

    VSC->>Host: activate(context)
    Host->>Host: new CopilotChecksViewProvider()
    Host->>VSC: registerWebviewViewProvider()
    Host->>VSC: registerCommand('refresh')

    VSC->>Side: resolveWebviewView() [user opens sidebar]
    Side-->>Host: postMessage { type: 'ready' }
    Host->>Host: runAllChecks()
    Host->>FS: discover config files
    Host->>Host: checkMcpConfig()
    Host-->>Side: postMessage { type: 'data', checks, creators, mcpFiles }

    Note over Side: User clicks Refresh
    Side-->>Host: postMessage { type: 'refresh' }
    Host->>Host: runAllChecks()
    Host-->>Side: postMessage { type: 'data', ... }

    VSC->>Host: deactivate()
```

---

## 4. Component Map

The extension exposes **four independent UI components**. Each is a separate class that manages its own webview lifecycle.

```mermaid
classDiagram
    class CopilotChecksViewProvider {
        +viewType: string
        -_extensionUri: Uri
        -_view: WebviewView
        +resolveWebviewView()
        -_sendAll(webview)
        -_handleCreate(webview, fileType)
        -_handleDelete(webview, filePath)
        -_handleCheckSkill(webview, skillName)
        -_handleInstallMcp(webview, payload)
        -_getHtmlForWebview(webview)
    }

    class SfSkillsPanel {
        +viewType: string
        -_panel: WebviewPanel
        -_extensionUri: Uri
        +createOrShow(extensionUri)
        -_update()
        -_fetchSkillsList()
        -_fetchSkillDetail(skillName)
        -_installSkill(payload)
        -_getHtmlForWebview(webview)
    }

    class SkillValidationReportPanel {
        +viewType: string
        -_panel: WebviewPanel
        -_results: Map
        +createOrShow(extensionUri, initialSkills)
        -_runValidation(skillName)
        -_runAll()
        -_getHtmlForWebview(webview)
    }

    class SummaryPanel {
        +viewType: string
        -_panel: WebviewPanel
        +createOrShow(extensionUri)
        -_buildHtml(checks, mcpFiles)
        -_exportHtml(content)
        -_getHtmlForWebview(webview)
    }

    class ValidationEngine {
        <<module-level functions>>
        +validateSkillLocal(name, dir)
        +parseFrontmatterBlockLocal(content)
        +parseMetadataBlockLocal(raw)
        +parseSkillMdContent(content)
        +findInstalledSkillPaths(name)
    }

    class ConfigCheckers {
        <<module-level functions>>
        +runAllChecks()
        +checkMcpConfig(root)
        +getDefaultOrgUsername(cwd)
    }

    class TemplateSystem {
        <<module-level functions>>
        +getTemplate(type, name)
        +getCheckDescription(check)
    }

    CopilotChecksViewProvider --> ValidationEngine : calls
    CopilotChecksViewProvider --> ConfigCheckers : calls
    CopilotChecksViewProvider --> TemplateSystem : calls
    CopilotChecksViewProvider --> SfSkillsPanel : opens
    CopilotChecksViewProvider --> SkillValidationReportPanel : opens
    CopilotChecksViewProvider --> SummaryPanel : opens
    SkillValidationReportPanel --> ValidationEngine : calls
```

### Responsibility split

| Component | Scope | Renders in |
|---|---|---|
| `CopilotChecksViewProvider` | Sidebar — 4-tab audit dashboard | Activity Bar panel |
| `SfSkillsPanel` | Browse & install `forcedotcom/sf-skills` | Full editor panel |
| `SkillValidationReportPanel` | Validate installed skills against agentskills.io spec | Full editor panel |
| `SummaryPanel` | Exportable HTML summary of all checks | Full editor panel |

---

## 5. Webview Message Protocols

Every component communicates with its webview through a **typed, one-way-at-a-time** message bus. The extension host is always authoritative.

### 5.1 Sidebar (`CopilotChecksViewProvider`)

```mermaid
sequenceDiagram
    participant WV as Sidebar Webview
    participant EH as Extension Host

    WV->>EH: { type: 'ready' }
    EH-->>WV: { type: 'loading' }
    EH-->>WV: { type: 'data', checks[], creators[], mcpFiles[] }

    WV->>EH: { type: 'refresh' }
    EH-->>WV: { type: 'loading' }
    EH-->>WV: { type: 'data', ... }

    WV->>EH: { type: 'openFile', path }
    WV->>EH: { type: 'deleteFile', path }
    WV->>EH: { type: 'createFile', fileType, name? }
    EH-->>WV: { type: 'data', ... }

    WV->>EH: { type: 'checkSkill', skillName }
    EH-->>WV: { type: 'checkSkillResult', skillName, result }

    WV->>EH: { type: 'showMcpFile', path }
    WV->>EH: { type: 'installMcp', target, toolsets[], tools[], orgUser, allowNonGa }
    EH-->>WV: { type: 'data', ... }
```

### 5.2 Skills Library (`SfSkillsPanel`)

```mermaid
sequenceDiagram
    participant WV as Skills Library Webview
    participant EH as Extension Host
    participant GH as GitHub API

    WV->>EH: { type: 'getSkillsList' }
    EH->>GH: GET /repos/forcedotcom/sf-skills/contents/skills
    GH-->>EH: directory listing
    EH-->>WV: { type: 'skillsList', skills[] }

    WV->>EH: { type: 'getSkillDetail', skillName }
    EH->>GH: GET SKILL.md + assets/ + references/
    GH-->>EH: raw content
    EH-->>WV: { type: 'skillDetail', detail }

    WV->>EH: { type: 'installSkill', skillName, scope, content }
    EH-->>WV: { type: 'installResult', ok, message }

    WV->>EH: { type: 'checkSkill', skillName, scope }
    EH-->>WV: { type: 'checkResult', skillName, result }

    WV->>EH: { type: 'validateAllInstalled' }
    EH-->>WV: { type: 'checkResult', skillName, result }  [repeated]

    WV->>EH: { type: 'openGitHub', url }
```

### 5.3 Validation Report (`SkillValidationReportPanel`)

```mermaid
sequenceDiagram
    participant WV as Report Webview
    participant EH as Extension Host

    WV->>EH: { type: 'ready' }
    EH-->>WV: { type: 'batchStart', skills[] }
    EH-->>WV: { type: 'checkResult', skillName, result }  [per skill]
    EH-->>WV: { type: 'batchDone' }

    WV->>EH: { type: 'recheck', skillName }
    EH-->>WV: { type: 'checking', skillName }
    EH-->>WV: { type: 'checkResult', skillName, result }

    WV->>EH: { type: 'recheckAll' }
    EH-->>WV: { type: 'batchStart', skills[] }
    EH-->>WV: { type: 'checkResult', skillName, result }  [repeated]
    EH-->>WV: { type: 'batchDone' }
```

---

## 6. Skill Validation Engine

The validation engine is a set of **pure, export-tested functions** with no VS Code API dependency — making them fast to unit-test.

### 6.1 Parsing pipeline

```mermaid
flowchart TD
    Raw["Raw SKILL.md content"]
    PSC["parseSkillMdContent()\nSplit frontmatter / body"]
    PFB["parseFrontmatterBlockLocal()\nExtract raw YAML between --- delimiters"]
    PMB["parseMetadataBlockLocal()\nParse metadata: sub-keys"]
    Body["Body text"]
    FM["Frontmatter fields\nname · description · metadata"]

    Raw --> PSC
    PSC --> PFB
    PFB --> PMB
    PMB --> FM
    PSC --> Body

    FM --> V["validateSkillLocal()"]
    Body --> V
    V --> Result["SkillValidationResult\nerrors[] · warnings[]"]
```

### 6.2 Validation rules

| Rule | Level | Detail |
|---|---|---|
| Directory name is kebab-case | error | lowercase, hyphens only, max 64 chars |
| Frontmatter block present | error | `---` delimiters found |
| `name` field present | error | must equal the directory name |
| `description` field present | error | double-quoted string |
| Description word count | error / warn | minimum 20 words; warning if > 1 024 chars |
| Description trigger language | warn | should contain "use" or similar imperative |
| `metadata` block present | error | key-value map (not scalar, not list) |
| `metadata.version` format | error | matches `\d+\.\d+` (e.g. `1.0`) |
| Body non-empty | error | content after frontmatter |
| Body length | warn | > 500 lines is flagged |

### 6.3 Discovery paths

```mermaid
graph LR
    subgraph workspace["Workspace scope"]
        WS1[".github/skills/{name}/SKILL.md"]
        WS2[".claude/skills/{name}/SKILL.md"]
        WS3[".agents/skills/{name}/SKILL.md"]
    end
    subgraph personal["Personal scope (~/)"]
        PS1[".copilot/skills/{name}/SKILL.md"]
        PS2[".claude/skills/{name}/SKILL.md"]
        PS3[".agents/skills/{name}/SKILL.md"]
    end
    findInstalledSkillPaths --> workspace
    findInstalledSkillPaths --> personal
```

---

## 7. MCP Integration

### 7.1 Config detection order

```mermaid
flowchart TD
    Start["checkMcpConfig(workspaceRoot)"]
    F1["Check .mcp.json\n(Claude Code — workspace)"]
    F2["Check .vscode/mcp.json\n(VS Code — workspace)"]
    F3["Check ~/.claude/mcp.json\n(Claude Code — personal)"]
    Parse["Parse @salesforce/mcp entry\nExtract --orgs --toolsets --tools --allow-non-ga-tools"]
    Result["McpFileResult[]\npath · scope · serverName · toolsets · tools · allowNonGa"]

    Start --> F1 --> F2 --> F3 --> Parse --> Result
```

### 7.2 Installation flow

```mermaid
sequenceDiagram
    participant Dev as Developer
    participant WV as MCP Tab (Webview)
    participant EH as Extension Host
    participant CLI as sf CLI
    participant FS as Filesystem

    Dev->>WV: select toolsets / tools
    Dev->>WV: click Install for Workspace
    WV->>EH: { type: 'installMcp', target, toolsets, tools, allowNonGa }
    EH->>CLI: sf org display --json
    CLI-->>EH: { username }
    EH->>EH: build MCP JSON config
    EH->>FS: write/merge .vscode/mcp.json or .mcp.json
    EH-->>WV: { type: 'data', mcpFiles[] } [refresh]
```

### 7.3 Toolsets catalogue

The extension documents 15 toolsets. Non-GA tools require `--allow-non-ga-tools`.

| Toolset | Always on | Non-GA tools |
|---|---|---|
| `core` | yes | — |
| `orgs` | | `create_scratch_org`, `delete_org`, `open_org`, `create_org_snapshot` |
| `deploy-retrieve` | | — |
| `apex` | | — |
| `data` | | — |
| `sobjects` | | — |
| `code-analysis` | | `create-custom-rule`, `generate_xpath_prompt` |
| `source-tracking` | | — |
| `documentation` | | — |
| `agent` | | — |
| `testing` | | — |
| `flow` | | — |
| `template` | | — |
| `lwc-experts` | | `explore_slds_blueprints`, `guide_slds_blueprints`, `guide_utam_generation`, `guide_slds_styling`, `explore_slds_styling`, `orchestrate_lwc_slds2_uplift` |
| `enrichment` | | `enrich_metadata` |

**Generated config — Claude Code (`.mcp.json`)**:

```json
{
  "mcpServers": {
    "Salesforce DX": {
      "command": "npx",
      "args": ["-y", "@salesforce/mcp",
               "--orgs", "devhub@example.com",
               "--toolsets", "core,apex,deploy-retrieve",
               "--allow-non-ga-tools"]
    }
  }
}
```

**Generated config — VS Code (`.vscode/mcp.json`)**:

```json
{
  "servers": {
    "Salesforce DX": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@salesforce/mcp",
               "--orgs", "devhub@example.com",
               "--toolsets", "core,apex,deploy-retrieve"]
    }
  }
}
```

---

## 8. Data Models

```mermaid
classDiagram
    class CheckResult {
        +label: string
        +status: 'ok'|'warn'|'missing'|'info'
        +detail: string
        +path?: string
        +scope?: 'workspace'|'personal'
        +skillName?: string
        +category: string
    }

    class CreatorItem {
        +id: string
        +label: string
        +description: string
        +icon: string
        +targetPath: string
        +scope: 'workspace'|'personal'
    }

    class McpFileResult {
        +path: string
        +scope: 'workspace'|'personal'
        +exists: boolean
        +serverName?: string
        +orgs?: string[]
        +toolsets?: string[]
        +tools?: string[]
        +allowNonGa?: boolean
    }

    class McpToolset {
        +name: string
        +label: string
        +description: string
        +tools: string[]
        +nonGaTools?: string[]
    }

    class SkillValidationResult {
        +skillName: string
        +dirPath: string
        +errors: string[]
        +warnings: string[]
        +isValid: boolean
    }

    class SfSkillDetail {
        +name: string
        +description: string
        +content: string
        +references: string[]
        +assets: string[]
        +githubUrl: string
    }

    class SkillReportEntry {
        +skillName: string
        +status: 'pending'|'checking'|'ok'|'warn'|'error'|'not-installed'
        +result?: SkillValidationResult
        +installedPaths: string[]
    }

    McpFileResult --> McpToolset : references
    SkillReportEntry --> SkillValidationResult : contains
```

---

## 9. Build & Release Pipeline

```mermaid
flowchart LR
    subgraph dev["Local Development"]
        SRC["src/extension.ts"]
        TSC["tsc\ntype-check → out/"]
        ESB["esbuild\nbundle → dist/"]
        WCH["--watch\nincremental rebuild"]
    end

    subgraph ci_audit["CI — Security Audit\n(every push + weekly)"]
        A1["npm install"]
        A2["npm audit --audit-level=high"]
    end

    subgraph ci_release["CI — Release\n(on v* tag push)"]
        R1["npm install"]
        R2["npm run package\n(bundle + vsce)"]
        R3["*.vsix artifact"]
        R4["GitHub Release\n+ asset upload"]
    end

    SRC --> TSC
    SRC --> ESB
    ESB --> WCH

    SRC --> ci_audit
    A1 --> A2

    SRC --> ci_release
    R1 --> R2 --> R3 --> R4
```

### Version bump procedure

```bash
npm version patch   # or minor / major
git push origin main --tags   # tag triggers the release workflow
```

`npm version` updates `package.json`, commits the change, and creates a local git tag in one step.

---

## 10. Security Model

### Content Security Policy

Every webview enforces a strict CSP using a per-request nonce generated by `getNonce()`:

```html
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none';
               style-src 'unsafe-inline' ${webview.cspSource};
               script-src 'nonce-${nonce}';">
```

- `default-src 'none'` — denies all resources by default.
- Inline styles allowed (VS Code theme variables require it).
- Only `<script nonce="…">` blocks execute — no external scripts, no `eval`.

### Destructive operations

All file deletions require explicit user confirmation:

```
vscode.window.showWarningMessage(
  `Delete ${path}?`, { modal: true }, 'Delete'
)
```

### External network access

Only two outbound calls are made:

| From | To | Purpose |
|---|---|---|
| `SfSkillsPanel` | `api.github.com` | Fetch skills catalogue & content |
| `CopilotChecksViewProvider` | `sf` CLI (subprocess) | Detect default Salesforce org |

The `https` module is used directly (no fetch polyfill, no axios) — the extension stays dependency-free.

### Dependency security

Production bundle has **zero npm dependencies**. DevDependencies are pinned via `overrides` in `package.json` to ensure transitive vulnerabilities in `mocha`'s dependencies (`diff`, `serialize-javascript`) do not surface in `npm audit --audit-level=high`.

---

## 11. Skills in This Repository

This repository ships its own GitHub Copilot skills under `.github/skills/`. Skills follow the [agentskills.io](https://agentskills.io) specification and are validated automatically by the extension itself.

```
.github/
└── skills/
    └── <skill-name>/
        └── SKILL.md          # frontmatter + body (see spec below)
```

### SKILL.md structure (agentskills.io spec)

```markdown
---
name: "skill-name"
description: "Use this skill to … (20+ words, double-quoted)"
metadata:
  version: 1.0
---

## Body

Skill instructions here (max 500 lines recommended).
```

### Planned skills for this repository

| Skill name | Purpose |
|---|---|
| `audit-copilot-config` | Guide an AI agent to audit GitHub Copilot configuration files in a workspace |
| `configure-salesforce-mcp` | Step-by-step MCP server setup for Salesforce DX in VS Code and Claude Code |
| `validate-agent-skills` | Validate SKILL.md files against the agentskills.io specification |

Skills in this repository are available to any agent (GitHub Copilot, Claude Code) that resolves `.github/skills/` — no installation step required when the workspace is open.
