# Change Log

All notable changes to the "salesforce-github-copilot" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [0.3.1]

- Renamed the extension to **Salesforce Copilot Inspector** (display name and
  Activity Bar / view titles).
- Fixed blurred screenshots in the README by removing the forced `width`/`height`
  attributes so images render without fractional downscaling.

## [0.3.0]

- MCP tab: **Run Server** launches a configured `@salesforce/mcp` server as a
  long-lived test instance and confirms it via the MCP initialize handshake. A
  status badge shows `Not running` / `Starting…` / `Running` / `Error` /
  `Stopped`, and the button toggles between **Run Server** and **Stop Server**.
- MCP tab: collapsible **Server log** panel per server row — auto-expands on
  failure (showing the exact stderr, e.g. invalid `--tools` names), and streams
  stdout/stderr live while the server is running. The same output is mirrored to
  the **"Salesforce MCP — Run Server"** output channel.
- Manually-launched servers are terminated when the extension deactivates.
- Fixed stale Code Analyzer tool names in the built-in catalog
  (`create-custom-rule` → `create_custom_rule`,
  `generate_xpath_prompt` → `get_ast_nodes_to_generate_xpath`).

## [0.2.0]

- MCP tab: **⟳ from server** reads the live toolset list, tools and GA/non-GA
  status from your installed `@salesforce/mcp` server over the MCP stdio
  protocol, falling back to the built-in catalog when discovery is unavailable.
  A source indicator shows whether the built-in or live list is active.
- Fixed non-GA tool descriptions not rendering in the MCP tab.

## [0.1.0]

- Initial release