import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as os from 'os';
import * as child_process from 'child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckResult {
	id: string;
	category: string;
	name: string;
	status: 'ok' | 'warn' | 'missing' | 'info';
	message: string;
	path?: string;
	scope?: 'personal' | 'workspace';
}

interface CreatorDef {
	type: string;
	icon: string;
	label: string;
	description: string;
	target: string;
	needsName: boolean;
	namePrompt?: string;
	namePlaceholder?: string;
	section?: string;
}

interface McpServerEntry {
	name: string;
	orgs: string[];
	toolsets: string[];
	tools: string[];
	allowNonGa: boolean;
}

interface McpFileResult {
	relPath: string;
	fullPath: string;
	exists: boolean;
	scope: 'workspace' | 'personal';
	hasSalesforceMcp: boolean;
	servers: McpServerEntry[];
}

interface McpToolset {
	name: string;
	label: string;
	description: string;
	alwaysOn: boolean;
	tools: string[];
	nonGaTools: string[];
}

interface CreatorItem extends CreatorDef {
	exists: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function workspacePath(rel: string): string | undefined {
	const folders = vscode.workspace.workspaceFolders;
	if (!folders?.length) { return undefined; }
	return path.join(folders[0].uri.fsPath, rel);
}

function fileExists(p: string | undefined): boolean {
	if (!p) { return false; }
	try { return fs.existsSync(p); } catch { return false; }
}

// Strip line (//) and block (/* */) comments from JSONC so JSON.parse accepts it.
function stripJsonComments(raw: string): string {
	let result = '';
	let inString = false;
	let i = 0;
	while (i < raw.length) {
		if (inString) {
			if (raw[i] === '\\') { result += raw[i++]; result += raw[i++]; continue; }
			if (raw[i] === '"') { inString = false; }
			result += raw[i++];
		} else {
			if (raw[i] === '"') { inString = true; result += raw[i++]; continue; }
			if (raw[i] === '/' && raw[i + 1] === '/') {
				while (i < raw.length && raw[i] !== '\n') { i++; }
				continue;
			}
			if (raw[i] === '/' && raw[i + 1] === '*') {
				i += 2;
				while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) { i++; }
				i += 2;
				continue;
			}
			result += raw[i++];
		}
	}
	return result;
}

export function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let nonce = '';
	for (let i = 0; i < 32; i++) {
		nonce += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return nonce;
}

function fetchUrl(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			headers: { 'User-Agent': 'salesforce-copilot-inspector-vscode/1.0', ...headers },
		}, (res) => {
			if ((res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) && res.headers.location) {
				resolve(fetchUrl(res.headers.location, headers));
				res.resume();
				return;
			}
			if (res.statusCode && res.statusCode >= 400) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode}`));
				return;
			}
			res.setEncoding('utf8');
			let data = '';
			res.on('data', (chunk: string) => { data += chunk; });
			res.on('end', () => resolve(data));
		});
		req.on('error', reject);
	});
}

// ---------------------------------------------------------------------------
// Skill validation (ported from validate-skills.ts — no external deps)
// ---------------------------------------------------------------------------

export interface SkillValidationResult {
	errors: string[];
	warnings: string[];
}

/** Raw YAML between the opening and closing `---` lines (no delimiters), or null. */
export function parseFrontmatterBlockLocal(content: string): { raw: string; fullMatchLen: number } | null {
	const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
	if (!match) { return null; }
	return { raw: match[1], fullMatchLen: match[0].length };
}

/**
 * Extracts nested key-value pairs from the `metadata:` block in raw frontmatter.
 * Returns `null` (no block), `"scalar"` (inline), `"list"` (YAML list), or a Record.
 */
export function parseMetadataBlockLocal(rawFrontmatter: string): Record<string, string> | 'scalar' | 'list' | null {
	const lines = rawFrontmatter.split(/\r?\n/);
	const metaIdx = lines.findIndex(l => /^metadata\s*:/.test(l));
	if (metaIdx === -1) { return null; }
	const metaLine = lines[metaIdx];
	const inlineValue = metaLine.slice(metaLine.indexOf(':') + 1).trim();
	if (inlineValue && !inlineValue.startsWith('#')) { return 'scalar'; }
	const result: Record<string, string> = {};
	for (let i = metaIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.startsWith(' ') && !line.startsWith('\t')) { break; }
		const trimmed = line.trim();
		if (trimmed.startsWith('- ')) { return 'list'; }
		const colonIdx = trimmed.indexOf(':');
		if (colonIdx === -1) { continue; }
		const key = trimmed.slice(0, colonIdx).trim();
		const raw = trimmed.slice(colonIdx + 1).trim();
		result[key] = raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}
	return result;
}

/** Parses a SKILL.md string into frontmatter map and body. */
export function parseSkillMdContent(content: string): {
	rawFrontmatter: string | null;
	frontmatter: Record<string, string> | null;
	body: string;
} {
	const block = parseFrontmatterBlockLocal(content);
	if (!block) { return { rawFrontmatter: null, frontmatter: null, body: content }; }
	const frontmatter: Record<string, string> = {};
	for (const line of block.raw.split(/\r?\n/)) {
		const colonIdx = line.indexOf(':');
		if (colonIdx === -1) { continue; }
		const key = line.slice(0, colonIdx).trim();
		const raw = line.slice(colonIdx + 1).trim();
		frontmatter[key] = raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}
	return { rawFrontmatter: block.raw, frontmatter, body: content.slice(block.fullMatchLen) };
}

/**
 * Runs all structure + content validation checks against a locally installed skill directory.
 * Mirrors the checks from validate-skills.ts (no js-yaml — uses string-level YAML analysis).
 */
export function validateSkillLocal(skillName: string, dirPath: string): SkillValidationResult {
	const errors: string[] = [];
	const warnings: string[] = [];

	if (!fs.existsSync(dirPath)) {
		return { errors: [`${skillName}: directory not found at ${dirPath}`], warnings: [] };
	}
	try {
		if (!fs.statSync(dirPath).isDirectory()) {
			return { errors: [`${skillName}: expected a directory, found a file`], warnings: [] };
		}
	} catch (e) { return { errors: [`${skillName}: cannot stat path — ${String(e)}`], warnings: [] }; }

	const skillMdPath = path.join(dirPath, 'SKILL.md');
	if (!fs.existsSync(skillMdPath)) {
		return { errors: [`${skillName}: SKILL.md not found in ${dirPath}`], warnings: [] };
	}

	// Name format checks
	if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(skillName)) {
		errors.push(`${skillName}: name must be kebab-case (lowercase letters, digits, hyphens only)`);
	}
	if (skillName.length > 64) {
		errors.push(`${skillName}: name is ${skillName.length} characters (maximum 64)`);
	}
	if (!skillName.split('-')[0].endsWith('ing')) {
		warnings.push(`${skillName}: name should use gerund form (e.g. generating-apex-tests)`);
	}

	let content: string;
	try { content = fs.readFileSync(skillMdPath, 'utf8'); }
	catch (e) { return { errors: [`${skillName}: cannot read SKILL.md — ${String(e)}`], warnings }; }

	const { rawFrontmatter, frontmatter, body } = parseSkillMdContent(content);

	if (!frontmatter) {
		errors.push(`${skillName}/SKILL.md: missing or malformed YAML frontmatter (expected --- … --- block)`);
		return { errors, warnings };
	}

	// Detect unquoted colon-space patterns in frontmatter values (simplified YAML strictness check)
	for (const line of (rawFrontmatter ?? '').split(/\r?\n/)) {
		const ci = line.indexOf(':');
		if (ci === -1) { continue; }
		const val = line.slice(ci + 1).trim();
		if (!val.startsWith('"') && !val.startsWith("'") && val.includes(': ') && !val.startsWith('{') && !val.startsWith('[')) {
			errors.push(`${skillName}/SKILL.md: frontmatter line contains unquoted ': ' — wrap value in quotes: ${line.slice(0, 80)}`);
		}
	}

	// name field
	if (!frontmatter.name) {
		errors.push(`${skillName}/SKILL.md: missing "name" field in frontmatter`);
	} else if (frontmatter.name !== skillName) {
		errors.push(`${skillName}/SKILL.md: "name" value ("${frontmatter.name}") does not match directory name ("${skillName}")`);
	}

	// description field
	if (!frontmatter.description?.trim()) {
		errors.push(`${skillName}/SKILL.md: missing or empty "description" field`);
	} else {
		const descLine = (rawFrontmatter ?? '').split(/\r?\n/).find(l => l.startsWith('description:'));
		if (descLine) {
			const rawVal = descLine.slice(descLine.indexOf(':') + 1).trim();
			if (!rawVal.startsWith('"') || !rawVal.endsWith('"')) {
				errors.push(`${skillName}/SKILL.md: description value must be wrapped in double quotes`);
			} else {
				const inner = rawVal.slice(1, -1);
				const stripped = inner.replace(/\\\\|\\"/g, '');
				if (stripped.includes('"')) { errors.push(`${skillName}/SKILL.md: description contains unescaped " (use \\")`); }
				if (stripped.includes('\\')) { errors.push(`${skillName}/SKILL.md: description contains unescaped \\ (use \\\\)`); }
			}
		}
		const words = frontmatter.description.trim().split(/\s+/);
		if (words.length < 20) {
			warnings.push(`${skillName}/SKILL.md: description too short (${words.length} word(s), minimum 20)`);
		}
		if (frontmatter.description.length > 1024) {
			errors.push(`${skillName}/SKILL.md: description is ${frontmatter.description.length} characters (maximum 1024)`);
		}
		if (!frontmatter.description.toLowerCase().includes('use')) {
			warnings.push(`${skillName}/SKILL.md: description should include trigger language (e.g. "Use this skill when…")`);
		}
	}

	// body
	if (!body.trim()) {
		errors.push(`${skillName}/SKILL.md: body (instructions after frontmatter) is empty`);
	} else {
		const lineCount = body.split('\n').length;
		if (lineCount > 500) {
			warnings.push(`${skillName}/SKILL.md: body is ${lineCount} lines (recommended maximum 500)`);
		}
	}

	// metadata block
	const meta = parseMetadataBlockLocal(rawFrontmatter ?? '');
	if (meta === null) {
		errors.push(`${skillName}/SKILL.md: frontmatter must include a "metadata:" block with a "version" field`);
	} else if (meta === 'scalar') {
		errors.push(`${skillName}/SKILL.md: "metadata" must be a key-value map, not an inline scalar`);
	} else if (meta === 'list') {
		errors.push(`${skillName}/SKILL.md: "metadata" must be a key-value map, not a YAML list`);
	} else {
		if (!meta.version) {
			errors.push(`${skillName}/SKILL.md: metadata missing required "version" field (e.g. version: "1.0")`);
		} else if (!/^\d+\.\d+$/.test(meta.version)) {
			errors.push(`${skillName}/SKILL.md: version must follow x.y format — got "${meta.version}"`);
		}
	}

	return { errors, warnings };
}

/**
 * Returns all installed copies of a skill (multiple locations possible).
 * Searches workspace .github/skills/, .claude/skills/, .agents/skills/ and user home equivalents.
 */
function findInstalledSkillPaths(skillName: string, workspaceRoot?: string): string[] {
	const candidates: string[] = [];
	if (workspaceRoot) {
		candidates.push(path.join(workspaceRoot, '.github', 'skills', skillName));
		candidates.push(path.join(workspaceRoot, '.claude', 'skills', skillName));
		candidates.push(path.join(workspaceRoot, '.agents', 'skills', skillName));
	}
	candidates.push(path.join(os.homedir(), '.copilot', 'skills', skillName));
	candidates.push(path.join(os.homedir(), '.claude', 'skills', skillName));
	candidates.push(path.join(os.homedir(), '.agents', 'skills', skillName));
	return candidates.filter(p => fileExists(path.join(p, 'SKILL.md')));
}

// ---------------------------------------------------------------------------
// Awesome-Copilot Salesforce skills metadata
// ---------------------------------------------------------------------------

const AWESOME_COPILOT_SALESFORCE_SKILLS = [
	{
		name: 'salesforce-apex-quality',
		label: 'Apex Quality Guardrails',
		rawUrl: 'https://raw.githubusercontent.com/github/awesome-copilot/main/skills/salesforce-apex-quality/SKILL.md',
	},
	{
		name: 'salesforce-component-standards',
		label: 'Component Quality Standards',
		rawUrl: 'https://raw.githubusercontent.com/github/awesome-copilot/main/skills/salesforce-component-standards/SKILL.md',
	},
	{
		name: 'salesforce-flow-design',
		label: 'Flow Design & Validation',
		rawUrl: 'https://raw.githubusercontent.com/github/awesome-copilot/main/skills/salesforce-flow-design/SKILL.md',
	},
];

// ---------------------------------------------------------------------------
// Creator definitions
// ---------------------------------------------------------------------------

const CREATORS: CreatorDef[] = [
	{
		type: 'salesforce-awesome-skills',
		icon: '⚡',
		label: 'Salesforce Skills Pack',
		description: 'Install 3 Salesforce quality skills (Apex, Components, Flow) from awesome-copilot',
		target: '.github/skills/',
		needsName: false,
	},
	{
		type: 'sf-skills-library',
		icon: '☁',
		label: 'Salesforce Skills Library',
		description: 'Browse & install all Salesforce skills from forcedotcom/sf-skills',
		target: 'forcedotcom/sf-skills',
		needsName: false,
	},
	{
		type: 'copilot-instructions',
		icon: '≡',
		label: 'Copilot Instructions',
		description: 'Global repo instructions for Copilot',
		target: '.github/copilot-instructions.md',
		needsName: false,
	},
	{
		type: 'instructions',
		icon: '✎',
		label: 'Instructions File',
		description: 'Scoped instructions (.instructions.md)',
		target: '.github/instructions/{name}.instructions.md',
		needsName: true,
		namePrompt: 'Instructions file name (without extension)',
		namePlaceholder: 'my-feature',
	},
	{
		type: 'prompt',
		icon: '▷',
		label: 'Prompt File',
		description: 'Reusable prompt template (.prompt.md)',
		target: '.github/prompts/{name}.prompt.md',
		needsName: true,
		namePrompt: 'Prompt file name (without extension)',
		namePlaceholder: 'my-prompt',
	},
	{
		type: 'agent',
		icon: '◈',
		label: 'Agent File',
		description: 'Custom Copilot agent (.agent.md)',
		target: '.vscode/{name}.agent.md',
		needsName: true,
		namePrompt: 'Agent name',
		namePlaceholder: 'my-agent',
	},
	{
		type: 'agents-md',
		icon: '☰',
		label: 'AGENTS.md',
		description: 'Agent registry at workspace root',
		target: 'AGENTS.md',
		needsName: false,
	},
	{
		type: 'claude-rules',
		icon: '✎',
		label: 'Claude Rules File',
		description: 'Workspace-scoped rules for Claude agents (.claude/rules)',
		target: '.claude/rules/{name}.md',
		needsName: true,
		namePrompt: 'Rules file name (without extension)',
		namePlaceholder: 'my-rules',
	},
	{
		type: 'claude-agent',
		icon: '◈',
		label: 'Agent File (Claude)',
		description: 'Workspace-scoped Claude agent (.claude/agents)',
		target: '.claude/agents/{name}.agent.md',
		needsName: true,
		namePrompt: 'Agent name',
		namePlaceholder: 'my-agent',
	},
	{
		type: 'hook',
		icon: '↻',
		label: 'Hook File',
		description: 'Copilot lifecycle hook — PreToolUse, SessionStart, …',
		target: '.github/hooks/{name}.json',
		needsName: true,
		namePrompt: 'Hook file name (without extension)',
		namePlaceholder: 'validate-edits',
	},
];

// Personal creators — files written to the user profile (~/.copilot/, ~/.claude/, ~/.agents/)
const PERSONAL_CREATORS: CreatorDef[] = [
	{
		type: 'salesforce-awesome-skills',
		icon: '⚡',
		label: 'Salesforce Skills Pack',
		description: 'Install 3 Salesforce quality skills (Apex, Components, Flow) from awesome-copilot',
		target: '~/.copilot/skills/',
		needsName: false,
	},
	{
		type: 'sf-skills-library',
		icon: '☁',
		label: 'Salesforce Skills Library',
		description: 'Browse & install all Salesforce skills from forcedotcom/sf-skills',
		target: '~/.copilot/skills/',
		needsName: false,
	},
	{
		type: 'personal-instructions',
		icon: '✎',
		label: 'Personal Instructions',
		description: 'User-scoped instructions — active in every workspace',
		target: '~/.copilot/instructions/{name}.instructions.md',
		needsName: true,
		namePrompt: 'Instructions file name (without extension)',
		namePlaceholder: 'my-standards',
	},
	{
		type: 'personal-claude-rules',
		icon: '✎',
		label: 'Personal Rules (Claude)',
		description: 'User-scoped Claude rules — active in every workspace',
		target: '~/.claude/rules/{name}.md',
		needsName: true,
		namePrompt: 'Rules file name (without extension)',
		namePlaceholder: 'my-rules',
	},
	{
		type: 'personal-skill',
		icon: '⚙',
		label: 'Personal Skill',
		description: 'User-scoped skill (SKILL.md) — available in every workspace',
		target: '~/.copilot/skills/{name}/SKILL.md',
		needsName: true,
		namePrompt: 'Skill name (lowercase, hyphens)',
		namePlaceholder: 'my-skill',
	},
	{
		type: 'personal-prompt',
		icon: '▷',
		label: 'Personal Prompt',
		description: 'User-scoped reusable prompt (.prompt.md) — available in every workspace',
		target: '~/.copilot/prompts/{name}.prompt.md',
		needsName: true,
		namePrompt: 'Prompt file name (without extension)',
		namePlaceholder: 'my-prompt',
	},
	{
		type: 'personal-agent',
		icon: '◈',
		label: 'Personal Agent',
		description: 'User-scoped custom agent (.agent.md) — available in every workspace',
		target: '~/.copilot/agents/{name}.agent.md',
		needsName: true,
		namePrompt: 'Agent name',
		namePlaceholder: 'my-agent',
	},
	{
		type: 'personal-hook',
		icon: '↻',
		label: 'Personal Hook',
		description: 'User-scoped Copilot lifecycle hook — applies to every workspace',
		target: '~/.copilot/hooks/{name}.json',
		needsName: true,
		namePrompt: 'Hook file name (without extension)',
		namePlaceholder: 'validate-edits',
	},
];

// ---------------------------------------------------------------------------
// Salesforce MCP toolsets (from github.com/salesforcecli/mcp)
// ---------------------------------------------------------------------------

const MCP_TOOLSETS: McpToolset[] = [
	{ name: 'core',               alwaysOn: true,  label: 'Core',               description: 'Core DX tools — always enabled.',                                                                                       nonGaTools: [],                                                                                                                                                         tools: ['get_username', 'resume_tool_operation'] },
	{ name: 'orgs',               alwaysOn: false, label: 'Orgs',               description: 'Org management: list all orgs, plus create/delete/open scratch orgs and snapshots (non-GA).',                           nonGaTools: ['create_scratch_org', 'delete_org', 'open_org', 'create_org_snapshot'],                                                                                    tools: ['list_all_orgs', 'create_scratch_org', 'delete_org', 'open_org', 'create_org_snapshot'] },
	{ name: 'metadata',           alwaysOn: false, label: 'Metadata',           description: 'Deploy and retrieve metadata between the local project and the Salesforce org.',                                         nonGaTools: [],                                                                                                                                                         tools: ['deploy_metadata', 'retrieve_metadata'] },
	{ name: 'data',               alwaysOn: false, label: 'Data',               description: 'Run SOQL queries against the connected org.',                                                                            nonGaTools: [],                                                                                                                                                         tools: ['run_soql_query'] },
	{ name: 'users',              alwaysOn: false, label: 'Users',              description: 'User management: assign permission sets to org users.',                                                                   nonGaTools: [],                                                                                                                                                         tools: ['assign_permission_set'] },
	{ name: 'testing',            alwaysOn: false, label: 'Testing',            description: 'Run Apex unit tests and Agent (bot) tests against the org.',                                                             nonGaTools: [],                                                                                                                                                         tools: ['run_apex_test', 'run_agent_test'] },
	{ name: 'code-analysis',      alwaysOn: false, label: 'Code Analysis',      description: 'Static analysis with Salesforce Code Analyzer: run rules, list/describe rules, query results, create custom rules (non-GA) and XPath generation (non-GA).', nonGaTools: ['create_custom_rule', 'get_ast_nodes_to_generate_xpath'],                                                       tools: ['run_code_analyzer', 'list_code_analyzer_rules', 'describe_code_analyzer_rule', 'query_code_analyzer_results', 'create_custom_rule', 'get_ast_nodes_to_generate_xpath'] },
	{ name: 'aura-experts',       alwaysOn: false, label: 'Aura Experts',       description: 'Aura component analysis and guided Aura→LWC migration.',                                                                 nonGaTools: [],                                                                                                                                                         tools: ['create_aura_blueprint_draft', 'enhance_aura_blueprint_draft', 'orchestrate_aura_migration', 'transition_prd_to_lwc'] },
	{ name: 'lwc-experts',        alwaysOn: false, label: 'LWC Experts',        description: '40+ tools for LWC component authoring, design, LDS guidance, SLDS v2 uplift and migration. Several tools are non-GA.',  nonGaTools: ['explore_slds_blueprints', 'guide_slds_blueprints', 'guide_utam_generation', 'guide_slds_styling', 'explore_slds_styling', 'orchestrate_lwc_slds2_uplift'], tools: ['create_lwc_component', 'enhance_lwc_component', 'apply_lds_guidelines', 'orchestrate_lwc_workflow', 'explore_slds_blueprints', 'guide_slds_blueprints', 'guide_utam_generation', 'guide_slds_styling', 'explore_slds_styling', 'orchestrate_lwc_slds2_uplift', '…36 more GA tools'] },
	{ name: 'mobile',             alwaysOn: false, label: 'Mobile',             description: 'Mobile development: 13+ device-feature tools (barcode, biometrics, calendar, contacts, document scanner, geofencing, location, NFC, payments, AR, offline analysis).', nonGaTools: [],                                                                                                    tools: ['barcode_scanner', 'biometrics', 'calendar', 'contacts', 'document_scanner', 'geofencing', 'location', 'nfc', 'payments', 'offline_analysis', '…3 more'] },
	{ name: 'mobile-core',        alwaysOn: false, label: 'Mobile Core',        description: 'Subset of Mobile: barcode scanner, biometrics, location and offline analysis.',                                          nonGaTools: [],                                                                                                                                                         tools: ['barcode_scanner', 'biometrics', 'location', 'offline_analysis'] },
	{ name: 'devops',             alwaysOn: false, label: 'DevOps',             description: 'DevOps Center integration (11 tools): commit status, checkout, merge-conflict detection/resolution, work item management and branch promotion.', nonGaTools: [],                                                                                                                        tools: ['get_commit_status', 'checkout_branch', 'detect_merge_conflicts', 'resolve_merge_conflicts', 'list_work_items', 'promote_branch', '…5 more'] },
	{ name: 'enrichment',         alwaysOn: false, label: 'Enrichment',         description: 'Metadata enrichment — adds richer semantic context to org metadata for better LLM responses. Tool is non-GA.',          nonGaTools: ['enrich_metadata'],                                                                                                                                tools: ['enrich_metadata'] },
	{ name: 'experts-validation', alwaysOn: false, label: 'Experts Validation', description: 'Production-readiness scoring: validate implementations and score issues against best-practice rubrics.',                 nonGaTools: [],                                                                                                                                                         tools: ['validate_and_optimize', 'score_issues'] },
	{ name: 'scale-products',     alwaysOn: false, label: 'Scale Products',     description: 'Apex performance analysis: scan Apex classes for known antipatterns affecting scalability.',                              nonGaTools: [],                                                                                                                                                         tools: ['scan_apex_class_for_antipatterns'] },
];

const MCP_NONGA_INFO: Record<string, string> = {
	'create_scratch_org':           'Create a new scratch org from a definition file.',
	'delete_org':                   'Permanently delete a scratch org or sandbox.',
	'open_org':                     'Open the default or specified Salesforce org in a browser.',
	'create_org_snapshot':          'Create a snapshot of an existing org configuration for reuse.',
	'create_custom_rule':           'Create a custom static-analysis rule for Code Analyzer using XPath expressions.',
	'get_ast_nodes_to_generate_xpath': 'Get AST nodes to help author the XPath for a custom Code Analyzer rule.',
	'enrich_metadata':              'Enrich Salesforce metadata with deeper semantic context to improve LLM response quality.',
	'explore_slds_blueprints':      'Explore SLDS (Salesforce Lightning Design System) component blueprints and guidelines.',
	'guide_slds_blueprints':        'Receive LLM-guided walkthroughs for implementing SLDS component blueprints.',
	'guide_utam_generation':        'Generate UTAM (UI Test Automation Model) page-object structure and guidance.',
	'guide_slds_styling':           'Get best-practice guidance for SLDS design tokens and styling approaches.',
	'explore_slds_styling':         'Explore available SLDS styling options, design tokens and their values.',
	'orchestrate_lwc_slds2_uplift': 'Orchestrate the full SLDS v2 uplift migration workflow for LWC components.',
};

// ---------------------------------------------------------------------------
// Live MCP toolset discovery (Option C)
//
// Query the user's actually-installed @salesforce/mcp server over the MCP
// stdio protocol, then reconcile the result against the built-in MCP_TOOLSETS
// catalog above. The catalog remains the fallback whenever discovery cannot
// run (no org, npx/network failure, timeout). Two protocol facts shape this:
//   • `tools/list` is FLAT — it carries no toolset grouping, so membership is
//     learned by probing one `--toolsets <name>` at a time.
//   • GA vs non-GA is not exposed per tool, so it is derived by diffing the
//     full `--toolsets all` run against the same run WITHOUT non-GA tools.
// ---------------------------------------------------------------------------

interface JsonRpcMessage {
	jsonrpc: '2.0';
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: unknown;
}

interface McpDiscoveryResult {
	toolsets: McpToolset[];
	nonGaInfo: Record<string, string>;
	probedToolsets: number;
	failedToolsets: string[];
}

// Speak just enough of the MCP stdio protocol to call tools/list once and
// return the exposed tool names for the given --toolsets selection. Resolves
// null if the server cannot be started or queried within the timeout.
function listMcpServerTools(
	org: string,
	toolsets: string,
	allowNonGa: boolean,
	cwd: string,
	timeoutMs = 60000,
): Promise<string[] | null> {
	return new Promise((resolve) => {
		const args = ['-y', '@salesforce/mcp', '--orgs', org, '--toolsets', toolsets];
		if (allowNonGa) { args.push('--allow-non-ga-tools'); }

		const isWin = process.platform === 'win32';
		let child: child_process.ChildProcess;
		try {
			// Node refuses to spawn a .cmd shim without a shell on Windows.
			child = child_process.spawn(isWin ? 'npx.cmd' : 'npx', args, {
				cwd,
				windowsHide: true,
				shell: isWin,
			});
		} catch {
			resolve(null);
			return;
		}
		if (!child.stdin || !child.stdout) { resolve(null); return; }
		const stdin = child.stdin;

		let settled = false;
		const tools: string[] = [];
		let buf = '';

		const finish = (result: string[] | null) => {
			if (settled) { return; }
			settled = true;
			clearTimeout(timer);
			try { child.kill(); } catch { /* ignore */ }
			resolve(result);
		};
		const timer = setTimeout(() => finish(null), timeoutMs);

		const send = (msg: JsonRpcMessage) => {
			try { stdin.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
		};

		const handle = (msg: JsonRpcMessage) => {
			if (msg.id === 1) {                       // initialize response
				if (msg.error) { finish(null); return; }
				send({ jsonrpc: '2.0', method: 'notifications/initialized' });
				send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
			} else if (msg.id === 2 && msg.result) {  // tools/list response (paginated)
				const r = msg.result as { tools?: Array<{ name?: string }>; nextCursor?: string };
				for (const t of r.tools ?? []) { if (t.name) { tools.push(t.name); } }
				if (r.nextCursor) {
					send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: { cursor: r.nextCursor } });
				} else {
					finish(tools);
				}
			}
		};

		child.on('error', () => finish(null));
		child.on('exit', () => finish(tools.length ? tools : null));
		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			// MCP stdio framing is newline-delimited JSON; tolerate noise lines.
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) { continue; }
				try { handle(JSON.parse(line) as JsonRpcMessage); } catch { /* not a JSON-RPC line */ }
			}
		});

		send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'salesforce-copilot-inspector', version: '1.0.0' },
			},
		});
	});
}

// Run an async mapper over items with a bounded number of in-flight calls.
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const idx = next++;
			results[idx] = await fn(items[idx]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

// Discover toolsets/tools/GA-status from the installed server. Returns null on
// total failure (caller then keeps the built-in catalog); on partial failure
// the toolsets that could not be probed keep their built-in definition.
async function discoverMcpToolsets(org: string, cwd: string): Promise<McpDiscoveryResult | null> {
	// Global GA set across every toolset. Run first (sequentially) so the npx
	// download is cached before the parallel per-toolset probes fan out.
	const gaAll = await listMcpServerTools(org, 'all', false, cwd);
	if (!gaAll) { return null; }
	const gaSet = new Set(gaAll);

	// Per-toolset membership (non-GA tools included so we can classify them).
	const names = MCP_TOOLSETS.map(t => t.name);
	const probed = await mapWithConcurrency(names, 4, async (name) => ({
		name,
		tools: await listMcpServerTools(org, name, true, cwd),
	}));

	const failed: string[] = [];
	const discoveredNonGa: Record<string, string> = {};
	const toolsets: McpToolset[] = MCP_TOOLSETS.map((base) => {
		const found = probed.find(p => p.name === base.name);
		if (!found?.tools || found.tools.length === 0) {
			failed.push(base.name);
			return base; // keep the built-in definition for this toolset
		}
		const tools = [...found.tools].sort();
		const nonGaTools = tools.filter(t => !gaSet.has(t));
		for (const t of nonGaTools) { discoveredNonGa[t] = MCP_NONGA_INFO[t] ?? ''; }
		return { ...base, tools, nonGaTools };
	});

	if (failed.length === MCP_TOOLSETS.length) { return null; }

	return {
		toolsets,
		nonGaInfo: { ...MCP_NONGA_INFO, ...discoveredNonGa },
		probedToolsets: MCP_TOOLSETS.length - failed.length,
		failedToolsets: failed,
	};
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export function getTemplate(type: string, name: string): string {
	switch (type) {
		case 'copilot-instructions':
			return [
				'# Copilot Instructions',
				'',
				'Guidelines for GitHub Copilot in this repository.',
				'',
				'## General Guidelines',
				'',
				'- Follow existing code conventions and patterns',
				'- Write clean, readable, and maintainable code',
				'- Prefer explicit over implicit when possible',
				'- Add comments for non-obvious logic',
				'',
				'## Code Style',
				'',
				'- Use meaningful names for variables, functions, and types',
				'- Keep functions small and focused on a single task',
				'- Handle errors gracefully',
				'',
				'## Project Context',
				'',
				'<!-- Add specific context about your project here -->',
			].join('\n');

		case 'instructions':
			return [
				'---',
				'applyTo: "**"',
				'---',
				'',
				`# ${name}`,
				'',
				'<!-- Describe the context and rules for these instructions -->',
				'',
				'## Rules',
				'',
				'- Rule 1',
				'- Rule 2',
				'',
				'## Examples',
				'',
				'<!-- Add examples if helpful -->',
			].join('\n');

		case 'prompt':
			return [
				'---',
				'mode: "ask"',
				`description: "A reusable prompt for ${name}"`,
				'---',
				'',
				`# ${name}`,
				'',
				'<!-- Describe what this prompt does and when to use it -->',
				'',
				'## Instructions',
				'',
				'1. Step one',
				'2. Step two',
				'',
				'## Expected Output',
				'',
				'<!-- Describe the expected result -->',
			].join('\n');

		case 'agent':
			return [
				'---',
				`name: "${name}"`,
				`description: "A custom agent for ${name} tasks"`,
				'tools:',
				'  - editFiles',
				'  - runCommands',
				'  - readFiles',
				'---',
				'',
				`# ${name}`,
				'',
				"<!-- Describe this agent's purpose and capabilities -->",
				'',
				'## Responsibilities',
				'',
				'- Responsibility 1',
				'- Responsibility 2',
				'',
				'## Behavior',
				'',
				'<!-- Define how this agent should behave -->',
			].join('\n');

		case 'agents-md':
			return [
				'# Agents',
				'',
				'This file documents the AI agents configured for this repository.',
				'',
				'## Available Agents',
				'',
				'| Agent | File | Description |',
				'|-------|------|-------------|',
				'| Example | `.vscode/example.agent.md` | An example agent |',
				'',
				'## Usage',
				'',
				'Reference agents in GitHub Copilot Chat using `@agent-name`.',
				'',
				'## Creating a New Agent',
				'',
				'Add a `.agent.md` file in `.vscode/` with the appropriate frontmatter.',
			].join('\n');

		case 'hook': {
			// Lifecycle events: PreToolUse (blocking), PostToolUse, SessionStart,
			// UserPromptSubmit, PreCompact, SubagentStart, SubagentStop, Stop.
			// Only PreToolUse can deny tool calls; all others are observational.
			const hookJson = {
				hooks: {
					PreToolUse: [
						{
							type: 'command',
							command: `./scripts/${name}.sh`,
							timeout: 15,
							windows: `.\\scripts\\${name}.ps1`,
						},
					],
					// Observational — add commands to these arrays as needed:
					PostToolUse:      [] as unknown[],
					SessionStart:     [] as unknown[],
					UserPromptSubmit: [] as unknown[],
					PreCompact:       [] as unknown[],
					SubagentStart:    [] as unknown[],
					SubagentStop:     [] as unknown[],
					Stop:             [] as unknown[],
				},
			};
			// JSON.stringify produces valid JSON; the comment above is TypeScript-only.
			return JSON.stringify(hookJson, null, 2);
		}

		default:
			// personal-agent / claude-agent → same structure as agent
			if (type === 'personal-agent' || type === 'claude-agent') {
				return getTemplate('agent', name);
			}
			// personal-hook → same JSON structure as hook
			if (type === 'personal-hook') {
				return getTemplate('hook', name);
			}
			// personal-instructions, personal-claude-rules → reuse the instructions template
			if (type.startsWith('personal-instructions') || type === 'claude-rules') {
				return [
					'---',
					type === 'personal-claude-rules' || type === 'claude-rules'
						? "paths:\n  - '**'"
						: 'applyTo: "**"',
					'---',
					'',
					`# ${name}`,
					'',
					'<!-- Describe the context and rules for these instructions -->',
					'',
					'## Rules',
					'',
					'- Rule 1',
					'- Rule 2',
				].join('\n');
			}
			// personal-skill → SKILL.md frontmatter
			if (type === 'personal-skill') {
				return [
					'---',
					`name: ${name}`,
					`description: 'Describe what this skill does and when to use it — this is what Copilot matches against'`,
					'---',
					'',
					`## Overview`,
					'',
					`Guidelines for ${name}.`,
					'',
					'## When to use',
					'',
					'<!-- Describe when Copilot should auto-load this skill -->',
				].join('\n');
			}
			// personal-prompt → reuse prompt template
			if (type === 'personal-prompt') {
				return [
					'---',
					'mode: "ask"',
					`description: "A reusable prompt for ${name}"`,
					'---',
					'',
					`# ${name}`,
					'',
					'## Instructions',
					'',
					'1. Step one',
					'2. Step two',
				].join('\n');
			}
			return '';
	}
}

