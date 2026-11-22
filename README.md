# @flinbein/pappai-runner-codex

This external runner delivers [pappai](https://github.com/flinbein/pappai) events and method calls to the Codex CLI through `app-server`. A one-shot executor creates an ephemeral thread for a single assignment. A persistent executor processes turns sequentially in one thread and resumes it after a process restart.

## Installation

The runner requires a pappai controller that supports PROFILE nodes and administrator-supplied runner configuration, Linux x86_64 with working bubblewrap, Node.js 24.2+, and the native musl distribution of the Codex CLI. Compatibility tests use Codex `0.170.0`. Install the CLI separately on a persistent volume. Set `codexExecutablePath` to the executable itself.

1. Mount a persistent private volume at `/run/pappai/private`. Create `profiles` and `state` directories there, owned by the pappai process user with mode `0700`. Only the administrator should have write access to the runner code and CLI installation.
2. Install the package, for example with `npm install --prefix /run/pappai/private/runners --omit=dev @flinbein/pappai-runner-codex`.
3. Use `call` to invoke `$.runners.add` on the workspace (`node: "~"`) with the following arguments. To have the controller validate APP settings, supply the [settings schema](examples/settings-schema.json) in the `settingsSchema` field when registering the runner.

```json
{
  "name": "codex",
  "entrypoint": "/run/pappai/private/runners/node_modules/@flinbein/pappai-runner-codex/src/index.mjs",
  "config": {
    "codexExecutablePath": "/run/pappai/private/tools/codex/0.170.0/bin/codex",
    "profilesDir": "/run/pappai/private/profiles",
    "stateDir": "/run/pappai/private/state"
  }
}
```

## First call

1. Call `$.profile.create` on the workspace or a TEAM with a name and permissions. Save the returned ID.
2. Sign in with the Codex CLI and place the resulting `auth.json` in a directory the caller can read. Call `codex.setup` on the PROFILE with `{"authFile":"/tmp/codex-auth.json"}`. The controller reads the regular file as the caller. After import, `codex.status({})` returns `{"configured":true}`. Use `codex.remove({})` to remove the stored connection.
3. Call `$.app.create` on the workspace or a TEAM with `name`, `profile`, `permissions` and `source.manifest`. Use the [one-shot](examples/oneShot.json) or [persistent](examples/persistent.json) manifest.
4. Call `$.profile.scope.set({"scope":["APP_ID"]})` on the PROFILE using the new APP's ID, then call `$.profile.enable({})`. Call `$.app.start({})` on the APP.
5. Call `agent.execute` on the APP with `{"input":"Translate into Russian: the build passed"}`. The example method declares a string result. You can declare a different output JSON Schema for your own method. The runner validates the result before replying.

The controller checks assignment access before an event reaches the model. Each executor obtains model credentials from its assigned profile at startup. APPs that share a profile keep separate conversation histories. Set `idleTimeoutMs` on a persistent APP to release its process between assignments.

The runner supports API keys and imported ChatGPT subscription credentials. A single runner host owns the profiles directory and coordinates token refresh across its APPs. Each subscription worker receives only short-lived credentials. Give each runner host exclusive use of its profile storage. The rotation test uses the native Codex CLI and a local OAuth test server.

A persistent APP can also declare `agent.getHistory` and `agent.interrupt` under `features`. History returns user messages and final assistant replies with a pagination cursor. Interrupt targets the active turn and requires permission to call the method. If no turn is active, the controller returns an error. Both methods run without a model call.

## Executor permissions

The executor runs in an isolated directory. Its connection to the model is a service channel. For workspace operations, the model receives the `pappai_dir`, `pappai_help`, `pappai_call` and `pappai_publish` tools. The controller authorizes calls as the assigned APP using its effective permissions. The PROFILE supplies the model credentials, and its scope controls which APPs may use them.

Shell, native Codex file tools and user configuration from the working directory are disabled. Use `run.settings` to select the model, reasoning effort and developer instructions. The administrator sets the CLI and storage paths when registering the runner.

## HTTP MCP

To configure a shared server, call `codex.mcp.set({"name":"tasks","url":"https://tasks.example.org/mcp","bearerFile":"/tmp/tasks-token"})` on the PROFILE. The optional file contains one bearer token. Each call replaces the entire entry. Omitting `bearerFile` removes any previous token. `codex.mcp.get({})` lists URLs and indicates which entries have credentials. `codex.mcp.delete({"name":"tasks"})` deletes an entry. Changes apply on the next executor launch. Disable the profile to revoke access immediately.

In the APP's `run.settings`, select shared servers by name under `mcp.profile`, and declare APP-owned HTTP endpoints under `mcp.servers`. This example selects the PROFILE's authenticated task service and an APP-local calendar endpoint that accepts unauthenticated requests.

```json
{
  "mcp": {
    "profile": ["tasks"],
    "servers": { "calendar": { "url": "https://calendar.example.org/mcp" } }
  }
}
```

| Connection | Effective network permission required at launch |
|---|---|
| APP endpoint in `mcp.servers` | The APP allows network access. |
| Selected endpoint in `mcp.profile` | Both the APP and its assigned PROFILE allow network access for this APP. |

The runner omits denied endpoints and their credentials before Codex initializes. Servers enabled together must have distinct names. A suppressed PROFILE entry never supplies credentials to an APP endpoint, even when their names match. Controllers that omit the `profileMcpNetwork` grant can still supply APP endpoints subject to the network permission they dispatch. Upgrade the controller and runner together for the full permission model.

External endpoints require HTTPS. Loopback tests may use HTTP on `127.0.0.1` or `[::1]`. URLs cannot include credentials, a query, or a fragment. The runner supports HTTP endpoints only. MCP OAuth login, stdio commands, and raw Codex configuration for managed servers are unsupported. [MCP design and protocol probes](https://github.com/flinbein/pappai/blob/master/docs/dev/runners/mcp.md)

## Development and publishing

Run `npm ci --ignore-scripts` and `npm test`. On Linux, create `/run/pappai/private` with write access for the test user. To run tests with the real CLI, set `PAPPAI_TEST_CODEX_CLI` to the absolute path of the native executable. Linux integration tests require bubblewrap. The [controller acceptance test](https://github.com/flinbein/pappai/blob/master/tests/codex-package.test.ts) exercises the installed npm archive through pappai.

Each push to `master` runs the tests and publishes to the public npm registry. The workflow adds its run number minus one to the base patch version. Re-running a published build verifies the archive checksum. The first build of the `0.1` series uses version `0.1.0`.

In npm Trusted Publisher settings, choose GitHub, owner `flinbein`, repository `pappai-runner-codex`, and workflow `publish.yml`. Enable direct publication (`npm publish`). To create the package, the scope owner can publish the verified archive locally after signing in through the browser, or supply a short-lived granular token through the Actions secret `NPM_TOKEN`. Remove the secret once OIDC publishing is configured. [npm trusted publisher setup](https://docs.npmjs.com/trusted-publishers/)
