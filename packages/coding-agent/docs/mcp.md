# MCP Servers

Pi connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or streamable HTTP and makes their tools available to the model.

## Configure servers

Add servers to `~/.pi/agent/mcp.json`, or to `.pi/mcp.json` in a project. The format matches other MCP clients, so existing `mcpServers` entries can be copied over:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "exposure": "direct"
    }
  }
}
```

- stdio servers take `command`, `args`, `env`, and `cwd`. Relative `cwd` resolves against the session directory.
- HTTP servers take `url`, `headers`, and `oauth` (see [Sign in with OAuth](#sign-in-with-oauth)). The legacy SSE transport is not supported.
- `env` and `headers` values can reference environment variables (`${NAME}`) or commands (`!command`), like provider API keys.
- `timeout` sets the per-request timeout in seconds (default 60). Progress notifications from the server reset it.
- `enabled: false` keeps an entry without connecting to it.

Project entries replace global entries with the same name. A project `mcp.json` is only read after the project is trusted, because stdio servers run commands.

Pi connects when a session starts. The first prompt waits until startup connections finish. HTTP connections that fail with a network error or a transient status (408, 429, 5xx) are retried twice. A server that drops its connection shows as disconnected and is reconnected on the next call. When a server announces that its tool list changed, new tools are added and withdrawn tools become unreachable until the server offers them again. Run `/mcp` to see server status, tool counts, and errors.

Stopping a stdio server closes its stdin, then sends SIGTERM and finally SIGKILL to its whole process group, so servers started through wrappers such as `npx` or `uvx` do not linger.

## Sign in with OAuth

Remote servers that use OAuth, such as Sentry, need no credentials in `mcp.json`:

```json
{
  "mcpServers": {
    "sentry": { "url": "https://mcp.sentry.dev/mcp" }
  }
}
```

When such a server rejects the connection, `/mcp` shows it as needing sign-in. Run `/mcp login sentry` to open the authorization page in your browser. After you approve access, the browser redirects to a temporary server on `127.0.0.1` and pi connects. If the browser runs on another machine, for example over SSH, paste the URL it was redirected to into the prompt instead.

Pi registers itself with the authorization server (dynamic client registration), stores tokens in `~/.pi/agent/mcp-auth.json`, and refreshes access tokens automatically when they expire or the server rejects them. If the server later asks for more scope than was granted, it shows as needing sign-in again, and `/mcp login` requests the new scope. `/mcp logout sentry` deletes the stored credentials.

OAuth applies to HTTP servers without an `Authorization` header. For authorization servers that do not support dynamic client registration, configure a pre-registered client:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": { "clientId": "my-client", "clientSecret": "${EXAMPLE_SECRET}", "callbackPort": 8765 }
    }
  }
}
```

`callbackPort` fixes the redirect URI to `http://127.0.0.1:<port>/oauth/callback`, which must match the redirect URI registered for the client. `clientSecret` is optional and can reference environment variables or commands.

## Exposure

Each server's tools are registered as `mcp__<server>__<tool>`. The `exposure` setting controls how the model reaches them:

- `codemode` (default): the tools are callable from [`exec`](cli.md#tools) scripts and listed in the `exec` tool's description, but are not declared to the model. Large MCP tool lists stay out of the model's tool declarations, and scripts can call several MCP tools, in parallel if needed, while returning only the part of the result the model needs. Pi activates the `exec` tool when such a server connects.
- `deferred`: like `codemode`, but the tools are not listed in the `exec` tool's description either. Scripts can still call them by name and find them in `ALL_TOOLS`.
- `direct`: the tools are declared to the model like built-in tools, and are also callable from codemode.
- `hidden`: the tools are registered but cannot be called.

Codemode-only tools do not depend on the active tool set, so they stay callable after `/tree`, resume, and fork. To keep pi from activating the `exec` tool, set `"autoEnableCodemode": false` at the top level of `mcp.json`, next to `mcpServers`. A project `mcp.json` value overrides the global one. Pi then warns once that codemode-only tools cannot be called until `exec` is activated.

Like in Codex, `exec` scripts receive an MCP tool's whole `CallToolResult` (`content` blocks as sent by the server, `structuredContent`, and `isError`), and the `exec` description declares it as `CallToolResult<T>`. A result with `isError` resolves in scripts and is reported to the model as an error for direct calls. `image(result.content[0])` forwards an image block to the model. The server's `instructions` describe its tools in the `exec` description.

Every MCP call goes through pi's tool pipeline, so `tool_call` and `tool_result` extension handlers, including permission gates, apply to MCP tools. Calls made from `exec` scripts carry the `exec` call's id as `parentToolCallId`.