// ---------------------------------------------------------------------------
// Creator items builder
// ---------------------------------------------------------------------------

function getCreatorItems(): CreatorItem[] {
	return CREATORS.map(def => {
		if (!def.needsName) {
			if (def.type === 'salesforce-awesome-skills') {
				const allInstalled = AWESOME_COPILOT_SALESFORCE_SKILLS.every(s =>
					fileExists(workspacePath(`.github/skills/${s.name}/SKILL.md`))
					|| fileExists(workspacePath(`.claude/skills/${s.name}/SKILL.md`))
					|| fileExists(workspacePath(`.agents/skills/${s.name}/SKILL.md`))
				);
				return { ...def, exists: allInstalled };
			}
			if (def.type === 'sf-skills-library') {
				return { ...def, exists: false };
			}
			const p = workspacePath(def.target);
			return { ...def, exists: fileExists(p) };
		}
		return { ...def, exists: false };
	});
}

function getPersonalCreatorItems(): CreatorItem[] {
	return PERSONAL_CREATORS.map(def => {
		if (def.type === 'salesforce-awesome-skills') {
			const personalInstalled = AWESOME_COPILOT_SALESFORCE_SKILLS.every(s =>
				fileExists(path.join(os.homedir(), '.copilot', 'skills', s.name, 'SKILL.md'))
				|| fileExists(path.join(os.homedir(), '.claude', 'skills', s.name, 'SKILL.md'))
				|| fileExists(path.join(os.homedir(), '.agents', 'skills', s.name, 'SKILL.md'))
			);
			return { ...def, exists: personalInstalled };
		}
		if (def.type === 'sf-skills-library') {
			return { ...def, exists: false };
		}
		return { ...def, exists: false };
	});
}

// ---------------------------------------------------------------------------
// Checks runner
// ---------------------------------------------------------------------------
// MCP configuration checker
// ---------------------------------------------------------------------------

function getDefaultOrgUsername(cwd: string): Promise<string | null> {
	return new Promise((resolve) => {
		const cmd = process.platform === 'win32' ? 'sf.cmd' : 'sf';
		child_process.exec(`${cmd} org display --json`, { cwd, timeout: 15000 }, (err, stdout) => {
			const tryParse = (raw: string) => {
				try {
					const r = JSON.parse(raw) as { status?: number; result?: { username?: string } };
					return r.status === 0 ? (r.result?.username ?? null) : null;
				} catch { return null; }
			};
			if (!err) { resolve(tryParse(stdout)); return; }
			// Fallback: try plain "sf" (might work via npx or PATH without .cmd)
			child_process.exec('sf org display --json', { cwd, timeout: 15000 }, (err2, stdout2) => {
				resolve(err2 ? null : tryParse(stdout2));
			});
		});
	});
}

function checkMcpConfig(workspaceRoot?: string): McpFileResult[] {
	const home = os.homedir();
	const candidates: Array<{ rel: string; full: string; scope: 'workspace' | 'personal' }> = [];

	if (workspaceRoot) {
		candidates.push({ rel: '.mcp.json',        full: path.join(workspaceRoot, '.mcp.json'),               scope: 'workspace' });
		candidates.push({ rel: '.vscode/mcp.json', full: path.join(workspaceRoot, '.vscode', 'mcp.json'),     scope: 'workspace' });
	}
	candidates.push({ rel: '~/.claude/mcp.json',   full: path.join(home, '.claude', 'mcp.json'),              scope: 'personal' });

	return candidates.map(c => {
		if (!fileExists(c.full)) {
			return { relPath: c.rel, fullPath: c.full, exists: false, scope: c.scope, hasSalesforceMcp: false, servers: [] };
		}
		try {
			const raw = fs.readFileSync(c.full, 'utf8');
			const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
			// Claude Code: { mcpServers: { name: { command, args[] } } }
			// VS Code:     { servers:    { name: { type, command, args[] } } }
			const serverMap = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, { command?: string; args?: string[] }>;
			const servers: McpServerEntry[] = [];
			let hasSalesforceMcp = false;

			for (const [name, cfg] of Object.entries(serverMap)) {
				const args: string[] = cfg.args ?? [];
				if (!args.some(a => a.includes('@salesforce/mcp'))) { continue; }
				hasSalesforceMcp = true;

				const orgs: string[] = [];
				const orgsIdx = args.indexOf('--orgs');
				if (orgsIdx !== -1 && orgsIdx + 1 < args.length) { orgs.push(args[orgsIdx + 1]); }

				const toolsets: string[] = [];
				const tsIdx = args.indexOf('--toolsets');
				if (tsIdx !== -1 && tsIdx + 1 < args.length) {
					toolsets.push(...args[tsIdx + 1].split(',').map(s => s.trim()).filter(Boolean));
				}

				const tools: string[] = [];
				const toolsIdx = args.indexOf('--tools');
				if (toolsIdx !== -1 && toolsIdx + 1 < args.length) {
					tools.push(...args[toolsIdx + 1].split(',').map(s => s.trim()).filter(Boolean));
				}

				const allowNonGa = args.includes('--allow-non-ga-tools');
				servers.push({ name, orgs, toolsets, tools, allowNonGa });
			}
			return { relPath: c.rel, fullPath: c.full, exists: true, scope: c.scope, hasSalesforceMcp, servers };
		} catch {
			return { relPath: c.rel, fullPath: c.full, exists: true, scope: c.scope, hasSalesforceMcp: false, servers: [] };
		}
	});
}

// Extract the launch command/args for the @salesforce/mcp entry in a config
// file, so we can spawn the exact server the user configured (not a
// reconstructed one) for the "Run Server" feature.
function readMcpServerLaunchSpec(filePath: string): { command: string; args: string[] } | null {
	if (!fileExists(filePath)) { return null; }
	try {
		const raw = fs.readFileSync(filePath, 'utf8');
		const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
		const serverMap = (parsed.mcpServers ?? parsed.servers ?? {}) as Record<string, { command?: string; args?: string[] }>;
		for (const cfg of Object.values(serverMap)) {
			const args = cfg.args ?? [];
			if (args.some(a => a.includes('@salesforce/mcp'))) {
				return { command: cfg.command ?? 'npx', args };
			}
		}
	} catch { /* fall through */ }
	return null;
}

// ---------------------------------------------------------------------------

async function runAllChecks(): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// --- Instructions ---
	const githubInstr = workspacePath('.github/copilot-instructions.md');
	const githubInstrExists = fileExists(githubInstr);
	results.push({
		id: 'github-instructions',
		category: 'Instructions',
		name: '.github/copilot-instructions.md',
		status: githubInstrExists ? 'ok' : 'missing',
		message: githubInstrExists
			? 'GitHub Copilot instructions found'
			: 'No .github/copilot-instructions.md — primary instructions file missing',
		path: githubInstrExists ? githubInstr : undefined,
	});

	const rootInstr = workspacePath('copilot-instructions.md');
	if (fileExists(rootInstr)) {
		results.push({
			id: 'root-instructions',
			category: 'Instructions',
			name: 'copilot-instructions.md (root)',
			status: 'ok',
			message: 'Root-level Copilot instructions found',
			path: rootInstr,
		});
	}

	// --- SKILL.md files in all workspace skill locations (.github/skills/, .claude/skills/, .agents/skills/) ---
	let totalSkillFiles = 0;
	for (const skillsPath of ['.github/skills', '.claude/skills', '.agents/skills']) {
		const skillFiles = await vscode.workspace.findFiles(`${skillsPath}/**/SKILL.md`, '**/node_modules/**', 100);
		for (const f of skillFiles) {
			totalSkillFiles++;
			results.push({
				id: `skill-${f.fsPath}`,
				category: 'Skills',
				name: path.basename(path.dirname(f.fsPath)),
				status: 'ok',
				message: vscode.workspace.asRelativePath(f),
				path: f.fsPath,
			});
		}
	}
	if (totalSkillFiles === 0) {
		results.push({
			id: 'no-skill-files',
			category: 'Skills',
			name: 'SKILL.md files',
			status: 'info',
			message: 'No project skills found in .github/skills/, .claude/skills/, or .agents/skills/ — install via the Create tab',
		});
	}

	// --- Personal skills (~/.copilot/skills/, ~/.claude/skills/, ~/.agents/skills/) ---
	for (const skillsDir of ['.copilot/skills', '.claude/skills', '.agents/skills'].map(d => path.join(os.homedir(), d))) {
		if (fileExists(skillsDir)) {
			try {
				const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory()) {
						const skillMd = path.join(skillsDir, entry.name, 'SKILL.md');
						if (fileExists(skillMd)) {
							results.push({
								id: `skill-personal-${skillMd}`,
								category: 'Skills',
								name: entry.name,
								status: 'ok',
								message: `~/${path.relative(os.homedir(), skillMd).replace(/\\/g, '/')}`,
								path: skillMd,
							});
						}
					}
				}
			} catch { /* unreadable */ }
		}
	}

	// --- .instructions.md files ---
	const instrFiles = await vscode.workspace.findFiles('**/*.instructions.md', '**/node_modules/**', 50);
	if (instrFiles.length > 0) {
		for (const f of instrFiles) {
			results.push({
				id: `instr-${f.fsPath}`,
				category: 'Instructions',
				name: path.basename(f.fsPath),
				status: 'ok',
				message: vscode.workspace.asRelativePath(f),
				path: f.fsPath,
			});
		}
	} else {
		results.push({
			id: 'no-instructions-files',
			category: 'Instructions',
			name: '*.instructions.md files',
			status: 'info',
			message: 'No .instructions.md files found in workspace',
		});
	}

	// --- .prompt.md files ---
	const promptFiles = await vscode.workspace.findFiles('**/*.prompt.md', '**/node_modules/**', 50);
	if (promptFiles.length > 0) {
		for (const f of promptFiles) {
			results.push({
				id: `prompt-${f.fsPath}`,
				category: 'Prompts',
				name: path.basename(f.fsPath),
				status: 'ok',
				message: vscode.workspace.asRelativePath(f),
				path: f.fsPath,
			});
		}
	} else {
		results.push({
			id: 'no-prompt-files',
			category: 'Prompts',
			name: '*.prompt.md files',
			status: 'info',
			message: 'No .prompt.md files found in workspace',
		});
	}

	// --- .agent.md files ---
	const agentFiles = await vscode.workspace.findFiles('**/*.agent.md', '**/node_modules/**', 50);
	if (agentFiles.length > 0) {
		for (const f of agentFiles) {
			results.push({
				id: `agent-${f.fsPath}`,
				category: 'Agents',
				name: path.basename(f.fsPath),
				status: 'ok',
				message: vscode.workspace.asRelativePath(f),
				path: f.fsPath,
			});
		}
	} else {
		results.push({
			id: 'no-agent-files',
			category: 'Agents',
			name: '*.agent.md files',
			status: 'info',
			message: 'No .agent.md files found in workspace',
		});
	}

	const agentsMd = workspacePath('AGENTS.md');
	const agentsMdExists = fileExists(agentsMd);
	results.push({
		id: 'agents-md',
		category: 'Agents',
		name: 'AGENTS.md',
		status: agentsMdExists ? 'ok' : 'info',
		message: agentsMdExists ? 'AGENTS.md found in workspace root' : 'No AGENTS.md in workspace root',
		path: agentsMdExists ? agentsMd : undefined,
	});

	// --- Copilot Hooks ---
	const copilotHookFiles = await vscode.workspace.findFiles('.github/hooks/*.json', '**/node_modules/**', 20);
	const claudeSettings  = workspacePath('.claude/settings.json');
	const claudeLocal     = workspacePath('.claude/settings.local.json');
	const hookSources: { label: string; p: string | undefined; isFile: boolean }[] = [
		...copilotHookFiles.map(f => ({ label: vscode.workspace.asRelativePath(f), p: f.fsPath, isFile: true })),
		{ label: '.claude/settings.json',       p: claudeSettings, isFile: false },
		{ label: '.claude/settings.local.json', p: claudeLocal,    isFile: false },
	];
	let copilotHooksFound = 0;
	for (const src of hookSources) {
		if (!src.p || !fileExists(src.p)) { continue; }
		try {
			const raw = fs.readFileSync(src.p, 'utf8');
			const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
			if (!parsed.hooks || Object.keys(parsed.hooks).length === 0) {
				if (!src.isFile) { continue; }   // skip empty claude settings silently
			}
			const events = Object.keys(parsed.hooks ?? {});
			const activeEvents = events.filter(ev => Array.isArray(parsed.hooks![ev]) && (parsed.hooks![ev] as unknown[]).length > 0);
			copilotHooksFound++;
			results.push({
				id: `copilot-hook-${src.p}`,
				category: 'Copilot Hooks',
				name: path.basename(src.p),
				status: activeEvents.length > 0 ? 'ok' : 'info',
				message: activeEvents.length > 0
					? `Active events: ${activeEvents.join(', ')}`
					: `Defined but no active commands — events: ${events.join(', ')}`,
				path: src.p,
			});
		} catch {
			copilotHooksFound++;
			results.push({
				id: `copilot-hook-err-${src.p}`,
				category: 'Copilot Hooks',
				name: path.basename(src.p),
				status: 'warn',
				message: 'Hook file exists but could not be parsed as JSON',
				path: src.p,
			});
		}
	}
	if (copilotHooksFound === 0) {
		results.push({
			id: 'no-copilot-hooks',
			category: 'Copilot Hooks',
			name: 'Hook files',
			status: 'info',
			message: 'No hook files found — add .github/hooks/*.json or configure .claude/settings.json',
		});
	}

	// --- Extensions ---
	// Use getExtension() first; fall back to searching vscode.extensions.all
	// because VS Code ≥1.99 ships Copilot as a built-in extension that may not
	// be found by getExtension() even though it appears "installed" in the UI.
	const copilotExt = vscode.extensions.getExtension('GitHub.copilot')
		?? vscode.extensions.all.find(e => e.id.toLowerCase() === 'github.copilot');
	const chatExt = vscode.extensions.getExtension('GitHub.copilot-chat')
		?? vscode.extensions.all.find(e => e.id.toLowerCase() === 'github.copilot-chat');

	// GitHub.copilot is officially deprecated by Microsoft:
	// "This extension is deprecated. Use the GitHub Copilot Chat extension instead."
	// In VS Code ≥1.99 it is bundled as a built-in and may show as green in the
	// Extensions panel while being undetectable via the marketplace extension API.
	results.push({
		id: 'copilot-ext',
		category: 'Extensions',
		name: 'GitHub Copilot',
		status: copilotExt ? 'warn' : 'ok',
		message: copilotExt
			? `v${(copilotExt.packageJSON as { version?: string }).version ?? '—'} — deprecated by Microsoft: "Use the GitHub Copilot Chat extension instead." Safe to uninstall.`
			: chatExt
				? 'Deprecated — not needed. In VS Code ≥1.99 Copilot is built into the editor; GitHub Copilot Chat provides all features.'
				: 'Deprecated extension — not installed. Install GitHub Copilot Chat instead.',
	});

	results.push({
		id: 'copilot-chat-ext',
		category: 'Extensions',
		name: 'GitHub Copilot Chat',
		status: chatExt ? 'ok' : 'warn',
		message: chatExt
			? `Installed — v${(chatExt.packageJSON as { version?: string }).version ?? '—'}. Provides inline completions, chat, agent mode, and slash commands.`
			: 'Not installed — install GitHub Copilot Chat from the VS Code Marketplace (replaces the deprecated GitHub Copilot extension).',
	});

	// --- Settings ---
	const vscodeSettings = workspacePath('.vscode/settings.json');
	if (fileExists(vscodeSettings)) {
		try {
			const raw = fs.readFileSync(vscodeSettings!, 'utf8');
			const parsed = JSON.parse(stripJsonComments(raw));
			const hasCopilot = Object.keys(parsed).some(k =>
				k.startsWith('github.copilot') || k.startsWith('copilot'));
			results.push({
				id: 'workspace-settings',
				category: 'Settings',
				name: '.vscode/settings.json',
				status: hasCopilot ? 'ok' : 'info',
				message: hasCopilot
					? 'Workspace settings contain Copilot configuration'
					: 'Workspace settings exist — no Copilot keys detected',
				path: vscodeSettings,
			});
		} catch {
			results.push({
				id: 'workspace-settings-error',
				category: 'Settings',
				name: '.vscode/settings.json',
				status: 'warn',
				message: 'Settings file exists but could not be parsed',
				path: vscodeSettings,
			});
		}
	} else {
		results.push({
			id: 'no-workspace-settings',
			category: 'Settings',
			name: '.vscode/settings.json',
			status: 'info',
			message: 'No workspace settings.json found',
		});
	}

	// Compute scope badge for each result
	const home = os.homedir();
	for (const r of results) {
		if (r.path) {
			r.scope = r.path.startsWith(home) ? 'personal' : 'workspace';
		} else if (r.category !== 'Extensions') {
			r.scope = 'workspace';
		}
	}

	return results;
}

// ---------------------------------------------------------------------------
// WebviewView Provider
// ---------------------------------------------------------------------------

class CopilotChecksViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'copilotChecksView';

	private _view?: vscode.WebviewView;
	private _lastChecks: CheckResult[] = [];
	// Live toolset discovery (Option C). Cached in memory for the session;
	// falls back to the built-in MCP_TOOLSETS catalog until a discovery runs.
	private _liveToolsets?: McpToolset[];
	private _liveNonGaInfo?: Record<string, string>;
	private _toolsetSource: 'live' | 'builtin' = 'builtin';
	private _discoveredAt?: number;
	private _discovering = false;
	// "Run Server" — manually-launched, long-lived test instances of a
	// configured @salesforce/mcp server, keyed by the config file's full path.
	private _runningServers: Map<string, { child: child_process.ChildProcess; intentionalStop: boolean }> = new Map();
	private _mcpOutput?: vscode.OutputChannel;

	constructor(private readonly _extensionUri: vscode.Uri) {}

	private get mcpOutput(): vscode.OutputChannel {
		if (!this._mcpOutput) {
			this._mcpOutput = vscode.window.createOutputChannel('Salesforce MCP — Run Server');
		}
		return this._mcpOutput;
	}

	// Kill any manually-launched servers when the extension deactivates.
	public disposeRunningServers(): void {
		for (const { child } of this._runningServers.values()) {
			try { child.kill(); } catch { /* ignore */ }
		}
		this._runningServers.clear();
		this._mcpOutput?.dispose();
	}

	public resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [this._extensionUri],
		};

		webviewView.webview.html = this._getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(async (data) => {
			switch (data.type) {
				case 'refresh':
					await this._sendAll(webviewView.webview);
					break;
				case 'openFile': {
					const check = this._lastChecks[data.index as number];
					if (check?.path) {
						vscode.window.showTextDocument(vscode.Uri.file(check.path));
					}
					break;
				}
				case 'deleteFile': {
					const check = this._lastChecks[data.index as number];
					if (!check?.path) { break; }
					const label = path.basename(check.path);
					const answer = await vscode.window.showWarningMessage(
						`Delete "${label}"? This cannot be undone.`,
						{ modal: true },
						'Delete'
					);
					if (answer === 'Delete') {
						try {
							fs.rmSync(check.path, { recursive: true, force: true });
							await this._sendAll(webviewView.webview);
						} catch (e) {
							vscode.window.showErrorMessage(`Failed to delete: ${(e as Error).message}`);
						}
					}
					break;
				}
				case 'createFile':
					await this._handleCreate(webviewView.webview, data.fileType as string);
					break;
				case 'checkSkill': {
					const idx = data.index as number;
					const skillName = data.skillName as string;
					const check = this._lastChecks[idx];
					if (!check?.path) { break; }
					const dirPath = path.dirname(check.path);
					const result = validateSkillLocal(skillName, dirPath);
					const status = result.errors.length > 0 ? 'err' : result.warnings.length > 0 ? 'warn' : 'ok';
					// Open the dedicated report panel in the editor
					const report = SkillValidationReportPanel.createOrShow(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
					await report.checkSkill(skillName);
					// Send inline result back to the sidebar for badge update
					webviewView.webview.postMessage({ type: 'checkSkillResult', skillName, status, errors: result.errors, warnings: result.warnings });
					break;
				}
				case 'openSummary':
					SummaryPanel.createOrShow(this._lastChecks, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);
					break;
				case 'showMcpFile': {
					const filePath = data.path as string;
					if (filePath) {
						try {
							const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
							await vscode.window.showTextDocument(doc);
						} catch {
							vscode.window.showErrorMessage(`Could not open: ${filePath}`);
						}
					}
					break;
				}
				case 'checkMcpServer':
					this._checkMcpServer(webviewView.webview, data.path as string);
					break;
				case 'runMcpServer':
					await this._runMcpServer(webviewView.webview, data.path as string);
					break;
				case 'stopMcpServer':
					this._stopMcpServer(webviewView.webview, data.path as string);
					break;
				case 'installMcp':
					await this._handleInstallMcp(
						webviewView.webview,
						data.target as 'vscode' | 'claudecode',
						data.toolsets as string[],
						data.tools as string[],
						!!data.allowNonGa,
					);
					break;
				case 'discoverMcpToolsets':
					await this._handleDiscoverMcp(webviewView.webview);
					break;
				case 'ready':
					await this._sendAll(webviewView.webview);
					break;
			}
		});
		// Do NOT call _sendAll here — the webview posts 'ready' when its JS is
		// loaded, which triggers _sendAll. Calling it here races with HTML load.
	}

	public refresh() {
		if (this._view) {
			this._sendAll(this._view.webview);
		}
	}

	private async _sendAll(webview: vscode.Webview) {
		webview.postMessage({ type: 'loading' });
		try {
			this._lastChecks = await runAllChecks();
		} catch (e) {
			console.error('[copilot-checks] runAllChecks failed:', e);
			this._lastChecks = [];
		}
		const creators = getCreatorItems();
		const personalCreators = getPersonalCreatorItems();
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		const mcpFiles = checkMcpConfig(root);
		webview.postMessage({
			type: 'data', checks: this._lastChecks, creators, personalCreators, homeDir: os.homedir(), mcpFiles,
			mcpToolsets: this._liveToolsets ?? MCP_TOOLSETS,
			mcpNonGaInfo: this._liveNonGaInfo ?? MCP_NONGA_INFO,
			mcpToolsetSource: this._toolsetSource,
			mcpDiscoveredAt: this._discoveredAt,
			mcpRunningPaths: Array.from(this._runningServers.keys()),
		});
	}

	private async _handleCreate(webview: vscode.Webview, fileType: string) {
		if (fileType === 'salesforce-awesome-skills') {
			await this._installAwesomeCopilotSkills(webview);
			return;
		}
		if (fileType === 'sf-skills-library') {
			this._openSfSkillsLibrary();
			return;
		}

		const def = CREATORS.find(c => c.type === fileType) ?? PERSONAL_CREATORS.find(c => c.type === fileType);
		if (!def) { return; }

		const isPersonal = def.target.startsWith('~/');
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!isPersonal && !root) {
			vscode.window.showErrorMessage('No workspace folder open.');
			return;
		}

		let name = '';
		if (def.needsName) {
			const input = await vscode.window.showInputBox({
				prompt: def.namePrompt,
				placeHolder: def.namePlaceholder,
				validateInput: v => (v.trim() ? undefined : 'Name cannot be empty'),
			});
			if (input === undefined) { return; }   // user cancelled
			name = input.trim().replace(/[^a-zA-Z0-9_-]/g, '-');
		}

		const relativePath = def.target.replace('{name}', name);
		const fullPath = isPersonal
			? path.join(os.homedir(), relativePath.slice(2))   // strip leading ~/
			: path.join(root!, relativePath);
		const uri = vscode.Uri.file(fullPath);

		if (!fileExists(fullPath)) {
			try {
				fs.mkdirSync(path.dirname(fullPath), { recursive: true });
				fs.writeFileSync(fullPath, getTemplate(fileType, name), 'utf8');
			} catch (e) {
				vscode.window.showErrorMessage(`Failed to create file: ${String(e)}`);
				return;
			}
		}

		await vscode.window.showTextDocument(uri);
		await this._sendAll(webview);   // refresh all tabs
	}

	private async _installAwesomeCopilotSkills(webview: vscode.Webview) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

		const location = await vscode.window.showQuickPick([
			{ label: '$(root-folder) Project', description: '.github/skills/  — team-shared in repository', value: 'project' as const },
			{ label: '$(home) Personal',        description: '~/.copilot/skills/  — available in every workspace', value: 'personal' as const },
		], { title: 'Where to install Salesforce skills?', placeHolder: 'Choose installation location' });
		if (!location) { return; }

		const baseSkillsDir = location.value === 'personal'
			? path.join(os.homedir(), '.copilot', 'skills')
			: root ? path.join(root, '.github', 'skills') : null;

		if (!baseSkillsDir) {
			vscode.window.showErrorMessage('No workspace folder open (required for project install).');
			return;
		}

		let installed = 0;
		let failed = 0;

		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Installing Salesforce Skills',
			cancellable: false,
		}, async (progress) => {
			const step = Math.floor(100 / AWESOME_COPILOT_SALESFORCE_SKILLS.length);
			for (const skill of AWESOME_COPILOT_SALESFORCE_SKILLS) {
				progress.report({ message: `Downloading ${skill.label}…`, increment: step });
				try {
					const content = await fetchUrl(skill.rawUrl);
					// Skills go in {location}/{name}/SKILL.md (open agentskills.io spec).
					// The SKILL.md already contains its own name/description frontmatter — do NOT wrap it.
					const targetPath = path.join(baseSkillsDir, skill.name, 'SKILL.md');
					fs.mkdirSync(path.dirname(targetPath), { recursive: true });
					fs.writeFileSync(targetPath, content, 'utf8');
					installed++;
				} catch (e) {
					failed++;
					console.error(`Failed to download ${skill.name}:`, e);
				}
			}
		});

		const dest = location.value === 'personal' ? '~/.copilot/skills/' : '.github/skills/';
		if (installed > 0) {
			vscode.window.showInformationMessage(
				`✓ Installed ${installed} Salesforce skill${installed > 1 ? 's' : ''} in ${dest}`
			);
			await this._sendAll(webview);
		}
		if (failed > 0) {
			vscode.window.showWarningMessage(`Failed to install ${failed} skill(s). Check your internet connection.`);
		}
	}

	private _openSfSkillsLibrary() {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		SfSkillsPanel.createOrShow(root);
	}

	private async _checkMcpServer(webview: vscode.Webview, filePath: string): Promise<void> {
		const reply = (ok: boolean, message: string): void => {
			webview.postMessage({ type: 'mcpServerStatus', path: filePath, ok, message });
		};

		if (!filePath || !fileExists(filePath)) {
			return reply(false, 'config file not found');
		}

		// Extract the first org from the config
		let orgArg: string | undefined;
		try {
			const raw = fs.readFileSync(filePath, 'utf8');
			const parsed = JSON.parse(stripJsonComments(raw)) as Record<string, unknown>;
			const servers = (parsed['servers'] ?? parsed['mcpServers']) as Record<string, { args?: string[] }> | undefined;
			if (servers) {
				for (const srv of Object.values(servers)) {
					const args = srv.args ?? [];
					const idx = args.indexOf('--orgs');
					if (idx !== -1 && args[idx + 1]) { orgArg = args[idx + 1].split(',')[0]; break; }
				}
			}
		} catch {
			return reply(false, 'could not parse config file');
		}

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const sfCmd = process.platform === 'win32' ? 'sf.cmd' : 'sf';

		// 1. Check org connectivity
		const orgStatus = await new Promise<{ ok: boolean; label: string }>((resolve) => {
			const cmd = orgArg
				? `${sfCmd} org display --target-org ${orgArg} --json`
				: `${sfCmd} org display --json`;
			child_process.exec(cmd, { cwd, timeout: 12000 }, (err, stdout) => {
				if (err) { resolve({ ok: false, label: `org unreachable — ${err.message.split('\n')[0]}` }); return; }
				try {
					const r = JSON.parse(stdout) as { status?: number; result?: { connectedStatus?: string } };
					const s = r.result?.connectedStatus ?? 'unknown';
					resolve({ ok: r.status === 0, label: `org: ${s}` });
				} catch {
					resolve({ ok: false, label: 'org: parse error' });
				}
			});
		});
		if (!orgStatus.ok) { return reply(false, orgStatus.label); }

		// 2. Check Node.js version meets @salesforce/mcp engine requirement (≥20.19.0 or ≥22.12.0).
		// process.version is the Node that runs the extension host — same Node that will run npx.
		const nodeVer = process.version; // e.g. "v22.12.0"
		const mv = nodeVer.match(/^v(\d+)\.(\d+)/);
		const [nmaj, nmin] = mv ? [+mv[1], +mv[2]] : [0, 0];
		const nodeOk = (nmaj === 20 && nmin >= 19)
		            || (nmaj === 21)
		            || (nmaj === 22 && nmin >= 12)
		            || nmaj > 22;

		if (!nodeOk) {
			return reply(false, `Node.js ${nodeVer} — upgrade to ≥20.19.0 or ≥22.12.0 for @salesforce/mcp`);
		}

		reply(true, `${orgStatus.label} · Node.js ${nodeVer} ✓`);
	}

	// Launch the exact @salesforce/mcp server configured in `filePath` as a
	// long-lived foreground process, do the MCP initialize handshake to
	// confirm it actually came up, then leave it running until stopped (or
	// the extension deactivates).
	private async _runMcpServer(webview: vscode.Webview, filePath: string): Promise<void> {
		// Combined diagnostic log (launch line + stderr + non-JSON stdout), capped,
		// echoed both to the Output channel and — on failure — into the webview.
		let logBuf = '';
		const appendLog = (s: string): void => { logBuf = (logBuf + s).slice(-8000); };
		const reply = (state: 'starting' | 'running' | 'stopped' | 'error', message: string, withLog = false): void => {
			webview.postMessage({ type: 'mcpServerRunStatus', path: filePath, state, message, log: withLog ? logBuf : undefined });
		};

		if (!filePath) { return; }
		if (this._runningServers.has(filePath)) {
			reply('running', 'Already running.');
			return;
		}

		const spec = readMcpServerLaunchSpec(filePath);
		if (!spec) {
			reply('error', 'Could not find a @salesforce/mcp server entry in this config file.');
			return;
		}

		reply('starting', 'Launching @salesforce/mcp… first run can take ~30s while npx downloads it.');

		const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
		const isWin = process.platform === 'win32';
		const cmd = isWin && spec.command === 'npx' ? 'npx.cmd' : spec.command;

		const out = this.mcpOutput;
		const launchLine = `$ ${cmd} ${spec.args.join(' ')}`;
		out.appendLine(`\n[${new Date().toLocaleTimeString()}] launching: ${cmd} ${spec.args.join(' ')}`);
		out.appendLine(`  cwd: ${cwd}`);
		appendLog(`${launchLine}\n`);

		let child: child_process.ChildProcess;
		try {
			// shell:true on Windows so the npx.cmd shim resolves. Pass the args as
			// one pre-joined string so cmd.exe doesn't re-tokenize comma-separated
			// values (e.g. `--toolsets users,testing`) into separate arguments.
			child = isWin
				? child_process.spawn(`${cmd} ${spec.args.join(' ')}`, { cwd, windowsHide: true, shell: true })
				: child_process.spawn(cmd, spec.args, { cwd, windowsHide: true });
		} catch (e) {
			out.appendLine(`  spawn failed: ${String(e)}`);
			appendLog(`spawn failed: ${String(e)}\n`);
			reply('error', `Failed to launch: ${String(e)}`, true);
			return;
		}
		if (!child.stdin || !child.stdout || !child.stderr) {
			reply('error', 'Failed to attach to server stdio.');
			try { child.kill(); } catch { /* ignore */ }
			return;
		}

		this._runningServers.set(filePath, { child, intentionalStop: false });

		let settled = false;
		let live = false;   // once running, stream subsequent output to the webview
		let buf = '';
		let stderrTail = '';
		const streamLog = (chunk: string): void => {
			appendLog(chunk);
			if (live) { webview.postMessage({ type: 'mcpServerLog', path: filePath, chunk }); }
		};
		const handshakeTimer = setTimeout(() => {
			if (settled) { return; }
			settled = true;
			reply('error', 'Server did not respond to the MCP handshake within 45s.', true);
			out.show(true);
		}, 45000);

		const send = (msg: JsonRpcMessage) => {
			try { child.stdin?.write(JSON.stringify(msg) + '\n'); } catch { /* ignore */ }
		};

		child.stderr.setEncoding('utf8');
		child.stderr.on('data', (chunk: string) => {
			stderrTail = (stderrTail + chunk).slice(-4000);
			streamLog(chunk);
			out.append(chunk);
		});

		child.stdout.setEncoding('utf8');
		child.stdout.on('data', (chunk: string) => {
			buf += chunk;
			let nl: number;
			while ((nl = buf.indexOf('\n')) !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (!line) { continue; }
				let msg: JsonRpcMessage;
				try { msg = JSON.parse(line) as JsonRpcMessage; } catch { streamLog(line + '\n'); out.appendLine(line); continue; }
				if (msg.id === 1 && !settled) {
					settled = true;
					clearTimeout(handshakeTimer);
					if (msg.error) {
						reply('error', `Handshake failed — ${JSON.stringify(msg.error)}`, true);
						out.show(true);
						try { child.kill(); } catch { /* ignore */ }
						continue;
					}
					send({ jsonrpc: '2.0', method: 'notifications/initialized' });
					out.appendLine(`  ✓ MCP handshake complete (pid ${child.pid ?? '?'})`);
					appendLog(`✓ MCP handshake complete (pid ${child.pid ?? '?'})\n`);
					reply('running', `Running (pid ${child.pid ?? '?'}).`, true);
					live = true;
				}
			}
		});

		// First meaningful (non-blank) line of stderr, for the inline message.
		const firstErrLine = (): string => {
			const line = stderrTail.split('\n').map(s => s.trim()).filter(Boolean).pop();
			return line ? ` — ${line}` : '';
		};

		child.on('error', (err) => {
			clearTimeout(handshakeTimer);
			this._runningServers.delete(filePath);
			out.appendLine(`  process error: ${err.message}`);
			appendLog(`process error: ${err.message}\n`);
			reply('error', `Process error: ${err.message}`, true);
		});
		child.on('exit', (code) => {
			clearTimeout(handshakeTimer);
			const wasIntentional = this._runningServers.get(filePath)?.intentionalStop ?? false;
			this._runningServers.delete(filePath);
			out.appendLine(`  process exited (code ${code ?? '?'})`);
			if (wasIntentional) {
				reply('stopped', 'Stopped.');
			} else if (!settled) {
				reply('error', `Server exited before the handshake (code ${code ?? '?'})${firstErrLine()}`, true);
				out.show(true);
			} else {
				reply('stopped', `Server exited (code ${code ?? '?'}).`);
			}
		});

		send({
			jsonrpc: '2.0',
			id: 1,
			method: 'initialize',
			params: {
				protocolVersion: '2024-11-05',
				capabilities: {},
				clientInfo: { name: 'salesforce-copilot-inspector', version: '1.0.0' },
			},
		});
	}

	private _stopMcpServer(webview: vscode.Webview, filePath: string): void {
		const entry = this._runningServers.get(filePath);
		if (!entry) {
			webview.postMessage({ type: 'mcpServerRunStatus', path: filePath, state: 'stopped', message: 'Not running.' });
			return;
		}
		entry.intentionalStop = true;
		try { entry.child.kill(); } catch { /* ignore */ }
	}

	private async _handleInstallMcp(
		webview: vscode.Webview,
		target: 'vscode' | 'claudecode',
		toolsets: string[],
		tools: string[],
		allowNonGa: boolean,
	) {
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) {
			vscode.window.showErrorMessage('No workspace folder open.');
			return;
		}

		if (toolsets.length === 0 && tools.length === 0) {
			vscode.window.showWarningMessage('Select at least one toolset or tool before installing.');
			return;
		}

		const orgUsername = await getDefaultOrgUsername(root);
		if (!orgUsername) {
			vscode.window.showErrorMessage(
				'No default org found. Run "sf org display" in the terminal, or set one with "sf config set target-org <username>".',
			);
			return;
		}

		// Build args array
		const args: string[] = ['-y', '@salesforce/mcp', '--orgs', orgUsername];
		if (toolsets.length > 0) { args.push('--toolsets', toolsets.join(',')); }
		if (tools.length > 0)    { args.push('--tools',    tools.join(',')); }
		if (allowNonGa)          { args.push('--allow-non-ga-tools'); }

		let targetFile: string;
		let config: Record<string, unknown>;

		if (target === 'vscode') {
			targetFile = path.join(root, '.vscode', 'mcp.json');
			let existing: Record<string, unknown> = {};
			if (fileExists(targetFile)) {
				try { existing = JSON.parse(stripJsonComments(fs.readFileSync(targetFile, 'utf8'))); } catch { /* start fresh */ }
			}
			const servers = (existing.servers ?? {}) as Record<string, unknown>;
			servers['Salesforce DX'] = { type: 'stdio', command: 'npx', args };
			config = { ...existing, servers };
		} else {
			targetFile = path.join(root, '.mcp.json');
			let existing: Record<string, unknown> = {};
			if (fileExists(targetFile)) {
				try { existing = JSON.parse(stripJsonComments(fs.readFileSync(targetFile, 'utf8'))); } catch { /* start fresh */ }
			}
			const mcpServers = (existing.mcpServers ?? {}) as Record<string, unknown>;
			mcpServers['Salesforce DX'] = { command: 'npx', args };
			config = { ...existing, mcpServers };
		}

		try {
			fs.mkdirSync(path.dirname(targetFile), { recursive: true });
			fs.writeFileSync(targetFile, JSON.stringify(config, null, 2), 'utf8');
			const rel = path.relative(root, targetFile);
			vscode.window.showInformationMessage(`✓ Salesforce DX MCP server written to ${rel} (org: ${orgUsername})`);
			await vscode.window.showTextDocument(vscode.Uri.file(targetFile));
			await this._sendAll(webview);
		} catch (e) {
			vscode.window.showErrorMessage(`Failed to write MCP config: ${String(e)}`);
		}
	}

	// Option C — query the installed @salesforce/mcp server for the live
	// toolset list, caching the result for the session. Any failure leaves the
	// built-in MCP_TOOLSETS catalog in place.
	private async _handleDiscoverMcp(webview: vscode.Webview): Promise<void> {
		const status = (state: 'progress' | 'done' | 'error', message: string): void => {
			webview.postMessage({ type: 'mcpDiscoverStatus', state, message });
		};

		if (this._discovering) { return; }
		const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		if (!root) { status('error', 'No workspace folder open.'); return; }

		status('progress', 'Resolving default org…');
		const org = await getDefaultOrgUsername(root);
		if (!org) {
			status('error', 'No default org — run "sf org login web" or "sf config set target-org <username>".');
			return;
		}

		this._discovering = true;
		status('progress', `Querying @salesforce/mcp (org: ${org})… first run can take ~30s while npx downloads it.`);
		try {
			const result = await discoverMcpToolsets(org, root);
			if (!result) {
				status('error', 'Could not query the MCP server — keeping the built-in list.');
				return;
			}
			this._liveToolsets = result.toolsets;
			this._liveNonGaInfo = result.nonGaInfo;
			this._toolsetSource = 'live';
			this._discoveredAt = Date.now();
			const note = result.failedToolsets.length
				? ` (${result.failedToolsets.length} kept from built-in: ${result.failedToolsets.join(', ')})`
				: '';
			status('done', `Read ${result.probedToolsets} toolset(s) from your installed server.${note}`);
			await this._sendAll(webview);
		} catch (e) {
			status('error', `Discovery failed: ${String(e)}`);
		} finally {
			this._discovering = false;
		}
	}

	private _getHtml(webview: vscode.Webview): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      min-width: 260px;
    }
    /* ── tabs ─────────────────────────────────────────────── */
    .tab-bar {
      display: flex;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      padding: 0 4px;
      overflow-x: auto; scrollbar-width: none;
    }
    .tab-bar::-webkit-scrollbar { display: none; }
    .tab {
      padding: 7px 9px 6px 9px;
      font-size: 11px; font-weight: 500;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      color: var(--vscode-foreground);
      opacity: 0.6; user-select: none; white-space: nowrap;
    }
    .tab:hover { opacity: 0.85; }
    .tab.active { opacity: 1; border-bottom-color: var(--vscode-focusBorder, #007acc); }
    /* ── panels ───────────────────────────────────────────── */
    .panel { display: none; padding: 0 8px 16px 8px; }
    .panel.active { display: block; }
    /* ── toolbar (checks) ─────────────────────────────────── */
    .toolbar {
      display: flex; align-items: center;
      justify-content: space-between;
      padding: 7px 0 4px 0;
    }
    .summary { display: flex; gap: 10px; font-size: 11px; }
    .sum-num { font-weight: 700; }
    .sum-ok   { color: #4ec9b0; }
    .sum-warn { color: #f0c040; }
    .sum-miss { color: #f14c4c; }
    .sum-info { color: var(--vscode-descriptionForeground); }
    .btn-icon {
      background: none; border: none;
      color: var(--vscode-icon-foreground);
      cursor: pointer; padding: 2px 4px;
      border-radius: 3px; font-size: 15px; line-height: 1;
    }
    .btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    /* ── category headers ─────────────────────────────────── */
    .cat-header {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      margin: 12px 0 3px 0; padding-bottom: 3px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      opacity: 0.85;
    }
    /* ── check rows ───────────────────────────────────────── */
    .check {
      display: flex; align-items: flex-start;
      padding: 4px 4px; gap: 7px; border-radius: 3px;
    }
    .check.link { cursor: pointer; }
    .check.link:hover { background: var(--vscode-list-hoverBackground); }
    .check.link:hover .check-name { color: var(--vscode-textLink-foreground); }
    .dot { flex-shrink: 0; width: 14px; text-align: center; margin-top: 1px; font-size: 13px; line-height: 1.2; }
    .s-ok      { color: #4ec9b0; }
    .s-warn    { color: #f0c040; }
    .s-missing { color: #f14c4c; }
    .s-info    { color: var(--vscode-descriptionForeground); }
    .check-body { flex: 1; min-width: 0; }
    .check-name { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .check-msg  { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .scope-badge { flex-shrink: 0; font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 3px; letter-spacing: 0.03em; text-transform: uppercase; vertical-align: middle; margin-left: 5px; }
    .scope-ws   { background: rgba(0,122,204,0.15); color: #4fc1ff; border: 1px solid rgba(0,122,204,0.3); }
    .scope-home { background: rgba(180,100,220,0.15); color: #d7a0f7; border: 1px solid rgba(180,100,220,0.3); }
    .btn-delete { flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid rgba(241,76,76,0.4); background: rgba(241,76,76,0.1); color: #f14c4c; cursor: pointer; margin-left: 5px; vertical-align: middle; line-height: 1.4; }
    .btn-delete:hover { background: rgba(241,76,76,0.25); border-color: #f14c4c; }
    .btn-check { flex-shrink: 0; font-size: 10px; padding: 1px 6px; border-radius: 3px; border: 1px solid rgba(128,128,128,0.35); background: transparent; color: var(--vscode-descriptionForeground); cursor: pointer; margin-left: 5px; vertical-align: middle; line-height: 1.4; }
    .btn-check:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .btn-check:disabled { opacity: .5; cursor: not-allowed; }
    .btn-check.ok   { border-color: rgba(78,201,176,.55);  color: #4ec9b0; }
    .btn-check.warn { border-color: rgba(240,192,64,.55);  color: #f0c040; }
    .btn-check.err  { border-color: rgba(241,76,76,.55);   color: #f14c4c; }
    /* ── creator cards (create tab) ───────────────────────── */
    .create-intro {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      padding: 8px 0 4px 0; line-height: 1.5; margin: 0;
    }
    .creator-card {
      display: flex; align-items: center; gap: 10px;
      padding: 8px 6px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, #333);
      margin-top: 8px;
    }
    .creator-card:hover {
      border-color: var(--vscode-focusBorder, #007acc);
      background: var(--vscode-list-hoverBackground);
    }
    .creator-icon {
      flex-shrink: 0; font-size: 18px; width: 26px;
      text-align: center; font-style: normal;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .creator-body { flex: 1; min-width: 0; }
    .creator-label { font-weight: 600; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .creator-desc  { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 1px; }
    .creator-target {
      font-size: 10px; color: var(--vscode-descriptionForeground);
      margin-top: 2px; font-family: var(--vscode-editor-font-family, monospace);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .creator-target a {
      color: var(--vscode-textLink-foreground, #3794ff);
      text-decoration: none;
    }
    .creator-target a:hover { text-decoration: underline; }
    .btn-create {
      flex-shrink: 0; font-size: 11px; font-weight: 600;
      padding: 3px 10px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--vscode-button-border, transparent);
      white-space: nowrap;
    }
    .btn-create.new {
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .btn-create.new:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .btn-create.open {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .btn-create.open:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    /* ── creator section header ───────────────────────────── */
    .creator-section-hdr {
      font-size: 10px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.08em;
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      margin: 16px 0 4px 0; padding-bottom: 3px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      opacity: 0.85;
    }
    /* ── loading ──────────────────────────────────────────── */
    .loading {
      padding: 24px 0; text-align: center;
      color: var(--vscode-descriptionForeground); font-size: 12px;
    }
    .spin { display: inline-block; animation: rotate 1s linear infinite; }
    @keyframes rotate { to { transform: rotate(360deg); } }
    /* ── summary toolbar ──────────────────────────────────── */
    .summary-bar {
      padding: 6px 8px 0 8px;
    }
    .btn-summary {
      width: 100%; padding: 5px 10px;
      font-size: 12px; font-weight: 600;
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none;
      border-radius: 3px; cursor: pointer;
      text-align: center; display: flex; align-items: center; justify-content: center; gap: 5px;
    }
    .btn-summary:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
    /* ── MCP tab ──────────────────────────────────────────── */
    .mcp-file-row {
      display: flex; align-items: flex-start;
      gap: 7px; padding: 4px 4px; border-radius: 3px;
    }
    .btn-show-file {
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
      background: transparent; border: 1px solid var(--vscode-button-border, rgba(128,128,128,.4));
      color: var(--vscode-foreground); cursor: pointer; vertical-align: middle;
      letter-spacing: 0.04em; opacity: 0.7; margin-left: 4px;
    }
    .btn-show-file:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
    .btn-check-mcp {
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
      background: transparent; border: 1px solid rgba(0,122,204,.55);
      color: var(--vscode-textLink-foreground, #4fc1ff); cursor: pointer; vertical-align: middle;
      letter-spacing: 0.04em; margin-left: 4px;
    }
    .btn-check-mcp:hover { background: rgba(0,122,204,.12); }
    .btn-check-mcp:disabled { opacity: 0.5; cursor: default; }
    .mcp-check-status { margin-top: 2px; }
    .mcp-status-ok  { color: var(--vscode-testing-iconPassed, #4ec9b0); }
    .mcp-status-err { color: var(--vscode-testing-iconFailed, #f48771); }
    /* ── MCP "Run Server" ─────────────────────────────── */
    .mcp-run-badge {
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 8px;
      text-transform: uppercase; letter-spacing: 0.03em; margin-left: 4px;
    }
    .mcp-run-badge.idle     { background: rgba(128,128,128,.12); color: var(--vscode-descriptionForeground); border: 1px solid rgba(128,128,128,.25); }
    .mcp-run-badge.starting { background: rgba(0,122,204,.12);   color: #4fc1ff; border: 1px solid rgba(0,122,204,.3); }
    .mcp-run-badge.running  { background: rgba(78,201,176,.15);  color: #4ec9b0; border: 1px solid rgba(78,201,176,.35); }
    .mcp-run-badge.error    { background: rgba(244,135,113,.12); color: #f48771; border: 1px solid rgba(244,135,113,.35); }
    .btn-run-mcp {
      font-size: 9px; font-weight: 700; padding: 1px 6px; border-radius: 3px;
      background: transparent; border: 1px solid rgba(78,201,176,.55);
      color: #4ec9b0; cursor: pointer; vertical-align: middle;
      letter-spacing: 0.04em; margin-left: 4px;
    }
    .btn-run-mcp:hover { background: rgba(78,201,176,.12); }
    .btn-run-mcp:disabled { opacity: 0.5; cursor: default; }
    .mcp-run-msg { margin-top: 2px; }
    .mcp-run-log { margin-top: 4px; }
    .mcp-run-log summary {
      font-size: 10px; cursor: pointer; color: var(--vscode-textLink-foreground, #4fc1ff);
      user-select: none; margin-bottom: 3px;
    }
    .mcp-run-log-pre {
      margin: 0; padding: 6px 8px; max-height: 220px; overflow: auto;
      font-family: var(--vscode-editor-font-family, monospace); font-size: 10px;
      line-height: 1.4; white-space: pre-wrap; word-break: break-word;
      background: var(--vscode-textCodeBlock-background, rgba(0,0,0,.25));
      border: 1px solid var(--vscode-panel-border, #333); border-radius: 4px;
      color: var(--vscode-foreground);
    }
    .mcp-quickstart {
      margin: 10px 0 4px 0; padding: 8px 10px;
      background: rgba(0,122,204,0.08);
      border: 1px solid rgba(0,122,204,0.25);
      border-radius: 4px; font-size: 11px; line-height: 1.6;
      color: var(--vscode-foreground);
    }
    .mcp-quickstart code {
      font-family: var(--vscode-editor-font-family, monospace);
      background: rgba(0,0,0,0.25); padding: 1px 4px; border-radius: 3px; font-size: 10px;
    }
    .mcp-toolset {
      margin-top: 8px; padding: 7px 8px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, #333);
    }
    .mcp-ts-header {
      display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
    }
    .mcp-ts-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; font-weight: 700;
      color: var(--vscode-textLink-foreground, #3794ff);
    }
    .mcp-ts-label { font-size: 12px; font-weight: 600; }
    .mcp-ts-badge {
      font-size: 9px; font-weight: 700; padding: 1px 5px;
      border-radius: 3px; text-transform: uppercase; letter-spacing: 0.04em;
    }
    .mcp-ts-badge.always { background: rgba(78,201,176,.15); color: #4ec9b0; border: 1px solid rgba(78,201,176,.35); }
    .mcp-ts-desc { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 4px; }
    .mcp-ts-tools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 2px; }
    .mcp-tool {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px; padding: 1px 5px; border-radius: 3px;
      background: rgba(128,128,128,0.12);
      border: 1px solid rgba(128,128,128,0.2);
      color: var(--vscode-foreground); white-space: nowrap;
    }
    /* ── MCP checkboxes ───────────────────────────────── */
    .mcp-ts-chk, .mcp-tool-chk {
      width: 13px; height: 13px; cursor: pointer; flex-shrink: 0;
      accent-color: var(--vscode-focusBorder, #007acc);
    }
    .mcp-ts-chk { margin-right: 4px; }
    .mcp-ts-check-wrap {
      display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    }
    .mcp-tool-label {
      display: inline-flex; align-items: center; gap: 3px; cursor: pointer;
    }
    .mcp-tool-label .mcp-tool { cursor: pointer; }
    .mcp-tool-chk:disabled + .mcp-tool { opacity: 0.45; }
    /* ── MCP install bar ──────────────────────────────── */
    .mcp-install-bar {
      display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;
    }
    .btn-mcp-install {
      font-size: 11px; font-weight: 600; padding: 4px 12px;
      border-radius: 3px; cursor: pointer; white-space: nowrap;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
      border: 1px solid var(--vscode-button-border, transparent);
    }
    .btn-mcp-install:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .mcp-warn-msg {
      margin-top: 6px; padding: 5px 8px; font-size: 11px; border-radius: 4px;
      background: rgba(240,192,64,.1); border: 1px solid rgba(240,192,64,.35);
      color: #f0c040; display: none;
    }
    /* ── MCP non-GA tools section ─────────────────────── */
    .mcp-nonga-hdr {
      display: flex; align-items: center; justify-content: space-between;
    }
    .mcp-ts-badge.non-ga {
      background: rgba(240,192,64,.12); color: #f0c040;
      border: 1px solid rgba(240,192,64,.35);
    }
    .mcp-tool.non-ga {
      border-color: rgba(240,192,64,.4); color: #f0c040;
      background: rgba(240,192,64,.08);
    }
    .mcp-nonga-tool {
      margin-top: 6px; padding: 5px 8px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, #333);
    }
    .mcp-nonga-tool-name {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; font-weight: 700; color: #f0c040;
      display: inline-flex; align-items: center; gap: 6px;
    }
    .mcp-nonga-tool-ts {
      font-size: 9px; font-weight: 400; opacity: .7;
    }
    .mcp-nonga-tool-desc {
      font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px;
    }
    /* ── MCP allow-non-ga checkbox ────────────────────── */
    .mcp-option-row {
      display: flex; align-items: center; gap: 6px;
      margin-top: 8px; font-size: 11px;
    }
    .mcp-option-chk {
      accent-color: var(--vscode-focusBorder, #007acc); cursor: pointer;
    }
    .mcp-option-label {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px; cursor: pointer; user-select: none;
    }
    .mcp-option-hint {
      font-size: 10px; color: var(--vscode-descriptionForeground); margin-left: 2px;
    }
    /* ── MCP config toolbar ────────────────────────────── */
    .mcp-section-hdr {
      display: flex; align-items: center; justify-content: space-between;
    }
    /* ── MCP live toolset discovery (Option C) ─────────── */
    .mcp-src-note {
      font-size: 10px; line-height: 1.5; margin: 4px 0 2px 0;
      color: var(--vscode-descriptionForeground);
    }
    .mcp-src-note.live { color: #4ec9b0; }
    .mcp-discover-status {
      margin: 4px 0; padding: 4px 8px; font-size: 10px; border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, #333);
    }
    .mcp-discover-status.progress { color: var(--vscode-descriptionForeground); }
    .mcp-discover-status.done {
      color: #4ec9b0; background: rgba(78,201,176,.08); border-color: rgba(78,201,176,.35);
    }
    .mcp-discover-status.error {
      color: #f0c040; background: rgba(240,192,64,.08); border-color: rgba(240,192,64,.35);
    }
  </style>
</head>
<body>

  <div class="summary-bar">
    <button class="btn-summary" id="btnSummary" title="Open a full summary of all installed Copilot files"><span>📋</span><span>Summary</span></button>
  </div>

  <div class="tab-bar">
    <div class="tab active" data-tab="checks">Checks</div>
    <div class="tab"        data-tab="workspace">Workspace</div>
    <div class="tab"        data-tab="personal">Personal</div>
    <div class="tab"        data-tab="mcp">MCP</div>
  </div>

  <!-- Tab 1: Checks -->
  <div class="panel active" id="panel-checks">
    <div id="checks-root">
      <div class="loading"><span class="spin">↻</span>&nbsp;Running checks…</div>
    </div>
  </div>

  <!-- Tab 2: Create (Workspace) -->
  <div class="panel" id="panel-workspace">
    <p class="create-intro">Create Copilot files committed to the workspace — shared with the whole team.</p>
    <div id="creator-list">
      <div class="loading"><span class="spin">↻</span>&nbsp;Loading…</div>
    </div>
  </div>

  <!-- Tab 3: Create (Personal) -->
  <div class="panel" id="panel-personal">
    <p class="create-intro">Create Copilot files in your user profile — available in every workspace on this machine.</p>
    <div id="personal-creator-list">
      <div class="loading"><span class="spin">↻</span>&nbsp;Loading…</div>
    </div>
  </div>

  <!-- Tab 4: MCP -->
  <div class="panel" id="panel-mcp">
    <div id="mcp-root">
      <div class="loading"><span class="spin">↻</span>&nbsp;Loading…</div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let skillCheckCache = {};   // skillName -> { cls, lbl }

    // ── summary button ────────────────────────────────────
    document.getElementById('btnSummary').addEventListener('click', () =>
      vscode.postMessage({ type: 'openSummary' })
    );

    // ── tab switching ─────────────────────────────────────
    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
      });
    });

    // ── message handler ───────────────────────────────────
    let _checks = [];

    window.addEventListener('message', ({ data }) => {
      if (data.type === 'loading') {
        document.getElementById('checks-root').innerHTML =
          '<div class="loading"><span class="spin">↻</span>&nbsp;Running checks\u2026</div>';
        document.getElementById('creator-list').innerHTML =
          '<div class="loading"><span class="spin">↻</span>&nbsp;Loading\u2026</div>';
        document.getElementById('personal-creator-list').innerHTML =
          '<div class="loading"><span class="spin">↻</span>&nbsp;Loading\u2026</div>';
        document.getElementById('mcp-root').innerHTML =
          '<div class="loading"><span class="spin">↻</span>&nbsp;Loading\u2026</div>';
      } else if (data.type === 'data') {
        _checks = data.checks;
        if (data.homeDir) _homeDir = data.homeDir;
        renderChecks(data.checks);
        renderCreators(data.creators, 'creator-list');
        renderCreators(data.personalCreators, 'personal-creator-list');
        _mcpSource = data.mcpToolsetSource || 'builtin';
        _mcpDiscoveredAt = data.mcpDiscoveredAt || null;
        // Rehydrate "Running" badges after a webview reload — the provider's
        // child processes outlive the view, the JS-side cache does not.
        (data.mcpRunningPaths || []).forEach(p => {
          _mcpRunCache[p] = { state: 'running', message: _mcpRunCache[p] && _mcpRunCache[p].message || 'Running.' };
        });
        renderMcp(data.mcpFiles, data.mcpToolsets, data.mcpNonGaInfo);
      } else if (data.type === 'checkSkillResult') {
        const icon = data.status === 'ok' ? '✓' : data.status === 'warn' ? '⚠' : '✗';
        const detail = data.status === 'ok' ? 'ok' : (data.errors.length + data.warnings.length) + ' issue' + ((data.errors.length + data.warnings.length) !== 1 ? 's' : '');
        skillCheckCache[data.skillName] = { cls: data.status, lbl: icon + ' ' + detail };
        const btn = document.querySelector('.btn-check[data-skill="' + data.skillName + '"]');
        if (btn) {
          btn.disabled = false;
          btn.className = 'btn-check ' + data.status;
          btn.textContent = icon + ' ' + detail;
          btn.title = data.errors.length + ' error(s), ' + data.warnings.length + ' warning(s) — click to re-run';
        }
      } else if (data.type === 'mcpServerStatus') {
        const row = Array.from(document.querySelectorAll('.mcp-file-row')).find(r => r.dataset.path === data.path);
        if (row) {
          const btn = row.querySelector('.btn-check-mcp');
          if (btn) { btn.textContent = 'CHECK'; btn.disabled = false; }
          const statusDiv = document.createElement('div');
          statusDiv.className = 'mcp-check-status check-msg ' + (data.ok ? 'mcp-status-ok' : 'mcp-status-err');
          statusDiv.textContent = (data.ok ? '✓ ' : '✗ ') + data.message;
          const body = row.querySelector('.check-body');
          if (body) { body.appendChild(statusDiv); }
        }
      } else if (data.type === 'mcpServerRunStatus') {
        const prevLog = _mcpRunCache[data.path] && _mcpRunCache[data.path].log;
        const keepPrev = data.state === 'error' || data.state === 'running';
        _mcpRunCache[data.path] = { state: data.state, message: data.message, log: data.log != null ? data.log : (keepPrev ? prevLog : undefined) };
        updateMcpRunUi(data.path);
      } else if (data.type === 'mcpServerLog') {
        const info = _mcpRunCache[data.path];
        if (info) { info.log = (info.log || '') + data.chunk; }
        appendMcpRunLog(data.path, data.chunk);
      } else if (data.type === 'mcpDiscoverStatus') {
        const st = document.getElementById('mcp-discover-status');
        if (st) {
          st.style.display = '';
          st.className = 'mcp-discover-status ' + data.state;
          st.textContent = data.message;
        }
        // 'done' is followed by a fresh 'data' render; keep the button locked
        // only while a probe is actually in flight.
        if (data.state !== 'progress') {
          const btn = document.getElementById('btnMcpDiscover');
          if (btn) { btn.disabled = false; btn.textContent = '⟳ from server'; }
        }
      }
    });

    // ── helpers ────────────────────────────────────────────
    const ICONS = { ok: '✓', warn: '⚠', missing: '✗', info: '·' };
    function esc(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── render checks tab ─────────────────────────────────
    let _homeDir = '';
    function renderChecks(checks) {
      const ok   = checks.filter(c => c.status === 'ok').length;
      const warn = checks.filter(c => c.status === 'warn').length;
      const miss = checks.filter(c => c.status === 'missing').length;
      const info = checks.filter(c => c.status === 'info').length;

      let html = '<div class="toolbar"><div class="summary">';
      html += '<span class="sum-ok"><span class="sum-num">'   + ok   + '</span> ok</span>';
      if (warn) html += '<span class="sum-warn"><span class="sum-num">' + warn + '</span> warn</span>';
      if (miss) html += '<span class="sum-miss"><span class="sum-num">' + miss + '</span> missing</span>';
      html += '<span class="sum-info"><span class="sum-num">' + info + '</span> info</span>';
      html += '</div>';
      html += '<button class="btn-icon" id="btnRefresh" title="Refresh checks">↻</button>';
      html += '</div>';

      const order = [], cats = {};
      for (const c of checks) {
        if (!cats[c.category]) { order.push(c.category); cats[c.category] = []; }
        cats[c.category].push(c);
      }
      for (const cat of order) {
        html += '<div class="cat-header">' + esc(cat) + '</div>';
        for (const c of cats[cat]) {
          const idx = checks.indexOf(c);
          const isLink = !!c.path;
          html += '<div class="check' + (isLink ? ' link' : '') + '" data-idx="' + idx + '">';
          html += '<span class="dot s-' + c.status + '">' + (ICONS[c.status]||'·') + '</span>';
          html += '<div class="check-body">';
          html += '<div class="check-name">' + esc(c.name);
          if (c.scope === 'personal') html += ' <span class="scope-badge scope-home">' + esc(_homeDir || '~') + '</span>';
          else if (c.scope === 'workspace') html += ' <span class="scope-badge scope-ws">workspace</span>';
          if (isLink) html += ' <button class="btn-delete" data-idx="' + idx + '">delete</button>';
          if (c.category === 'Skills' && isLink) {
            const cr = skillCheckCache[c.name];
            const chkCls = cr ? ' ' + cr.cls : '';
            const chkLbl = cr ? cr.lbl : 'check';
            html += ' <button class="btn-check' + chkCls + '" data-idx="' + idx + '" data-skill="' + esc(c.name) + '" title="Validate SKILL.md against spec">' + chkLbl + '</button>';
          }
          html += '</div>';
          html += '<div class="check-msg">'  + esc(c.message) + '</div>';
          html += '</div></div>';
        }
      }

      const root = document.getElementById('checks-root');
      root.innerHTML = html;
      root.querySelector('#btnRefresh').addEventListener('click', () =>
        vscode.postMessage({ type: 'refresh' })
      );
      root.querySelectorAll('.check.link').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.btn-delete')) { return; }
          if (e.target.closest('.btn-check')) { return; }
          vscode.postMessage({ type: 'openFile', index: parseInt(el.dataset.idx, 10) });
        });
      });
      root.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          vscode.postMessage({ type: 'deleteFile', index: parseInt(btn.dataset.idx, 10) });
        });
      });
      root.querySelectorAll('.btn-check').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          btn.disabled = true;
          btn.textContent = '…';
          vscode.postMessage({ type: 'checkSkill', index: parseInt(btn.dataset.idx, 10), skillName: btn.dataset.skill });
        });
      });
    }

    // ── render create tab ─────────────────────────────────
    function renderCreators(creators, listId) {
      let html = '';
      let lastSection = null;
      for (const c of creators) {
        const section = c.section || '';
        if (section && section !== lastSection) {
          lastSection = section;
          html += '<div class="creator-section-hdr">' + esc(section) + '</div>';
        }

        let btnCls, btnLbl;
        if (c.type === 'salesforce-awesome-skills') {
          btnCls = c.exists ? 'open' : 'new';
          btnLbl = c.exists ? 'Reinstall' : 'Install Pack';
        } else if (c.type === 'sf-skills-library') {
          btnCls = 'new';
          btnLbl = 'Browse';
        } else {
          btnCls = c.exists ? 'open' : 'new';
          btnLbl = c.exists ? 'Open' : 'Create';
        }

        html += '<div class="creator-card">';
        html += '<span class="creator-icon">' + esc(c.icon) + '</span>';
        html += '<div class="creator-body">';
        html += '<div class="creator-label">'  + esc(c.label) + '</div>';
        html += '<div class="creator-desc">'   + esc(c.description) + '</div>';
        if (c.type === 'salesforce-awesome-skills') {
          html += '<div class="creator-target"><a href="https://awesome-copilot.github.com/skills/">awesome-copilot.github.com/skills/</a></div>';
        } else {
          html += '<div class="creator-target">' + esc(c.target) + '</div>';
        }
        html += '</div>';
        html += '<button class="btn-create ' + btnCls + '" data-type="' + esc(c.type) + '">' + btnLbl + '</button>';
        html += '</div>';
      }
      const list = document.getElementById(listId);
      list.innerHTML = html;
      list.querySelectorAll('.btn-create').forEach(btn => {
        btn.addEventListener('click', () =>
          vscode.postMessage({ type: 'createFile', fileType: btn.dataset.type })
        );
      });
    }

    // ── render MCP tab ────────────────────────────────────
    let _mcpNonGaInfo = {};
    let _mcpSource = 'builtin';
    let _mcpDiscoveredAt = null;
    let _mcpRunCache = {};   // fullPath -> { state: 'idle'|'starting'|'running'|'stopped'|'error', message }

    function mcpRunBadgeParts(info) {
      if (info.state === 'starting') { return { cls: 'starting', icon: '◐', label: 'Starting…' }; }
      if (info.state === 'running')  { return { cls: 'running',  icon: '●', label: 'Running' }; }
      if (info.state === 'error')    { return { cls: 'error',    icon: '✗', label: 'Error' }; }
      if (info.state === 'stopped')  { return { cls: 'idle',     icon: '○', label: 'Stopped' }; }
      return { cls: 'idle', icon: '○', label: 'Not running' };
    }

    // Collapsible "Server log" panel — auto-expanded on error, collapsed (but
    // present) while running so it stays available without cluttering the view.
    function mcpLogDetailsHtml(info) {
      const open = info.state === 'error' ? ' open' : '';
      const label = info.state === 'running' ? 'Server log (live)' : 'Server log';
      return '<details' + open + '><summary>' + label + '</summary><pre class="mcp-run-log-pre">' + esc(info.log || '') + '</pre></details>';
    }

    // Live-append a stdout/stderr chunk to a running server's log panel.
    function appendMcpRunLog(filePath, chunk) {
      const logWrap = Array.from(document.querySelectorAll('.mcp-run-log')).find(e => e.dataset.runPath === filePath);
      if (!logWrap) { return; }
      const pre = logWrap.querySelector('.mcp-run-log-pre');
      if (!pre) {
        // Panel not built yet — rebuild from cache (which already includes chunk).
        const info = _mcpRunCache[filePath];
        if (info && info.log) { logWrap.style.display = ''; logWrap.innerHTML = mcpLogDetailsHtml(info); }
        return;
      }
      const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 30;
      pre.appendChild(document.createTextNode(chunk));
      if (nearBottom) { pre.scrollTop = pre.scrollHeight; }
    }

    // Patch the badge/button/message for one server row in place, without a
    // full re-render — keeps focus/scroll stable while a server is starting.
    function updateMcpRunUi(filePath) {
      const info = _mcpRunCache[filePath] || { state: 'idle' };
      const parts = mcpRunBadgeParts(info);
      const badge = Array.from(document.querySelectorAll('.mcp-run-badge')).find(e => e.dataset.runPath === filePath);
      if (badge) {
        badge.className = 'mcp-run-badge ' + parts.cls;
        badge.textContent = parts.icon + ' ' + parts.label;
      }
      const btn = Array.from(document.querySelectorAll('.btn-run-mcp')).find(e => e.dataset.path === filePath);
      if (btn) {
        btn.textContent = info.state === 'running' ? 'Stop Server' : (info.state === 'starting' ? 'Starting…' : 'Run Server');
        btn.disabled = info.state === 'starting';
      }
      const msgDiv = Array.from(document.querySelectorAll('.mcp-run-msg')).find(e => e.dataset.runPath === filePath);
      if (msgDiv) {
        msgDiv.textContent = info.message || '';
        msgDiv.className = 'mcp-run-msg check-msg' + (info.state === 'error' ? ' mcp-status-err' : info.state === 'running' ? ' mcp-status-ok' : '');
      }
      const logWrap = Array.from(document.querySelectorAll('.mcp-run-log')).find(e => e.dataset.runPath === filePath);
      if (logWrap) {
        if (info.log) {
          logWrap.style.display = '';
          logWrap.innerHTML = mcpLogDetailsHtml(info);
        } else {
          logWrap.style.display = 'none';
          logWrap.innerHTML = '';
        }
      }
    }

    function renderMcp(files, toolsets, nonGaInfo) {
      if (!files || !toolsets) { return; }
      if (nonGaInfo) { _mcpNonGaInfo = nonGaInfo; }
      let html = '';

      // ── Configuration section ─────────────────────────
      html += '<div class="mcp-section-hdr">';
      html += '<div class="cat-header" style="margin-top:8px;margin-bottom:0">Configuration</div>';
      html += '<button class="btn-icon" id="btnMcpRefresh" title="Refresh MCP configuration" style="margin-top:6px">↻</button>';
      html += '</div>';
      const anyConfigured = files.some(f => f.hasSalesforceMcp);

      for (const f of files) {
        const dotCls  = !f.exists ? 's-info' : f.hasSalesforceMcp ? 's-ok' : 's-warn';
        const dotIcon = !f.exists ? '·'      : f.hasSalesforceMcp ? '✓'    : '○';
        const scopeCls = f.scope === 'personal' ? 'scope-home' : 'scope-ws';
        const showRun = f.exists && f.hasSalesforceMcp;
        const runInfo = _mcpRunCache[f.fullPath] || { state: 'idle' };
        const runParts = mcpRunBadgeParts(runInfo);
        html += '<div class="mcp-file-row" data-path="' + esc(f.fullPath || '') + '">';
        html += '<span class="dot ' + dotCls + '">' + dotIcon + '</span>';
        html += '<div class="check-body">';
        html += '<div class="check-name">' + esc(f.relPath) +
                ' <span class="scope-badge ' + scopeCls + '">' + esc(f.scope) + '</span>' +
                (showRun ? ' <span class="mcp-run-badge ' + runParts.cls + '" data-run-path="' + esc(f.fullPath) + '">' + runParts.icon + ' ' + esc(runParts.label) + '</span>' : '') +
                (f.exists ? ' <button class="btn-show-file" data-path="' + esc(f.fullPath) + '">SHOW</button>' : '') +
                (f.exists && f.hasSalesforceMcp ? ' <button class="btn-check-mcp" data-path="' + esc(f.fullPath) + '">CHECK</button>' : '') +
                (showRun ? ' <button class="btn-run-mcp" data-path="' + esc(f.fullPath) + '"' + (runInfo.state === 'starting' ? ' disabled' : '') + '>' + esc(runInfo.state === 'running' ? 'Stop Server' : (runInfo.state === 'starting' ? 'Starting…' : 'Run Server')) + '</button>' : '') +
                '</div>';
        if (!f.exists) {
          html += '<div class="check-msg">not found</div>';
        } else if (!f.hasSalesforceMcp) {
          html += '<div class="check-msg">file exists — @salesforce/mcp not configured</div>';
        } else {
          for (const srv of f.servers) {
            let detail = 'server: <strong>' + esc(srv.name) + '</strong>';
            if (srv.orgs.length)     { detail += ' &nbsp;&middot;&nbsp; orgs: '     + esc(srv.orgs.join(', ')); }
            if (srv.toolsets.length) { detail += ' &nbsp;&middot;&nbsp; toolsets: ' + esc(srv.toolsets.join(', ')); }
            else                     { detail += ' &nbsp;&middot;&nbsp; toolsets: <em>all</em>'; }
            if (srv.tools && srv.tools.length) { detail += ' &nbsp;&middot;&nbsp; tools: ' + esc(srv.tools.join(', ')); }
            html += '<div class="check-msg">' + detail + '</div>';
          }
        }
        if (showRun) {
          const runMsgCls = runInfo.state === 'error' ? ' mcp-status-err' : runInfo.state === 'running' ? ' mcp-status-ok' : '';
          html += '<div class="mcp-run-msg check-msg' + runMsgCls + '" data-run-path="' + esc(f.fullPath) + '">' + esc(runInfo.message || '') + '</div>';
          const logStyle = runInfo.log ? '' : 'display:none';
          html += '<div class="mcp-run-log" data-run-path="' + esc(f.fullPath) + '" style="' + logStyle + '">';
          if (runInfo.log) { html += mcpLogDetailsHtml(runInfo); }
          html += '</div>';
        }
        html += '</div></div>';
      }

      // ── --allow-non-ga-tools checkbox ─────────────────
      html += '<div class="mcp-option-row">';
      html += '<input type="checkbox" class="mcp-option-chk" id="chk-allow-non-ga">';
      html += '<label for="chk-allow-non-ga" class="mcp-option-label">--allow-non-ga-tools</label>';
      html += '<span class="mcp-option-hint">include non-GA (pilot/beta) tools</span>';
      html += '</div>';

      // ── Install buttons ────────────────────────────────
      html += '<div class="mcp-install-bar">';
      html += '<button class="btn-mcp-install" data-target="vscode"     title="Create or update .vscode/mcp.json">Install for Workspace (VS Code)</button>';
      html += '<button class="btn-mcp-install" data-target="claudecode" title="Create or update .mcp.json">Install for Workspace (Claude Code)</button>';
      html += '</div>';
      html += '<div class="mcp-warn-msg" id="mcp-warn-msg"></div>';

      if (!anyConfigured) {
        html += '<div class="mcp-quickstart">';
        html += 'Check toolsets or individual tools below, then click <em>Install</em>. ';
        html += 'Requires an active default org (<code>sf org display</code>). ';
        html += 'See <a href="https://github.com/salesforcecli/mcp#mcp-client-configurations">MCP Client Configurations</a> for other clients. ';
        html += '<a href="https://developer.salesforce.com/docs/platform/lwc/guide/mcp-reference.html">MCP Reference ↗</a>';
        html += '</div>';
      }

      // ── Toolsets with checkboxes ──────────────────────
      html += '<div class="mcp-section-hdr" style="margin-top:16px">';
      html += '<div class="cat-header" style="margin-top:0;margin-bottom:0">Toolsets</div>';
      html += '<span style="display:flex;align-items:center;gap:8px">';
      html += '<a href="https://developer.salesforce.com/docs/platform/lwc/guide/mcp-reference.html" style="font-size:10px;opacity:0.7;text-decoration:none" title="Salesforce MCP Reference">Tools Reference ↗</a>';
      html += '<button class="btn-icon" id="btnMcpDiscover" title="Query your installed @salesforce/mcp server for the live toolset list and GA/non-GA status">⟳ from server</button>';
      html += '</span>';
      html += '</div>';
      // Source indicator — built-in catalog vs. live discovery.
      if (_mcpSource === 'live') {
        const when = _mcpDiscoveredAt ? new Date(_mcpDiscoveredAt).toLocaleTimeString() : '';
        html += '<div class="mcp-src-note live">● Live — read from your installed @salesforce/mcp' + (when ? ' at ' + esc(when) : '') + '</div>';
      } else {
        html += '<div class="mcp-src-note">○ Built-in list — click <strong>⟳ from server</strong> to read the live toolsets &amp; GA/non-GA status from your installed @salesforce/mcp.</div>';
      }
      html += '<div class="mcp-discover-status" id="mcp-discover-status" style="display:none"></div>';
      html += '<p class="create-intro" style="margin-bottom:4px">Check a <strong>toolset</strong> to enable all its tools, or check individual tools for <code style="font-size:10px;background:rgba(0,0,0,.2);padding:1px 4px;border-radius:2px">--tools</code>. Badges mark non-GA tools.</p>';

      for (const ts of toolsets) {
        const hasNonGa = ts.nonGaTools && ts.nonGaTools.length > 0;
        html += '<div class="mcp-toolset">';
        html += '<div class="mcp-ts-header">';
        if (ts.alwaysOn) {
          html += '<span class="mcp-ts-name">' + esc(ts.name) + '</span>';
          html += '<span class="mcp-ts-badge always">always on</span>';
          html += '<span class="mcp-ts-label">' + esc(ts.label) + '</span>';
        } else {
          html += '<input type="checkbox" class="mcp-ts-chk" id="ts-' + esc(ts.name) + '" data-ts="' + esc(ts.name) + '">';
          html += '<label for="ts-' + esc(ts.name) + '" class="mcp-ts-check-wrap">';
          html += '<span class="mcp-ts-name">' + esc(ts.name) + '</span>';
          if (hasNonGa) { html += '<span class="mcp-ts-badge non-ga">non-GA</span>'; }
          html += '<span class="mcp-ts-label">' + esc(ts.label) + '</span>';
          html += '</label>';
        }
        html += '</div>';
        html += '<div class="mcp-ts-desc">' + esc(ts.description) + '</div>';
        html += '<div class="mcp-ts-tools">';
        for (const t of ts.tools) {
          const isNonGa = ts.nonGaTools && ts.nonGaTools.includes(t);
          if (ts.alwaysOn) {
            html += '<code class="mcp-tool">' + esc(t) + '</code>';
          } else {
            html += '<label class="mcp-tool-label">';
            html += '<input type="checkbox" class="mcp-tool-chk" data-ts="' + esc(ts.name) + '" data-tool="' + esc(t) + '"' + (isNonGa ? ' data-non-ga="1"' : '') + '>';
            html += '<code class="mcp-tool' + (isNonGa ? ' non-ga' : '') + '">' + esc(t) + '</code>';
            html += '</label>';
          }
        }
        html += '</div></div>';
      }

      // ── Non-GA tools reference ────────────────────────
      const nonGaToolsets = toolsets.filter(ts => ts.nonGaTools && ts.nonGaTools.length > 0);
      if (nonGaToolsets.length > 0) {
        html += '<div class="mcp-section-hdr" style="margin-top:20px">';
        html += '<div class="cat-header" style="margin-top:0;margin-bottom:0">Non-GA Tools (Pilot / Beta)</div>';
        html += '<a href="https://developer.salesforce.com/docs/platform/lwc/guide/mcp-reference.html" style="font-size:10px;opacity:0.7;text-decoration:none" title="Salesforce MCP Reference">Tools Reference ↗</a>';
        html += '</div>';
        html += '<p class="create-intro" style="margin-bottom:4px">These tools are not yet generally available. Enable them by checking <strong>--allow-non-ga-tools</strong> above before installing. Subject to <a href="https://www.salesforce.com/company/legal/">Beta Services Terms</a>.</p>';
        for (const ts of nonGaToolsets) {
          for (const toolName of ts.nonGaTools) {
            const desc = nonGaInfo && nonGaInfo[toolName] ? nonGaInfo[toolName] : '';
            html += '<div class="mcp-nonga-tool">';
            html += '<div class="mcp-nonga-tool-name">';
            html += esc(toolName);
            html += ' <span class="mcp-nonga-tool-ts">(' + esc(ts.name) + ')</span>';
            html += '</div>';
            if (desc) { html += '<div class="mcp-nonga-tool-desc">' + esc(desc) + '</div>'; }
            html += '</div>';
          }
        }
      }

      const root = document.getElementById('mcp-root');
      root.innerHTML = html;

      // Refresh button
      root.querySelector('#btnMcpRefresh').addEventListener('click', () =>
        vscode.postMessage({ type: 'refresh' })
      );

      // Discover-from-server button (Option C)
      const discBtn = root.querySelector('#btnMcpDiscover');
      if (discBtn) {
        discBtn.addEventListener('click', () => {
          discBtn.disabled = true;
          discBtn.textContent = '⟳ querying…';
          const st = document.getElementById('mcp-discover-status');
          if (st) { st.style.display = ''; st.className = 'mcp-discover-status progress'; st.textContent = 'Starting…'; }
          vscode.postMessage({ type: 'discoverMcpToolsets' });
        });
      }

      // SHOW buttons — open file in editor
      root.querySelectorAll('.btn-show-file').forEach(btn => {
        btn.addEventListener('click', () =>
          vscode.postMessage({ type: 'showMcpFile', path: btn.dataset.path })
        );
      });

      // CHECK buttons — probe org + Node.js version
      root.querySelectorAll('.btn-check-mcp').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.mcp-file-row');
          const prev = row && row.querySelector('.mcp-check-status');
          if (prev) { prev.remove(); }
          btn.textContent = '…';
          btn.disabled = true;
          vscode.postMessage({ type: 'checkMcpServer', path: btn.dataset.path });
        });
      });

      // Run Server / Stop Server buttons
      root.querySelectorAll('.btn-run-mcp').forEach(btn => {
        btn.addEventListener('click', () => {
          const p = btn.dataset.path;
          const info = _mcpRunCache[p] || { state: 'idle' };
          if (info.state === 'running') {
            vscode.postMessage({ type: 'stopMcpServer', path: p });
          } else if (info.state !== 'starting') {
            _mcpRunCache[p] = { state: 'starting', message: 'Starting…' };
            updateMcpRunUi(p);
            vscode.postMessage({ type: 'runMcpServer', path: p });
          }
        });
      });

      // Toolset checkbox → disable/enable individual tool checkboxes
      root.querySelectorAll('.mcp-ts-chk').forEach(chk => {
        chk.addEventListener('change', () => {
          root.querySelectorAll('.mcp-tool-chk[data-ts="' + chk.dataset.ts + '"]').forEach(tc => {
            tc.disabled = chk.checked;
            if (chk.checked) { tc.checked = false; }
          });
        });
      });

      // Pre-check toolsets/tools from first configured workspace file
      const configured = files.find(f => f.hasSalesforceMcp && f.scope === 'workspace');
      if (configured && configured.servers.length > 0) {
        const srv = configured.servers[0];
        srv.toolsets.forEach(tsName => {
          const chk = root.querySelector('.mcp-ts-chk[data-ts="' + tsName + '"]');
          if (chk) {
            chk.checked = true;
            root.querySelectorAll('.mcp-tool-chk[data-ts="' + tsName + '"]').forEach(tc => { tc.disabled = true; });
          }
        });
        if (srv.tools) {
          srv.tools.forEach(toolName => {
            const chk = root.querySelector('.mcp-tool-chk[data-tool="' + toolName + '"]');
            if (chk && !chk.disabled) { chk.checked = true; }
          });
        }
        // Restore --allow-non-ga-tools checkbox from config
        if (srv.allowNonGa) {
          const ngaChk = document.getElementById('chk-allow-non-ga');
          if (ngaChk) {
            ngaChk.checked = true;
            // Also check any non-GA tools that aren't already covered by a toolset
            root.querySelectorAll('.mcp-tool-chk[data-non-ga="1"]').forEach(tc => {
              if (!tc.disabled) { tc.checked = true; }
            });
          }
        }
      }

      // --allow-non-ga-tools checkbox → check/uncheck non-GA tool checkboxes
      document.getElementById('chk-allow-non-ga').addEventListener('change', function() {
        if (this.checked) {
          root.querySelectorAll('.mcp-tool-chk[data-non-ga="1"]').forEach(tc => {
            if (!tc.disabled) { tc.checked = true; }
          });
        } else {
          root.querySelectorAll('.mcp-tool-chk[data-non-ga="1"]').forEach(tc => { tc.checked = false; });
        }
      });

      // Install buttons
      root.querySelectorAll('.btn-mcp-install').forEach(btn => {
        btn.addEventListener('click', () => {
          const checkedToolsets = [...root.querySelectorAll('.mcp-ts-chk:checked')].map(c => c.dataset.ts).filter(Boolean);
          const checkedTools    = [...root.querySelectorAll('.mcp-tool-chk:checked')].map(c => c.dataset.tool).filter(Boolean);
          const allowNonGa      = document.getElementById('chk-allow-non-ga').checked;
          const warnEl = document.getElementById('mcp-warn-msg');
          if (checkedToolsets.length === 0 && checkedTools.length === 0) {
            warnEl.textContent = 'Select at least one toolset or tool before installing.';
            warnEl.style.display = '';
            return;
          }
          warnEl.style.display = 'none';
          vscode.postMessage({ type: 'installMcp', target: btn.dataset.target, toolsets: checkedToolsets, tools: checkedTools, allowNonGa });
        });
      });
    }

    // Signal host that the message listener is registered and ready
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
	}
}

// ---------------------------------------------------------------------------
// SfSkillsPanel — editor-area webview for browsing forcedotcom/sf-skills
// ---------------------------------------------------------------------------

interface SfSkillFileRef { name: string; url: string; }

interface SfSkillDetail {
	skillName: string;
	description: string;
	hasAssets: boolean;
	hasReferences: boolean;
	references: SfSkillFileRef[];
	assets: SfSkillFileRef[];
	isInstalled: boolean;
}

class SfSkillsPanel {
	public static currentPanel: SfSkillsPanel | undefined;
	private static readonly viewType = 'sfSkillsLibrary';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _workspaceRoot: string | undefined;
	private readonly _disposables: vscode.Disposable[] = [];

	public static createOrShow(workspaceRoot?: string) {
		if (SfSkillsPanel.currentPanel) {
			SfSkillsPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			SfSkillsPanel.viewType,
			'Salesforce Skills Library',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		SfSkillsPanel.currentPanel = new SfSkillsPanel(panel, workspaceRoot);
	}

	private constructor(panel: vscode.WebviewPanel, workspaceRoot?: string) {
		this._panel = panel;
		this._workspaceRoot = workspaceRoot;
		this._panel.webview.html = this._getHtml();
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'getSkillsList':    await this._sendSkillsList(); break;
				case 'getSkillDetail':  await this._sendSkillDetail(msg.skillName as string); break;
				case 'installSkill':    await this._installSkill(msg.skillName as string); break;
				case 'openGitHub':
					await vscode.env.openExternal(vscode.Uri.parse(msg.url as string));
					break;
				case 'checkSkill': {
					const skillName = msg.skillName as string;
					const report = SkillValidationReportPanel.createOrShow(this._workspaceRoot);
					await report.checkSkill(skillName);
					// Also post inline result back to the SfSkillsPanel webview for badge update
					const paths = findInstalledSkillPaths(skillName, this._workspaceRoot);
					const merged: SkillValidationResult = { errors: [], warnings: [] };
					if (paths.length === 0) {
						merged.errors.push(`${skillName}: not installed`);
					} else {
						for (const p of paths) {
							const r = validateSkillLocal(skillName, p);
							merged.errors.push(...r.errors);
							merged.warnings.push(...r.warnings);
						}
					}
					const status = paths.length === 0 ? 'not-installed' : merged.errors.length > 0 ? 'error' : merged.warnings.length > 0 ? 'warn' : 'ok';
					this._panel.webview.postMessage({ type: 'checkResult', skillName, status, errors: merged.errors, warnings: merged.warnings });
					break;
				}
				case 'validateAllInstalled': {
					const names = msg.skillNames as string[];
					const report = SkillValidationReportPanel.createOrShow(this._workspaceRoot);
					await report.checkSkills(names);
					break;
				}
			}
		}, null, this._disposables);
	}

	private _isSkillInstalled(skillName: string): boolean {
		return (this._workspaceRoot
			? fileExists(path.join(this._workspaceRoot, '.github', 'skills', skillName, 'SKILL.md'))
			|| fileExists(path.join(this._workspaceRoot, '.claude', 'skills', skillName, 'SKILL.md'))
			|| fileExists(path.join(this._workspaceRoot, '.agents', 'skills', skillName, 'SKILL.md'))
			: false)
			|| fileExists(path.join(os.homedir(), '.copilot', 'skills', skillName, 'SKILL.md'))
			|| fileExists(path.join(os.homedir(), '.claude', 'skills', skillName, 'SKILL.md'))
			|| fileExists(path.join(os.homedir(), '.agents', 'skills', skillName, 'SKILL.md'));
	}

	private async _sendSkillsList() {
		try {
			const json = await fetchUrl(
				'https://api.github.com/repos/forcedotcom/sf-skills/contents/skills',
				{ 'Accept': 'application/vnd.github.v3+json' },
			);
			const items = JSON.parse(json) as Array<{ name: string; type: string; html_url: string }>;
			const skills = items
				.filter(i => i.type === 'dir')
				.map(i => ({ name: i.name, githubUrl: i.html_url, isInstalled: this._isSkillInstalled(i.name) }));
			this._panel.webview.postMessage({ type: 'skillsList', skills });
		} catch (e) {
			this._panel.webview.postMessage({ type: 'error', message: `Failed to load skill list: ${String(e)}` });
		}
	}

	private async _sendSkillDetail(skillName: string) {
		try {
			// Fetch SKILL.md
			const rawUrl = `https://raw.githubusercontent.com/forcedotcom/sf-skills/main/skills/${skillName}/SKILL.md`;
			const content = await fetchUrl(rawUrl);

			// Extract description from YAML-table frontmatter or first paragraph
			let description = '';
			const tblMatch = content.match(/\|\s*description\s*\|\s*([^|\r\n]+)/i);
			if (tblMatch) {
				description = tblMatch[1].trim();
			} else {
				const lines = content.split('\n').filter(l =>
					l.trim() && !l.startsWith('#') && !l.startsWith('|') && !l.startsWith('-') && !l.startsWith('---')
				);
				description = lines.slice(0, 2).join(' ').substring(0, 250);
			}

			// Fetch directory listing to detect assets/ and references/
			const dirJson = await fetchUrl(
				`https://api.github.com/repos/forcedotcom/sf-skills/contents/skills/${skillName}`,
				{ 'Accept': 'application/vnd.github.v3+json' },
			);
			const dirItems = JSON.parse(dirJson) as Array<{ name: string; type: string; html_url: string }>;
			const hasAssets     = dirItems.some(i => i.name === 'assets'     && i.type === 'dir');
			const hasReferences = dirItems.some(i => i.name === 'references' && i.type === 'dir');

			const fetchSubdir = async (sub: string): Promise<SfSkillFileRef[]> => {
				const sJson = await fetchUrl(
					`https://api.github.com/repos/forcedotcom/sf-skills/contents/skills/${skillName}/${sub}`,
					{ 'Accept': 'application/vnd.github.v3+json' },
				);
				const sItems = JSON.parse(sJson) as Array<{ name: string; html_url: string }>;
				return sItems.map(i => ({ name: i.name, url: i.html_url }));
			};

			const [references, assets] = await Promise.all([
				hasReferences ? fetchSubdir('references') : Promise.resolve([]),
				hasAssets     ? fetchSubdir('assets')     : Promise.resolve([]),
			]);

			const isInstalled = this._isSkillInstalled(skillName);

			const detail: SfSkillDetail = { skillName, description, hasAssets, hasReferences, references, assets, isInstalled };
			this._panel.webview.postMessage({ type: 'skillDetail', ...detail });
		} catch (e) {
			this._panel.webview.postMessage({ type: 'skillDetailError', skillName, message: String(e) });
		}
	}

	private async _installSkill(skillName: string) {
		const location = await vscode.window.showQuickPick([
			{ label: '$(root-folder) Project', description: '.github/skills/  — team-shared in repository', value: 'project' as const },
			{ label: '$(home) Personal',        description: '~/.copilot/skills/  — available in every workspace', value: 'personal' as const },
		], { title: `Where to install "${skillName}"?`, placeHolder: 'Choose installation location' });
		if (!location) {
			this._panel.webview.postMessage({ type: 'installResult', skillName, success: false, message: 'Cancelled.' });
			return;
		}

		const targetDir = location.value === 'personal'
			? path.join(os.homedir(), '.copilot', 'skills', skillName)
			: this._workspaceRoot
				? path.join(this._workspaceRoot, '.github', 'skills', skillName)
				: null;

		if (!targetDir) {
			this._panel.webview.postMessage({ type: 'installResult', skillName, success: false, message: 'No workspace folder open (required for project install).' });
			return;
		}

		try {
			const content = await fetchUrl(
				`https://raw.githubusercontent.com/forcedotcom/sf-skills/main/skills/${skillName}/SKILL.md`
			);
			// Skills go in {location}/{name}/SKILL.md — preserve the original SKILL.md content as-is.
			const targetPath = path.join(targetDir, 'SKILL.md');
			fs.mkdirSync(path.dirname(targetPath), { recursive: true });
			fs.writeFileSync(targetPath, content, 'utf8');

			// Also install references/ and assets/ subdirectories when present.
			try {
				const dirJson = await fetchUrl(
					`https://api.github.com/repos/forcedotcom/sf-skills/contents/skills/${skillName}`,
					{ 'Accept': 'application/vnd.github.v3+json' },
				);
				const dirItems = JSON.parse(dirJson) as Array<{ name: string; type: string }>;
				for (const sub of ['references', 'assets'] as const) {
					if (!dirItems.some(i => i.name === sub && i.type === 'dir')) { continue; }
					const subJson = await fetchUrl(
						`https://api.github.com/repos/forcedotcom/sf-skills/contents/skills/${skillName}/${sub}`,
						{ 'Accept': 'application/vnd.github.v3+json' },
					);
					const subItems = JSON.parse(subJson) as Array<{ name: string; type: string; download_url: string | null }>;
					for (const item of subItems.filter(i => i.type === 'file' && i.download_url)) {
						const fileContent = await fetchUrl(item.download_url!);
						const filePath = path.join(targetDir, sub, item.name);
						fs.mkdirSync(path.dirname(filePath), { recursive: true });
						fs.writeFileSync(filePath, fileContent, 'utf8');
					}
				}
			} catch {
				// references/assets are optional — SKILL.md is already saved
			}

			const displayPath = location.value === 'personal'
				? `~/.copilot/skills/${skillName}/SKILL.md`
				: path.relative(this._workspaceRoot!, targetPath);
			this._panel.webview.postMessage({
				type: 'installResult', skillName, success: true,
				filePath: displayPath,
			});
		} catch (e) {
			this._panel.webview.postMessage({ type: 'installResult', skillName, success: false, message: String(e) });
		}
	}

	public dispose() {
		SfSkillsPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) { this._disposables.pop()?.dispose(); }
	}

	private _getHtml(): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0 24px 40px 24px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    /* header */
    .sf-header {
      padding: 20px 0 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      margin-bottom: 16px;
      display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
    }
    .sf-title { margin: 0; font-size: 17px; font-weight: 700; }
    .sf-subtitle {
      font-size: 12px; color: var(--vscode-descriptionForeground);
    }
    .sf-subtitle a { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; }
    .sf-subtitle a:hover { text-decoration: underline; }
    /* toolbar */
    .sf-toolbar { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; }
    .sf-search {
      flex: 1; padding: 5px 10px; font-size: 12px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border, #3c3c3c);
      border-radius: 4px; outline: none;
    }
    .sf-search:focus { border-color: var(--vscode-focusBorder, #007acc); }
    .sf-btn-icon {
      background: none; border: none; color: var(--vscode-icon-foreground);
      cursor: pointer; padding: 3px 6px; border-radius: 3px; font-size: 15px;
    }
    .sf-btn-icon:hover { background: var(--vscode-toolbar-hoverBackground); }
    /* stats */
    .sf-stats { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom: 14px; }
    .sf-stats strong { color: var(--vscode-foreground); }
    /* table */
    .sf-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .sf-table thead th {
      text-align: left; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: 0.06em;
      color: var(--vscode-descriptionForeground);
      padding: 6px 8px; border-bottom: 2px solid var(--vscode-panel-border, #333);
      overflow: hidden;
    }
    .sf-skill-row {
      border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a);
      cursor: pointer;
    }
    .sf-skill-row:hover > td { background: var(--vscode-list-hoverBackground); }
    .sf-skill-row td { padding: 7px 8px; vertical-align: top; overflow: hidden; }
    .sf-arrow { font-size: 9px; width: 16px; display: inline-block; transition: transform 0.15s; flex-shrink: 0; }
    .sf-arrow.open { transform: rotate(90deg); }
    .sf-skill-name {
      display: block; font-weight: 600; font-size: 12px;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-textLink-foreground);
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sf-skill-desc {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      white-space: normal; word-break: break-word; line-height: 1.45;
    }
    .sf-badge {
      display: inline-flex; align-items: center;
      font-size: 10px; font-weight: 600;
      padding: 2px 7px; border-radius: 10px; margin-right: 3px;
    }
    .sf-badge-ref  { background: rgba(0,122,204,.15); color: #3794ff; }
    .sf-badge-asset{ background: rgba(78,201,176,.15); color: #4ec9b0; }
    .sf-badge-ok   { background: rgba(78,201,176,.22); color: #4ec9b0; }
    .sf-actions { white-space: nowrap; text-align: right; }
    .sf-btn-install {
      font-size: 11px; font-weight: 600;
      padding: 3px 10px; border-radius: 3px; cursor: pointer;
      border: 1px solid transparent;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .sf-btn-install:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .sf-btn-install.installed {
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .sf-btn-install:disabled { opacity: .65; cursor: not-allowed; }
    .sf-btn-gh {
      font-size: 11px; padding: 3px 7px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      background: transparent; color: var(--vscode-descriptionForeground);
      margin-left: 4px;
    }
    .sf-btn-gh:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-foreground); }
    .sf-btn-check {
      font-size: 11px; font-weight: 600; padding: 3px 8px; border-radius: 3px; cursor: pointer;
      border: 1px solid transparent; margin-left: 4px;
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
    }
    .sf-btn-check:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .sf-btn-check:disabled { opacity: .45; cursor: not-allowed; }
    .sf-btn-check.ok    { color: #4ec9b0; border-color: rgba(78,201,176,.4); }
    .sf-btn-check.warn  { color: #f0c040; border-color: rgba(240,192,64,.4); }
    .sf-btn-check.error { color: #f14c4c; border-color: rgba(241,76,76,.4); }
    /* validate-all button in toolbar */
    .sf-btn-validate {
      font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 3px; cursor: pointer;
      border: 1px solid transparent;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .sf-btn-validate:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    /* inline validation badge in detail row */
    .sf-val-badge {
      display: inline-flex; align-items: center; gap: 5px;
      font-size: 11px; padding: 3px 8px; border-radius: 10px; font-weight: 600;
    }
    .sf-val-ok    { background: rgba(78,201,176,.18);  color: #4ec9b0; }
    .sf-val-warn  { background: rgba(240,192,64,.18);  color: #f0c040; }
    .sf-val-error { background: rgba(241,76,76,.15);   color: #f14c4c; }
    .sf-val-ns    { background: rgba(128,128,128,.18); color: var(--vscode-descriptionForeground); }
    .sf-val-issues { margin-top: 6px; font-size: 11px; }
    .sf-val-issue-e { color: #f14c4c; padding-left: 14px; position: relative; }
    .sf-val-issue-e::before { content:'✗ '; position: absolute; left:0; }
    .sf-val-issue-w { color: #f0c040; padding-left: 14px; position: relative; }
    .sf-val-issue-w::before { content:'⚠ '; position: absolute; left:0; }
    /* detail rows */
    .sf-detail-row { display: none; }
    .sf-detail-row.visible { display: table-row; }
    .sf-detail-row td { padding: 0 8px 14px 28px; }
    .sf-detail-box {
      padding: 12px 14px;
      background: var(--vscode-sideBar-background, rgba(0,0,0,.12));
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
    }
    .sf-detail-sec { margin-bottom: 10px; }
    .sf-detail-sec:last-child { margin-bottom: 0; }
    .sf-detail-sec h4 {
      margin: 0 0 5px 0; font-size: 10px; text-transform: uppercase;
      letter-spacing: .06em; font-weight: 700;
      color: var(--vscode-descriptionForeground);
    }
    .sf-detail-desc { font-size: 12px; line-height: 1.6; }
    .sf-file-list { list-style: none; margin: 0; padding: 0; }
    .sf-file-list li {
      display: flex; align-items: center; gap: 7px;
      padding: 3px 0; font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
    }
    .sf-file-list a { color: var(--vscode-textLink-foreground); text-decoration: none; }
    .sf-file-list a:hover { text-decoration: underline; }
    .sf-installed-note { margin-top: 6px; font-size: 11px; color: #4ec9b0; }
    /* loading / error */
    .sf-loading {
      text-align: center; padding: 60px 0;
      color: var(--vscode-descriptionForeground); font-size: 13px;
    }
    .sf-error { text-align: center; padding: 40px; color: var(--vscode-errorForeground, #f14c4c); }
    .sf-spin { display: inline-block; animation: sfspin 1s linear infinite; }
    @keyframes sfspin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="sf-header">
    <h1 class="sf-title">☁ Salesforce Skills Library</h1>
    <span class="sf-subtitle">Powered by <a id="sfLinkGH">forcedotcom/sf-skills</a> on GitHub</span>
  </div>

  <div class="sf-toolbar">
    <input class="sf-search" id="sfSearch" type="text" placeholder="Search skills by name or description…">
    <button class="sf-btn-icon" id="sfRefresh" title="Refresh list from GitHub">↻</button>
    <button class="sf-btn-validate" id="sfValidateAll" title="Validate all installed skills in one report">✓ Validate Installed</button>
  </div>

  <div class="sf-stats" id="sfStats"></div>

  <div id="sfContent">
    <div class="sf-loading"><span class="sf-spin">↻</span>&nbsp;Loading Salesforce skills from GitHub…</div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let allSkills = [];
    let detailCache = {};
    let installedSet = new Set();
    let checkCache = {};   // skillName -> { status, errors, warnings }

    document.getElementById('sfLinkGH').addEventListener('click', () =>
      vscode.postMessage({ type: 'openGitHub', url: 'https://github.com/forcedotcom/sf-skills' })
    );
    document.getElementById('sfRefresh').addEventListener('click', () => {
      detailCache = {};
      document.getElementById('sfContent').innerHTML = '<div class="sf-loading"><span class="sf-spin">↻</span>&nbsp;Refreshing…</div>';
      vscode.postMessage({ type: 'getSkillsList' });
    });
    document.getElementById('sfValidateAll').addEventListener('click', () => {
      const installed = [...installedSet];
      if (!installed.length) { return; }
      vscode.postMessage({ type: 'validateAllInstalled', skillNames: installed });
    });
    document.getElementById('sfSearch').addEventListener('input', e => {
      renderTable(filterSkills(e.target.value));
    });

    window.addEventListener('message', ({ data }) => {
      switch (data.type) {
        case 'skillsList':
          allSkills = data.skills;
          for (const s of allSkills) { if (s.isInstalled) { installedSet.add(s.name); } }
          renderTable(allSkills);
          break;
        case 'skillDetail':
          detailCache[data.skillName] = data;
          updateDetailRow(data);
          break;
        case 'skillDetailError':
          showDetailError(data.skillName, data.message);
          break;
        case 'checkResult':
          handleCheckResult(data);
          break;
        case 'installResult':
          handleInstallResult(data);
          break;
        case 'error':
          document.getElementById('sfContent').innerHTML =
            '<div class="sf-error">⚠ ' + esc(data.message) + '</div>';
          break;
      }
    });

    function esc(s) {
      return String(s)
        .replace(/&/g,'&amp;').replace(/</g,'&lt;')
        .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function filterSkills(q) {
      if (!q.trim()) return allSkills;
      const lq = q.toLowerCase();
      return allSkills.filter(s => {
        if (s.name.toLowerCase().includes(lq)) return true;
        const d = detailCache[s.name];
        return d && d.description && d.description.toLowerCase().includes(lq);
      });
    }

    function renderTable(skills) {
      const total = allSkills.length;
      const shown = skills.length;
      document.getElementById('sfStats').innerHTML =
        '<strong>' + shown + '</strong> skill' + (shown !== 1 ? 's' : '') +
        (shown < total ? ' (filtered from ' + total + ')' : '');

      if (!skills.length) {
        document.getElementById('sfContent').innerHTML =
          '<div class="sf-error" style="color:var(--vscode-descriptionForeground)">No skills match your search.</div>';
        return;
      }

      let html = '<table class="sf-table"><thead><tr>';
      html += '<th style="width:20px"></th>';
      html += '<th style="width:190px">Skill</th>';
      html += '<th>Description</th>';
      html += '<th style="width:120px">Resources</th>';
      html += '<th style="width:185px;text-align:right">Actions</th>';
      html += '</tr></thead><tbody>';

      for (const s of skills) {
        const d = detailCache[s.name];
        const isIns = installedSet.has(s.name);
        const desc = d ? d.description : '';
        const hasRef = d ? d.hasReferences : false;
        const hasAss = d ? d.hasAssets    : false;

        html += '<tr class="sf-skill-row" data-skill="' + esc(s.name) + '">';
        html += '<td><span class="sf-arrow">▶</span></td>';
        html += '<td><span class="sf-skill-name">' + esc(s.name) + '</span></td>';
        html += '<td><span class="sf-skill-desc">' + esc(desc || '—') + '</span></td>';
        html += '<td>';
        if (hasRef) html += '<span class="sf-badge sf-badge-ref">📎 refs</span>';
        if (hasAss) html += '<span class="sf-badge sf-badge-asset">🖼 assets</span>';
        if (isIns)  html += '<span class="sf-badge sf-badge-ok">✓ installed</span>';
        html += '</td>';
        html += '<td class="sf-actions">';
        html += '<button class="sf-btn-install' + (isIns ? ' installed' : '') + '" data-skill="' + esc(s.name) + '">' + (isIns ? 'Reinstall' : 'Install') + '</button>';
        const chkData = checkCache[s.name];
        const chkCls  = chkData ? ' ' + chkData.status : '';
        const chkLbl  = chkData ? (chkData.status === 'ok' ? '✓' : chkData.status === 'warn' ? '⚠' : chkData.status === 'error' ? '✗' : '…') + ' Check' : 'Check';
        html += '<button class="sf-btn-check' + chkCls + '" data-skill="' + esc(s.name) + '"' + (!isIns ? ' disabled title="Install first to validate"' : ' title="Validate locally installed copy"') + '>' + chkLbl + '</button>';
        html += '<button class="sf-btn-gh" data-url="' + esc(s.githubUrl) + '" title="View on GitHub">↗</button>';
        html += '</td></tr>';

        // Detail row
        html += '<tr class="sf-detail-row" id="sfdr-' + esc(s.name) + '">';
        html += '<td colspan="5"><div class="sf-detail-box" id="sfdb-' + esc(s.name) + '">';
        if (d) { html += buildDetailHtml(d); }
        else   { html += '<div class="sf-loading" style="padding:8px 0"><span class="sf-spin">↻</span>&nbsp;Loading…</div>'; }
        if (checkCache[s.name]) { html += buildCheckHtml(s.name, checkCache[s.name]); }
        html += '</div></td></tr>';
      }
      html += '</tbody></table>';

      const cnt = document.getElementById('sfContent');
      cnt.innerHTML = html;

      cnt.querySelectorAll('.sf-skill-row').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.closest('.sf-btn-install') || e.target.closest('.sf-btn-gh') || e.target.closest('.sf-btn-check')) { return; }
          toggleRow(row.dataset.skill);
        });
      });
      cnt.querySelectorAll('.sf-btn-install').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); installSkill(btn.dataset.skill, btn); });
      });
      cnt.querySelectorAll('.sf-btn-check').forEach(btn => {
        btn.addEventListener('click', e => { e.stopPropagation(); checkSkill(btn.dataset.skill, btn); });
      });
      cnt.querySelectorAll('.sf-btn-gh').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          vscode.postMessage({ type: 'openGitHub', url: btn.dataset.url });
        });
      });
      bindDetailLinks(cnt);
    }

    function toggleRow(skillName) {
      const detRow = document.getElementById('sfdr-' + skillName);
      if (!detRow) { return; }
      const mainRow = document.querySelector('.sf-skill-row[data-skill="' + skillName + '"]');
      const arrow = mainRow.querySelector('.sf-arrow');
      if (detRow.classList.contains('visible')) {
        detRow.classList.remove('visible');
        arrow.classList.remove('open');
      } else {
        detRow.classList.add('visible');
        arrow.classList.add('open');
        if (!detailCache[skillName]) {
          vscode.postMessage({ type: 'getSkillDetail', skillName });
        }
      }
    }

    function buildDetailHtml(d) {
      let h = '';
      if (d.description) {
        h += '<div class="sf-detail-sec"><h4>Description</h4>';
        h += '<div class="sf-detail-desc">' + esc(d.description) + '</div></div>';
      }
      if (d.references && d.references.length) {
        h += '<div class="sf-detail-sec"><h4>📎 References (' + d.references.length + ')</h4>';
        h += '<ul class="sf-file-list">';
        for (const r of d.references) {
          h += '<li>📄 <a href="#" data-url="' + esc(r.url) + '">' + esc(r.name) + '</a></li>';
        }
        h += '</ul></div>';
      }
      if (d.assets && d.assets.length) {
        h += '<div class="sf-detail-sec"><h4>🖼 Assets (' + d.assets.length + ')</h4>';
        h += '<ul class="sf-file-list">';
        for (const a of d.assets) {
          h += '<li>🖼 <a href="#" data-url="' + esc(a.url) + '">' + esc(a.name) + '</a></li>';
        }
        h += '</ul></div>';
      }
      if (d.isInstalled) {
        h += '<div class="sf-installed-note">✓ Installed in .github/skills/' + esc(d.skillName) + '/SKILL.md</div>';
      }
      return h || '<div style="font-size:11px;color:var(--vscode-descriptionForeground)">No additional info.</div>';
    }

    function updateDetailRow(d) {
      const box = document.getElementById('sfdb-' + d.skillName);
      if (box) { box.innerHTML = buildDetailHtml(d); bindDetailLinks(box); }
      // Update badges and button state in main row
      const main = document.querySelector('.sf-skill-row[data-skill="' + d.skillName + '"]');
      if (main) {
        const descEl = main.querySelector('.sf-skill-desc');
        if (descEl && d.description) { descEl.textContent = d.description; }
        const badgeCell = main.querySelectorAll('td')[3];
        if (d.hasReferences && !badgeCell.querySelector('.sf-badge-ref')) {
          badgeCell.insertAdjacentHTML('afterbegin', '<span class="sf-badge sf-badge-ref">📎 refs</span>');
        }
        if (d.hasAssets && !badgeCell.querySelector('.sf-badge-asset')) {
          badgeCell.insertAdjacentHTML('afterbegin', '<span class="sf-badge sf-badge-asset">🖼 assets</span>');
        }
        if (d.isInstalled) {
          installedSet.add(d.skillName);
          const installBtn = main.querySelector('.sf-btn-install');
          if (installBtn && !installBtn.classList.contains('installed')) {
            installBtn.classList.add('installed');
            installBtn.textContent = 'Reinstall';
          }
          if (!badgeCell.querySelector('.sf-badge-ok')) {
            badgeCell.insertAdjacentHTML('beforeend', '<span class="sf-badge sf-badge-ok">✓ installed</span>');
          }
          const checkBtn = main.querySelector('.sf-btn-check');
          if (checkBtn) {
            checkBtn.disabled = false;
            checkBtn.title = 'Validate locally installed copy';
          }
        }
      }
    }

    function showDetailError(skillName, msg) {
      const box = document.getElementById('sfdb-' + skillName);
      if (box) {
        box.innerHTML = '<div style="font-size:11px;color:var(--vscode-errorForeground,#f14c4c)">Error: ' + esc(msg) + '</div>';
      }
    }

    function installSkill(skillName, btn) {
      btn.disabled = true; btn.textContent = 'Installing…';
      vscode.postMessage({ type: 'installSkill', skillName });
    }

    function handleInstallResult(data) {
      const btn = document.querySelector('.sf-btn-install[data-skill="' + data.skillName + '"]');
      if (btn) {
        btn.disabled = false;
        if (data.success) {
          installedSet.add(data.skillName);
          btn.classList.add('installed');
          btn.textContent = 'Reinstall';
          // Enable the Check button — while disabled, Electron routes clicks to the parent TD,
          // bypassing the row-click guard and accidentally toggling the detail chevron.
          const checkBtn = document.querySelector('.sf-btn-check[data-skill="' + data.skillName + '"]');
          if (checkBtn) {
            checkBtn.disabled = false;
            checkBtn.title = 'Validate locally installed copy';
          }
          const main = document.querySelector('.sf-skill-row[data-skill="' + data.skillName + '"]');
          if (main) {
            const bc = main.querySelectorAll('td')[3];
            if (!bc.querySelector('.sf-badge-ok')) {
              bc.insertAdjacentHTML('beforeend', '<span class="sf-badge sf-badge-ok">✓ installed</span>');
            }
          }
          if (detailCache[data.skillName]) { detailCache[data.skillName].isInstalled = true; }
          const box = document.getElementById('sfdb-' + data.skillName);
          if (box && !box.querySelector('.sf-installed-note')) {
            box.insertAdjacentHTML('beforeend', '<div class="sf-installed-note">✓ Installed in ' + esc(data.filePath) + '</div>');
          }
        } else {
          btn.textContent = 'Install';
          btn.title = data.message || 'Installation failed';
          btn.style.outline = '1px solid var(--vscode-errorForeground, #f14c4c)';
          setTimeout(() => { btn.style.outline = ''; btn.title = ''; }, 3000);
        }
      }
    }

    function bindDetailLinks(root) {
      root.querySelectorAll('a[data-url]').forEach(a => {
        a.addEventListener('click', e => {
          e.preventDefault();
          vscode.postMessage({ type: 'openGitHub', url: a.dataset.url });
        });
      });
    }

    function checkSkill(skillName, btn) {
      btn.disabled = true;
      btn.textContent = '… Check';
      vscode.postMessage({ type: 'checkSkill', skillName });
      const dr = document.getElementById('sfdr-' + skillName);
      if (dr && !dr.classList.contains('visible')) {
        toggleRow(skillName);
      }
    }

    function handleCheckResult(data) {
      checkCache[data.skillName] = { status: data.status, errors: data.errors, warnings: data.warnings };

      const btn = document.querySelector('.sf-btn-check[data-skill="' + data.skillName + '"]');
      if (btn) {
        btn.disabled = false;
        btn.className = 'sf-btn-check ' + data.status;
        const icon = data.status === 'ok' ? '✓' : data.status === 'warn' ? '⚠' : data.status === 'error' ? '✗' : '?';
        btn.textContent = icon + ' Check';
      }

      const box = document.getElementById('sfdb-' + data.skillName);
      if (box) {
        const old = box.querySelector('.sf-val-section');
        if (old) { old.remove(); }
        const div = document.createElement('div');
        div.className = 'sf-val-section';
        div.innerHTML = buildCheckHtml(data.skillName, data);
        box.appendChild(div);
      }
    }

    function buildCheckHtml(skillName, data) {
      let h = '<div style="margin-top:10px; border-top:1px solid var(--vscode-panel-border,#333); padding-top:8px">';
      h += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:6px">Validation</div>';
      if (!data || !data.status) {
        h += '</div>';
        return h;
      }
      if (data.status === 'ok') {
        h += '<span class="sf-val-badge sf-val-ok">✓ All checks passed</span>';
      } else if (data.status === 'not-installed') {
        h += '<span class="sf-val-badge sf-val-ns">— Not installed</span>';
      } else {
        const errCnt = data.errors ? data.errors.length : 0;
        const wrnCnt = data.warnings ? data.warnings.length : 0;
        if (errCnt) { h += '<span class="sf-val-badge sf-val-error">✗ ' + errCnt + ' error' + (errCnt !== 1 ? 's' : '') + '</span> '; }
        if (wrnCnt) { h += '<span class="sf-val-badge sf-val-warn">⚠ ' + wrnCnt + ' warning' + (wrnCnt !== 1 ? 's' : '') + '</span>'; }
        if (data.errors && data.errors.length) {
          h += '<div class="sf-val-issues">';
          for (const e of data.errors) { h += '<div class="sf-val-issue-e">' + esc(e) + '</div>'; }
          h += '</div>';
        }
        if (data.warnings && data.warnings.length) {
          h += '<div class="sf-val-issues">';
          for (const w of data.warnings) { h += '<div class="sf-val-issue-w">' + esc(w) + '</div>'; }
          h += '</div>';
        }
      }
      h += '</div>';
      return h;
    }

    // Kick off
    vscode.postMessage({ type: 'getSkillsList' });
  </script>
</body>
</html>`;
	}
}

// ---------------------------------------------------------------------------
// SkillValidationReportPanel — editor-area panel showing validation results
// ---------------------------------------------------------------------------

interface SkillReportEntry {
	skillName: string;
	paths: string[];
	errors: string[];
	warnings: string[];
	status: 'pending' | 'checking' | 'ok' | 'warn' | 'error' | 'not-installed';
}

class SkillValidationReportPanel {
	public static currentPanel: SkillValidationReportPanel | undefined;
	private static readonly viewType = 'skillValidationReport';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _workspaceRoot: string | undefined;
	private readonly _disposables: vscode.Disposable[] = [];
	private _ready = false;
	private _readyResolvers: Array<() => void> = [];

	private _waitForReady(): Promise<void> {
		if (this._ready) { return Promise.resolve(); }
		return new Promise(resolve => { this._readyResolvers.push(resolve); });
	}

	private _setReady() {
		this._ready = true;
		for (const r of this._readyResolvers) { r(); }
		this._readyResolvers = [];
	}

	public static createOrShow(workspaceRoot?: string): SkillValidationReportPanel {
		if (SkillValidationReportPanel.currentPanel) {
			SkillValidationReportPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
			return SkillValidationReportPanel.currentPanel;
		}
		const panel = vscode.window.createWebviewPanel(
			SkillValidationReportPanel.viewType,
			'Skill Validation Report',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		SkillValidationReportPanel.currentPanel = new SkillValidationReportPanel(panel, workspaceRoot);
		return SkillValidationReportPanel.currentPanel;
	}

	private constructor(panel: vscode.WebviewPanel, workspaceRoot?: string) {
		this._panel = panel;
		this._workspaceRoot = workspaceRoot;
		this._panel.webview.html = this._getHtml();
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case 'ready':
					this._setReady();
					break;
				case 'recheck':
					await this._checkOneSkill(msg.skillName as string);
					break;
				case 'recheckAll':
					await this._recheckAll(msg.skillNames as string[]);
					break;
				case 'openFile':
					try { await vscode.window.showTextDocument(vscode.Uri.file(msg.path as string)); } catch { /* ignore */ }
					break;
			}
		}, null, this._disposables);
	}

	/** Validate a single skill and push the result to the webview. */
	public async checkSkill(skillName: string): Promise<void> {
		this._panel.reveal(vscode.ViewColumn.One);
		await this._waitForReady();
		await this._checkOneSkill(skillName);
	}

	/** Validate all skills in `skillNames` in sequence. */
	public async checkSkills(skillNames: string[]): Promise<void> {
		this._panel.reveal(vscode.ViewColumn.One);
		await this._waitForReady();
		this._panel.webview.postMessage({ type: 'batchStart', total: skillNames.length });
		for (const name of skillNames) {
			await this._checkOneSkill(name);
		}
		this._panel.webview.postMessage({ type: 'batchDone' });
	}

	private async _checkOneSkill(skillName: string): Promise<void> {
		await this._waitForReady();
		this._panel.webview.postMessage({ type: 'checking', skillName });
		const paths = findInstalledSkillPaths(skillName, this._workspaceRoot);

		if (paths.length === 0) {
			this._panel.webview.postMessage({
				type: 'checkResult', skillName, paths: [], status: 'not-installed',
				errors: [`${skillName}: no installed copy found`], warnings: [],
			});
			return;
		}

		// Validate all installed copies (usually just one)
		const allErrors: string[] = [];
		const allWarnings: string[] = [];
		for (const p of paths) {
			const r = validateSkillLocal(skillName, p);
			allErrors.push(...r.errors);
			allWarnings.push(...r.warnings);
		}

		const status = allErrors.length > 0 ? 'error' : allWarnings.length > 0 ? 'warn' : 'ok';
		this._panel.webview.postMessage({
			type: 'checkResult', skillName, paths,
			status, errors: allErrors, warnings: allWarnings,
		});
	}

	private async _recheckAll(skillNames: string[]): Promise<void> {
		this._panel.webview.postMessage({ type: 'batchStart', total: skillNames.length });
		for (const name of skillNames) {
			await this._checkOneSkill(name);
		}
		this._panel.webview.postMessage({ type: 'batchDone' });
	}

	public dispose() {
		SkillValidationReportPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) { this._disposables.pop()?.dispose(); }
	}

	private _getHtml(): string {
		const nonce = getNonce();
		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0 28px 48px 28px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    /* ── header ────────────────────────────────────────────── */
    .vr-header {
      padding: 20px 0 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      margin-bottom: 14px;
      display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    }
    .vr-title { margin: 0; font-size: 17px; font-weight: 700; }
    .vr-subtitle { font-size: 12px; color: var(--vscode-descriptionForeground); }
    /* ── toolbar ───────────────────────────────────────────── */
    .vr-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 12px; }
    .vr-btn {
      font-size: 12px; font-weight: 600; padding: 4px 12px;
      border-radius: 3px; cursor: pointer; border: 1px solid transparent;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .vr-btn:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    .vr-btn:disabled { opacity: .55; cursor: not-allowed; }
    .vr-btn-sec {
      font-size: 12px; font-weight: 600; padding: 4px 12px;
      border-radius: 3px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      background: transparent; color: var(--vscode-foreground);
    }
    .vr-btn-sec:hover { background: var(--vscode-list-hoverBackground); }
    .vr-spacer { flex: 1; }
    /* ── summary bar ───────────────────────────────────────── */
    .vr-summary {
      display: flex; gap: 18px; font-size: 12px;
      padding: 8px 14px; margin-bottom: 14px;
      background: var(--vscode-sideBar-background, rgba(0,0,0,.12));
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
    }
    .vr-sum-ok    { color: #4ec9b0; font-weight: 700; }
    .vr-sum-warn  { color: #f0c040; font-weight: 700; }
    .vr-sum-error { color: #f14c4c; font-weight: 700; }
    .vr-sum-ns    { color: var(--vscode-descriptionForeground); font-weight: 700; }
    /* ── table ─────────────────────────────────────────────── */
    .vr-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    .vr-table thead th {
      text-align: left; font-size: 11px; font-weight: 700;
      text-transform: uppercase; letter-spacing: .06em;
      color: var(--vscode-descriptionForeground);
      padding: 6px 8px; border-bottom: 2px solid var(--vscode-panel-border, #333);
    }
    .vr-row { border-bottom: 1px solid var(--vscode-panel-border, #2a2a2a); cursor: pointer; }
    .vr-row:hover > td { background: var(--vscode-list-hoverBackground); }
    .vr-row td { padding: 7px 8px; vertical-align: middle; overflow: hidden; }
    .vr-arrow { font-size: 9px; width: 16px; display: inline-block; transition: transform .15s; }
    .vr-arrow.open { transform: rotate(90deg); }
    .vr-status {
      display: inline-flex; align-items: center; justify-content: center;
      width: 20px; height: 20px; border-radius: 50%; font-size: 11px; font-weight: 700;
    }
    .vr-status.ok    { background: rgba(78,201,176,.2);  color: #4ec9b0; }
    .vr-status.warn  { background: rgba(240,192,64,.2);  color: #f0c040; }
    .vr-status.error { background: rgba(241,76,76,.18);  color: #f14c4c; }
    .vr-status.ns    { background: rgba(128,128,128,.18);color: var(--vscode-descriptionForeground); }
    .vr-status.spin  { background: transparent; animation: vrspin 1s linear infinite; }
    @keyframes vrspin { to { transform: rotate(360deg); } }
    .vr-skill-name { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; font-weight: 600; }
    .vr-cnt-error { color: #f14c4c; font-weight: 700; }
    .vr-cnt-warn  { color: #f0c040; font-weight: 700; }
    .vr-cnt-ok    { color: #4ec9b0; font-weight: 700; }
    .vr-path { font-size: 11px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-editor-font-family, monospace); }
    .vr-recheck-btn {
      font-size: 11px; padding: 2px 8px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--vscode-panel-border, #3c3c3c);
      background: transparent; color: var(--vscode-foreground);
      white-space: nowrap;
    }
    .vr-recheck-btn:hover { background: var(--vscode-list-hoverBackground); }
    /* ── detail rows ───────────────────────────────────────── */
    .vr-detail-row { display: none; }
    .vr-detail-row.visible { display: table-row; }
    .vr-detail-row > td { padding: 0 8px 14px 44px; }
    .vr-detail-box {
      padding: 10px 14px;
      background: var(--vscode-sideBar-background, rgba(0,0,0,.12));
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
      font-size: 12px;
    }
    .vr-issue-list { list-style: none; margin: 0; padding: 0; }
    .vr-issue-list li { padding: 3px 0 3px 20px; position: relative; line-height: 1.5; }
    .vr-issue-list li::before { position: absolute; left: 0; }
    .vr-issue-error::before { content: '✗'; color: #f14c4c; }
    .vr-issue-warn::before  { content: '⚠'; color: #f0c040; }
    .vr-section-hdr { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--vscode-descriptionForeground); margin: 8px 0 4px 0; }
    .vr-path-link { color: var(--vscode-textLink-foreground); text-decoration: none; cursor: pointer; font-family: var(--vscode-editor-font-family, monospace); font-size: 11px; }
    .vr-path-link:hover { text-decoration: underline; }
    .vr-ok-msg { color: #4ec9b0; }
    /* ── empty state ───────────────────────────────────────── */
    .vr-empty {
      padding: 60px 0; text-align: center;
      color: var(--vscode-descriptionForeground); font-size: 13px;
    }
    .vr-progress { font-size: 12px; color: var(--vscode-descriptionForeground); margin-left: 8px; }
  </style>
</head>
<body>
  <div class="vr-header">
    <h1 class="vr-title">🔍 Skill Validation Report</h1>
    <span class="vr-subtitle" id="vrSubtitle">Check locally installed skills against the spec</span>
  </div>

  <div class="vr-toolbar">
    <button class="vr-btn" id="vrRecheckAll" disabled title="Re-run all validated skills">↺ Re-run All</button>
    <button class="vr-btn-sec" id="vrClear" title="Clear results">Clear</button>
    <span class="vr-spacer"></span>
    <span class="vr-progress" id="vrProgress"></span>
  </div>

  <div class="vr-summary" id="vrSummary" style="display:none">
    <span class="vr-sum-ok"   id="sumOk">0 ok</span>
    <span class="vr-sum-warn" id="sumWarn">0 warn</span>
    <span class="vr-sum-error"id="sumError">0 error</span>
    <span class="vr-sum-ns"   id="sumNs">0 not installed</span>
  </div>

  <div id="vrContent">
    <div class="vr-empty">
      No results yet. Use the <strong>Check</strong> button on a skill in the
      Salesforce Skills Library, or click the ✓ Validate All button in the toolbar there.
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    // keyed by skillName
    const results = {};

    document.getElementById('vrRecheckAll').addEventListener('click', () => {
      const names = Object.keys(results);
      if (!names.length) { return; }
      vscode.postMessage({ type: 'recheckAll', skillNames: names });
    });

    document.getElementById('vrClear').addEventListener('click', () => {
      for (const k of Object.keys(results)) { delete results[k]; }
      renderAll();
    });

    window.addEventListener('message', ({ data }) => {
      switch (data.type) {
        case 'checking':
          results[data.skillName] = { skillName: data.skillName, status: 'checking', paths: [], errors: [], warnings: [] };
          renderAll();
          break;
        case 'checkResult':
          results[data.skillName] = { skillName: data.skillName, status: data.status, paths: data.paths, errors: data.errors, warnings: data.warnings };
          renderAll();
          break;
        case 'batchStart':
          document.getElementById('vrProgress').textContent = 'Validating 0 / ' + data.total + '…';
          break;
        case 'batchDone':
          document.getElementById('vrProgress').textContent = '';
          break;
      }
    });

    function escHtml(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function renderAll() {
      const entries = Object.values(results);
      if (!entries.length) {
        document.getElementById('vrContent').innerHTML = '<div class="vr-empty">No results yet.</div>';
        document.getElementById('vrSummary').style.display = 'none';
        document.getElementById('vrRecheckAll').disabled = true;
        return;
      }

      let okCnt = 0, warnCnt = 0, errCnt = 0, nsCnt = 0;
      for (const e of entries) {
        if (e.status === 'ok') okCnt++;
        else if (e.status === 'warn') warnCnt++;
        else if (e.status === 'error') errCnt++;
        else if (e.status === 'not-installed') nsCnt++;
      }
      document.getElementById('sumOk').textContent    = okCnt + ' ok';
      document.getElementById('sumWarn').textContent  = warnCnt + ' warning' + (warnCnt !== 1 ? 's' : '');
      document.getElementById('sumError').textContent = errCnt + ' error' + (errCnt !== 1 ? 's' : '');
      document.getElementById('sumNs').textContent    = nsCnt + ' not installed';
      document.getElementById('vrSummary').style.display = '';
      document.getElementById('vrRecheckAll').disabled = false;

      let html = '<table class="vr-table"><thead><tr>';
      html += '<th style="width:20px"></th>';
      html += '<th style="width:24px">Status</th>';
      html += '<th>Skill</th>';
      html += '<th style="width:80px;text-align:center">Errors</th>';
      html += '<th style="width:80px;text-align:center">Warnings</th>';
      html += '<th style="width:90px;text-align:right">Actions</th>';
      html += '</tr></thead><tbody>';

      for (const e of entries) {
        const statusHtml = statusIcon(e.status);
        html += '<tr class="vr-row" data-skill="' + escHtml(e.skillName) + '">';
        html += '<td><span class="vr-arrow">▶</span></td>';
        html += '<td>' + statusHtml + '</td>';
        html += '<td><span class="vr-skill-name">' + escHtml(e.skillName) + '</span></td>';
        html += '<td style="text-align:center"><span class="' + (e.errors.length ? 'vr-cnt-error' : 'vr-cnt-ok') + '">' + e.errors.length + '</span></td>';
        html += '<td style="text-align:center"><span class="' + (e.warnings.length ? 'vr-cnt-warn' : 'vr-cnt-ok') + '">' + e.warnings.length + '</span></td>';
        html += '<td style="text-align:right"><button class="vr-recheck-btn" data-skill="' + escHtml(e.skillName) + '">↺ Re-run</button></td>';
        html += '</tr>';

        html += '<tr class="vr-detail-row" id="vrdr-' + escHtml(e.skillName) + '">';
        html += '<td colspan="6">' + buildDetailHtml(e) + '</td>';
        html += '</tr>';
      }
      html += '</tbody></table>';

      const cnt = document.getElementById('vrContent');
      cnt.innerHTML = html;

      cnt.querySelectorAll('.vr-row').forEach(row => {
        row.addEventListener('click', e => {
          if (e.target.closest('.vr-recheck-btn')) { return; }
          toggleRow(row.dataset.skill);
        });
      });
      cnt.querySelectorAll('.vr-recheck-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
          ev.stopPropagation();
          vscode.postMessage({ type: 'recheck', skillName: btn.dataset.skill });
        });
      });
      cnt.querySelectorAll('.vr-path-link').forEach(a => {
        a.addEventListener('click', ev => {
          ev.preventDefault();
          vscode.postMessage({ type: 'openFile', path: a.dataset.path });
        });
      });
    }

    function statusIcon(status) {
      if (status === 'checking')      return '<span class="vr-status spin">↻</span>';
      if (status === 'ok')            return '<span class="vr-status ok">✓</span>';
      if (status === 'warn')          return '<span class="vr-status warn">⚠</span>';
      if (status === 'error')         return '<span class="vr-status error">✗</span>';
      if (status === 'not-installed') return '<span class="vr-status ns">—</span>';
      return '<span class="vr-status ns">?</span>';
    }

    function buildDetailHtml(e) {
      let h = '<div class="vr-detail-box">';

      if (e.paths && e.paths.length) {
        h += '<div class="vr-section-hdr">Installed at</div>';
        h += '<ul class="vr-issue-list">';
        for (const p of e.paths) {
          h += '<li><a class="vr-path-link" href="#" data-path="' + escHtml(p + '/SKILL.md') + '">' + escHtml(p + '/SKILL.md') + '</a></li>';
        }
        h += '</ul>';
      }

      if (e.errors && e.errors.length) {
        h += '<div class="vr-section-hdr">Errors</div>';
        h += '<ul class="vr-issue-list">';
        for (const err of e.errors) {
          h += '<li class="vr-issue-error">' + escHtml(err) + '</li>';
        }
        h += '</ul>';
      }

      if (e.warnings && e.warnings.length) {
        h += '<div class="vr-section-hdr">Warnings</div>';
        h += '<ul class="vr-issue-list">';
        for (const w of e.warnings) {
          h += '<li class="vr-issue-warn">' + escHtml(w) + '</li>';
        }
        h += '</ul>';
      }

      if (e.status === 'ok') {
        h += '<div class="vr-ok-msg">✓ All checks passed.</div>';
      } else if (e.status === 'checking') {
        h += '<div style="color:var(--vscode-descriptionForeground)">Validating…</div>';
      } else if (e.status === 'not-installed') {
        h += '<div style="color:var(--vscode-descriptionForeground)">Skill is not installed locally.</div>';
      }

      h += '</div>';
      return h;
    }

    function toggleRow(skillName) {
      const dr = document.getElementById('vrdr-' + skillName);
      if (!dr) { return; }
      const mr = document.querySelector('.vr-row[data-skill="' + skillName + '"]');
      const arrow = mr.querySelector('.vr-arrow');
      if (dr.classList.contains('visible')) {
        dr.classList.remove('visible');
        arrow.classList.remove('open');
      } else {
        dr.classList.add('visible');
        arrow.classList.add('open');
      }
    }

    // Signal host that the webview is ready to receive messages
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
	}
}

// ---------------------------------------------------------------------------
// SummaryPanel — editor-area panel summarising all installed Copilot files
// ---------------------------------------------------------------------------

export function getCheckDescription(check: CheckResult): string {
	const id = check.id;
	if (id === 'github-instructions')    { return 'Primary workspace instructions for GitHub Copilot. Applied automatically to every Copilot conversation in this repository.'; }
	if (id === 'root-instructions')      { return 'Root-level Copilot instructions. Alternative location — .github/copilot-instructions.md takes precedence when both exist.'; }
	if (id.startsWith('instr-'))         { return 'Scoped instructions file. Activated for files matching the applyTo glob pattern defined in its YAML frontmatter.'; }
	if (id === 'no-instructions-files')  { return 'No scoped instruction files found in the workspace.'; }
	if (id.startsWith('skill-personal-')){ return 'Personal skill (SKILL.md) stored in your user profile. Loaded by Copilot when context matches the skill description — available in every workspace.'; }
	if (id.startsWith('skill-'))         { return 'Workspace skill (SKILL.md). Copilot loads it automatically when the session context matches the skill description.'; }
	if (id === 'no-skill-files')         { return 'No workspace skills found in .github/skills/, .claude/skills/, or .agents/skills/.'; }
	if (id.startsWith('prompt-'))        { return 'Reusable prompt template. Invoke it as a slash command in Copilot Chat.'; }
	if (id === 'no-prompt-files')        { return 'No prompt templates found in the workspace.'; }
	if (id.startsWith('agent-'))         { return 'Custom Copilot agent. Defines a named assistant with specific tools and a system prompt.'; }
	if (id === 'agents-md')              { return check.status === 'ok' ? 'Agent registry documenting all custom agents in this repository.' : 'Optional agent registry — not present.'; }
	if (id === 'no-agent-files')         { return 'No custom agent files found in the workspace.'; }
	if (id.startsWith('copilot-hook-')) {
		const n = check.name;
		if (n === 'settings.json' || n === 'settings.local.json') {
			return 'Claude Code settings. The hooks key defines lifecycle hooks applied to every Claude Code session in this workspace.';
		}
		return 'Copilot lifecycle hook file. PreToolUse hooks can approve or block tool calls; other events (SessionStart, Stop, …) are observational only.';
	}
	if (id === 'no-copilot-hooks')      { return 'No lifecycle hooks configured in this workspace.'; }
	if (id === 'copilot-ext')            { return 'GitHub Copilot extension — provides AI-powered inline code completions directly in the editor.'; }
	if (id === 'copilot-chat-ext')       { return 'GitHub Copilot Chat extension — provides the chat panel, agent mode, and slash commands.'; }
	if (id === 'workspace-settings' || id === 'no-workspace-settings') {
		return 'Workspace settings file (.vscode/settings.json). Controls Copilot behaviour for this workspace.';
	}
	return '';
}

class SummaryPanel {
	public static currentPanel: SummaryPanel | undefined;
	private static readonly viewType = 'copilotSummary';

	private readonly _panel: vscode.WebviewPanel;
	private readonly _disposables: vscode.Disposable[] = [];

	public static createOrShow(checks: CheckResult[], workspaceRoot?: string): void {
		if (SummaryPanel.currentPanel) {
			SummaryPanel.currentPanel._panel.reveal(vscode.ViewColumn.One);
			SummaryPanel.currentPanel._refresh(checks, workspaceRoot);
			return;
		}
		const panel = vscode.window.createWebviewPanel(
			SummaryPanel.viewType,
			'Copilot Summary',
			vscode.ViewColumn.One,
			{ enableScripts: true, retainContextWhenHidden: true },
		);
		SummaryPanel.currentPanel = new SummaryPanel(panel, checks, workspaceRoot);
	}

	private constructor(panel: vscode.WebviewPanel, checks: CheckResult[], workspaceRoot?: string) {
		this._panel = panel;
		this._panel.webview.html = this._getHtml(checks, workspaceRoot);
		this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
		this._panel.webview.onDidReceiveMessage(async (msg) => {
			if (msg.type !== 'exportHtml') { return; }
			const defaultUri = vscode.Uri.file(
				path.join(workspaceRoot ?? os.homedir(), 'copilot-summary.html')
			);
			const uri = await vscode.window.showSaveDialog({
				defaultUri,
				filters: { 'HTML files': ['html'] },
				title: 'Export Copilot Summary',
			});
			if (!uri) { return; }
			try {
				fs.writeFileSync(uri.fsPath, msg.content as string, 'utf8');
				const action = await vscode.window.showInformationMessage(
					`Summary exported to ${path.basename(uri.fsPath)}`, 'Open in Browser'
				);
				if (action === 'Open in Browser') {
					await vscode.env.openExternal(uri);
				}
			} catch (e) {
				vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
			}
		}, null, this._disposables);
	}

	private _refresh(checks: CheckResult[], workspaceRoot?: string): void {
		this._panel.webview.html = this._getHtml(checks, workspaceRoot);
	}

	public dispose(): void {
		SummaryPanel.currentPanel = undefined;
		this._panel.dispose();
		while (this._disposables.length) { this._disposables.pop()?.dispose(); }
	}

	private _getHtml(checks: CheckResult[], workspaceRoot?: string): string {
		const nonce = getNonce();
		const wsName  = workspaceRoot ? path.basename(workspaceRoot) : '(no workspace)';
		const genDate = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

		// Build the enriched data set once on the host side (with descriptions)
		const enriched = checks.map(c => ({
			...c,
			description: getCheckDescription(c),
		}));
		const mcpFiles = checkMcpConfig(workspaceRoot);
		const dataJson = JSON.stringify({ checks: enriched, wsName, genDate, mcpFiles })
			.replace(/<\/script>/gi, '<\\/script>');

		return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0; padding: 0 28px 56px 28px;
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    /* header */
    .sm-header {
      padding: 20px 0 14px 0;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
      margin-bottom: 16px;
      display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
    }
    .sm-title  { margin: 0; font-size: 17px; font-weight: 700; }
    .sm-meta   { font-size: 12px; color: var(--vscode-descriptionForeground); }
    /* toolbar */
    .sm-toolbar { display: flex; gap: 8px; align-items: center; margin-bottom: 16px; }
    .sm-btn {
      font-size: 12px; font-weight: 600; padding: 4px 14px;
      border-radius: 3px; cursor: pointer; border: 1px solid transparent;
      background: var(--vscode-button-background, #0078d4);
      color: var(--vscode-button-foreground, #fff);
    }
    .sm-btn:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
    /* stats bar */
    .sm-stats {
      display: flex; gap: 18px; flex-wrap: wrap;
      font-size: 12px; padding: 8px 14px; margin-bottom: 20px;
      background: var(--vscode-sideBar-background, rgba(0,0,0,.12));
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px;
    }
    .sm-stat-ok   { color: #4ec9b0; font-weight: 700; }
    .sm-stat-warn { color: #f0c040; font-weight: 700; }
    .sm-stat-miss { color: #f14c4c; font-weight: 700; }
    .sm-stat-info { color: var(--vscode-descriptionForeground); font-weight: 700; }
    /* category */
    .sm-cat-hdr {
      font-size: 11px; font-weight: 700; text-transform: uppercase;
      letter-spacing: .08em; margin: 20px 0 6px 0;
      padding-bottom: 4px;
      border-bottom: 1px solid var(--vscode-panel-border, #444);
      color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
      opacity: .85;
    }
    /* item rows */
    .sm-item {
      display: grid;
      grid-template-columns: 16px 1fr;
      gap: 0 8px;
      padding: 6px 4px;
      border-radius: 3px;
    }
    .sm-item:hover { background: var(--vscode-list-hoverBackground); }
    .sm-icon { font-size: 12px; margin-top: 1px; text-align: center; }
    .s-ok      { color: #4ec9b0; }
    .s-warn    { color: #f0c040; }
    .s-missing { color: #f14c4c; }
    .s-info    { color: var(--vscode-descriptionForeground); }
    .sm-body {}
    .sm-name {
      font-weight: 600; font-size: 12px;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sm-path {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      font-family: var(--vscode-editor-font-family, monospace);
      margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .sm-desc {
      font-size: 11px; color: var(--vscode-descriptionForeground);
      margin-top: 3px; line-height: 1.5;
    }
    .sm-scope {
      display: inline-block; font-size: 9px; font-weight: 700;
      padding: 1px 5px; border-radius: 3px;
      text-transform: uppercase; letter-spacing: .03em;
      vertical-align: middle; margin-left: 5px;
    }
    .sm-scope-ws   { background: rgba(0,122,204,.15); color: #4fc1ff; border: 1px solid rgba(0,122,204,.3); }
    .sm-scope-home { background: rgba(180,100,220,.15); color: #d7a0f7; border: 1px solid rgba(180,100,220,.3); }
    /* hidden-only items (info / missing with no path) */
    .sm-item.faded { opacity: .6; }
  </style>
</head>
<body>
  <div class="sm-header">
    <h1 class="sm-title">📋 Copilot Configuration Summary</h1>
    <span class="sm-meta" id="smMeta"></span>
  </div>

  <div class="sm-toolbar">
    <button class="sm-btn" id="btnExport">⬇ Export HTML</button>
  </div>

  <div class="sm-stats" id="smStats"></div>
  <div id="smContent"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const { checks, wsName, genDate, mcpFiles } = ${dataJson};

    const ICONS = { ok: '✓', warn: '⚠', missing: '✗', info: '·' };
    const ICON_CLS = { ok: 's-ok', warn: 's-warn', missing: 's-missing', info: 's-info' };

    function esc(s) {
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── stats ──────────────────────────────────────────────
    function renderStats() {
      const ok   = checks.filter(c => c.status === 'ok').length;
      const warn = checks.filter(c => c.status === 'warn').length;
      const miss = checks.filter(c => c.status === 'missing').length;
      const info = checks.filter(c => c.status === 'info').length;
      const total = checks.filter(c => c.path).length;
      document.getElementById('smStats').innerHTML =
        '<span class="sm-stat-ok">'   + ok   + ' ok</span>' +
        (warn ? '<span class="sm-stat-warn">' + warn + ' warning'  + (warn !== 1 ? 's' : '') + '</span>' : '') +
        (miss ? '<span class="sm-stat-miss">' + miss + ' missing'  + (miss !== 1 ? '' : '')   + '</span>' : '') +
        '<span class="sm-stat-info">' + info + ' info</span>' +
        '<span style="color:var(--vscode-descriptionForeground)">' + total + ' files tracked</span>';
      document.getElementById('smMeta').textContent =
        'Workspace: ' + wsName + '  ·  Generated: ' + genDate;
    }

    // ── MCP section helper ─────────────────────────────────
    function renderMcpSection() {
      if (!mcpFiles || mcpFiles.length === 0) { return ''; }
      let html = '<div class="sm-cat-hdr">MCP Configuration <span style="font-weight:400;opacity:.7">(' + mcpFiles.length + ')</span></div>';
      for (const f of mcpFiles) {
        const status = !f.exists ? 'info' : f.hasSalesforceMcp ? 'ok' : 'warn';
        const icon   = !f.exists ? '·'    : f.hasSalesforceMcp ? '✓'  : '○';
        const iconCls = status === 'ok' ? 's-ok' : status === 'warn' ? 's-warn' : 's-info';
        const scopeBadge = f.scope === 'personal'
          ? '<span class="sm-scope sm-scope-home">personal</span>'
          : '<span class="sm-scope sm-scope-ws">workspace</span>';
        const faded = !f.exists ? ' faded' : '';
        html += '<div class="sm-item' + faded + '">';
        html += '<span class="sm-icon ' + iconCls + '">' + icon + '</span>';
        html += '<div class="sm-body">';
        html += '<div class="sm-name">' + esc(f.relPath) + scopeBadge + '</div>';
        if (f.exists) { html += '<div class="sm-path">' + esc(f.fullPath) + '</div>'; }
        if (!f.exists) {
          html += '<div class="sm-desc">not found</div>';
        } else if (!f.hasSalesforceMcp) {
          html += '<div class="sm-desc">file exists — @salesforce/mcp not configured</div>';
        } else {
          for (const srv of f.servers) {
            let detail = 'server: <strong>' + esc(srv.name) + '</strong>';
            if (srv.orgs.length)     { detail += ' · orgs: '     + esc(srv.orgs.join(', ')); }
            if (srv.toolsets.length) { detail += ' · toolsets: ' + esc(srv.toolsets.join(', ')); }
            else                     { detail += ' · toolsets: all'; }
            if (srv.tools && srv.tools.length) { detail += ' · tools: ' + esc(srv.tools.join(', ')); }
            if (srv.allowNonGa) { detail += ' · <em>--allow-non-ga-tools</em>'; }
            html += '<div class="sm-desc">' + detail + '</div>';
          }
        }
        html += '</div></div>';
      }
      return html;
    }

    // ── main render ────────────────────────────────────────
    function renderContent() {
      const order = [], cats = {};
      for (const c of checks) {
        if (!cats[c.category]) { order.push(c.category); cats[c.category] = []; }
        cats[c.category].push(c);
      }
      let html = '';
      for (const cat of order) {
        const items = cats[cat];
        html += '<div class="sm-cat-hdr">' + esc(cat) + ' <span style="font-weight:400;opacity:.7">(' + items.length + ')</span></div>';
        for (const c of items) {
          const faded = !c.path && (c.status === 'info' || c.status === 'missing') ? ' faded' : '';
          const scopeBadge = c.scope === 'personal'
            ? '<span class="sm-scope sm-scope-home">personal</span>'
            : c.scope === 'workspace'
              ? '<span class="sm-scope sm-scope-ws">workspace</span>'
              : '';
          html += '<div class="sm-item' + faded + '">';
          html += '<span class="sm-icon ' + (ICON_CLS[c.status] || '') + '">' + (ICONS[c.status] || '·') + '</span>';
          html += '<div class="sm-body">';
          html += '<div class="sm-name">' + esc(c.name) + scopeBadge + '</div>';
          if (c.path) {
            html += '<div class="sm-path">' + esc(c.path) + '</div>';
          }
          if (c.description) {
            html += '<div class="sm-desc">' + esc(c.description) + '</div>';
          } else if (c.message) {
            html += '<div class="sm-desc">' + esc(c.message) + '</div>';
          }
          html += '</div></div>';
        }
      }
      html += renderMcpSection();
      document.getElementById('smContent').innerHTML = html;
    }

    // ── export ─────────────────────────────────────────────
    document.getElementById('btnExport').addEventListener('click', () => {
      vscode.postMessage({ type: 'exportHtml', content: buildExportHtml() });
    });

    function buildExportHtml() {
      const order = [], cats = {};
      for (const c of checks) {
        if (!cats[c.category]) { order.push(c.category); cats[c.category] = []; }
        cats[c.category].push(c);
      }
      const okCnt   = checks.filter(c => c.status === 'ok').length;
      const warnCnt = checks.filter(c => c.status === 'warn').length;
      const missCnt = checks.filter(c => c.status === 'missing').length;
      const infoCnt = checks.filter(c => c.status === 'info').length;
      const total   = checks.filter(c => c.path).length;

      let body = '';
      for (const cat of order) {
        body += '<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:#888;margin:28px 0 8px 0;padding-bottom:6px;border-bottom:1px solid #e0e0e0">' + esc(cat) + '</h2>';
        for (const c of cats[cat]) {
          const dot = c.status === 'ok' ? '#4ec9b0' : c.status === 'warn' ? '#f0c040' : c.status === 'missing' ? '#f14c4c' : '#888';
          const icon = c.status === 'ok' ? '✓' : c.status === 'warn' ? '⚠' : c.status === 'missing' ? '✗' : '·';
          const scopeLbl = c.scope === 'personal' ? ' <span style="font-size:10px;background:#e8d5f5;color:#7c3aed;padding:1px 6px;border-radius:3px;font-weight:700">personal</span>'
                         : c.scope === 'workspace' ? ' <span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:3px;font-weight:700">workspace</span>' : '';
          body += '<div style="margin-bottom:10px;padding:8px 12px;border:1px solid #e8e8e8;border-left:3px solid ' + dot + ';border-radius:4px">';
          body += '<div style="font-weight:600;font-size:13px"><span style="color:' + dot + '">' + icon + '</span> ' + esc(c.name) + scopeLbl + '</div>';
          if (c.path) { body += '<div style="font-size:11px;color:#666;font-family:monospace;margin-top:3px">' + esc(c.path) + '</div>'; }
          const explain = c.description || c.message || '';
          if (explain) { body += '<div style="font-size:12px;color:#555;margin-top:5px;line-height:1.55">' + esc(explain) + '</div>'; }
          body += '</div>';
        }
      }

      // MCP section in export
      if (mcpFiles && mcpFiles.length > 0) {
        body += '<h2 style="font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:#888;margin:28px 0 8px 0;padding-bottom:6px;border-bottom:1px solid #e0e0e0">MCP Configuration</h2>';
        for (const f of mcpFiles) {
          const dot  = !f.exists ? '#aaa' : f.hasSalesforceMcp ? '#4ec9b0' : '#f0c040';
          const icon = !f.exists ? '·'    : f.hasSalesforceMcp ? '✓'       : '○';
          const scopeLbl = f.scope === 'personal'
            ? ' <span style="font-size:10px;background:#e8d5f5;color:#7c3aed;padding:1px 6px;border-radius:3px;font-weight:700">personal</span>'
            : ' <span style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:1px 6px;border-radius:3px;font-weight:700">workspace</span>';
          body += '<div style="margin-bottom:10px;padding:8px 12px;border:1px solid #e8e8e8;border-left:3px solid ' + dot + ';border-radius:4px' + (!f.exists ? ';opacity:.6' : '') + '">';
          body += '<div style="font-weight:600;font-size:13px"><span style="color:' + dot + '">' + icon + '</span> ' + esc(f.relPath) + scopeLbl + '</div>';
          if (f.exists) { body += '<div style="font-size:11px;color:#666;font-family:monospace;margin-top:3px">' + esc(f.fullPath) + '</div>'; }
          if (!f.exists) {
            body += '<div style="font-size:12px;color:#555;margin-top:5px">not found</div>';
          } else if (!f.hasSalesforceMcp) {
            body += '<div style="font-size:12px;color:#555;margin-top:5px">file exists — @salesforce/mcp not configured</div>';
          } else {
            for (const srv of f.servers) {
              let detail = 'server: <strong>' + esc(srv.name) + '</strong>';
              if (srv.orgs.length)     { detail += ' · orgs: '     + esc(srv.orgs.join(', ')); }
              if (srv.toolsets.length) { detail += ' · toolsets: ' + esc(srv.toolsets.join(', ')); }
              else                     { detail += ' · toolsets: all'; }
              if (srv.tools && srv.tools.length) { detail += ' · tools: ' + esc(srv.tools.join(', ')); }
              if (srv.allowNonGa) { detail += ' · <em>--allow-non-ga-tools</em>'; }
              body += '<div style="font-size:12px;color:#555;margin-top:5px;line-height:1.55">' + detail + '</div>';
            }
          }
          body += '</div>';
        }
      }

      return '<!DOCTYPE html>\\n<html lang="en">\\n<head>\\n' +
        '<meta charset="UTF-8">\\n' +
        '<meta name="viewport" content="width=device-width,initial-scale=1">\\n' +
        '<title>Copilot Configuration Summary — ' + esc(wsName) + '</title>\\n' +
        '<style>body{margin:0;padding:32px 40px 60px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;max-width:860px}' +
        'h1{font-size:22px;margin:0 0 4px 0}' +
        '.meta{font-size:12px;color:#888;margin-bottom:20px}' +
        '.stats{display:flex;gap:20px;font-size:13px;padding:10px 16px;background:#f5f5f5;border-radius:6px;margin-bottom:24px;flex-wrap:wrap}' +
        '</style>\\n</head>\\n<body>\\n' +
        '<h1>&#128203; Copilot Configuration Summary</h1>\\n' +
        '<div class="meta">Workspace: <strong>' + esc(wsName) + '</strong> &nbsp;·&nbsp; Generated: ' + esc(genDate) + '</div>\\n' +
        '<div class="stats">' +
          '<span style="color:#059669;font-weight:700">' + okCnt + ' ok</span>' +
          (warnCnt ? '<span style="color:#d97706;font-weight:700">' + warnCnt + ' warning' + (warnCnt !== 1 ? 's' : '') + '</span>' : '') +
          (missCnt ? '<span style="color:#dc2626;font-weight:700">' + missCnt + ' missing</span>' : '') +
          '<span style="color:#888;font-weight:700">' + infoCnt + ' info</span>' +
          '<span style="color:#888">' + total + ' files tracked</span>' +
        '</div>\\n' +
        body +
        '\\n</body>\\n</html>';
    }

    renderStats();
    renderContent();
  </script>
</body>
</html>`;
	}
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext) {
	const provider = new CopilotChecksViewProvider(context.extensionUri);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			CopilotChecksViewProvider.viewType,
			provider,
		),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('salesforce-copilot-inspector.refresh', () => {
			provider.refresh();
		}),
	);

	// Dispose editor panels when the extension deactivates
	context.subscriptions.push({
		dispose: () => SfSkillsPanel.currentPanel?.dispose(),
	});
	context.subscriptions.push({
		dispose: () => SummaryPanel.currentPanel?.dispose(),
	});
	// Kill any "Run Server" test instances when the extension deactivates.
	context.subscriptions.push({
		dispose: () => provider.disposeRunningServers(),
	});
}

export function deactivate() {}

