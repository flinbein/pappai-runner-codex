# @flinbein/pappai-runner-codex

This external runner delivers [pappai](https://github.com/flinbein/pappai) events and method calls to the Codex CLI through `app-server`. A one-shot executor creates an ephemeral thread for a single assignment. A persistent executor processes turns sequentially in one thread and resumes it after a process restart.

## Installation

In the pappai workspace, choose **Add runner → npm**, enter `@flinbein/pappai-runner-codex`, and give the installation a name, such as `codex`. The host requires Linux x86_64, bubblewrap, npm, Node.js 24.2+ and a persistent private volume at `/run/pappai/private`.

On first start the runner downloads the latest stable native Linux musl distribution from the public npm registry and verifies its executable version. It keeps each CLI release and the selected version in `/run/pappai/private/runners/<name>/tools/`. A restart uses the selected version offline. The runner publishes its [APP settings schema](examples/settings-schema.json) when it starts.

Administrators can call these methods on the workspace (`~`). Substitute the installation name for `codex`.

| Method | Arguments | Result |
| --- | --- | --- |
| `runners.codex.getVersion` | `{}` | Active CLI version, installation status and source |
| `runners.codex.installCodex` | `{}` or `{"version":"0.172.0"}` | Resolve the latest stable version or select the exact stable version, then return its status |

For example, `{"source":"managed","version":"0.172.0","status":"ready"}` means new executors will use that release. During the first installation, the status is `installing` and the version is `null`. New workers wait for the CLI. Existing executors keep using their launch version after an update. A failed update preserves the active release and exposes an `error` through `getVersion`. To roll back, select a previously installed version.

### Existing installations

Controllers with an existing manual registration continue to use its saved paths. For example, the following registration was supported by earlier controllers. Its externally installed CLI reports `"source":"configured"` in workspace settings on controllers that support runner methods.

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

## Updating an existing registration

Updating the runner package and updating the Codex CLI are separate operations. In a managed installation, select the new runner release through workspace settings. The controller activates its entry point with `$.runners.restart({name,entrypoint})`. CLI selection, stored profile connections, and APP history persist across runner package updates.

For a manually installed runner, find its entry point with `$.runners.get({})` on the workspace. Wait for active Codex turns to finish, then use the administrator terminal to install the desired package version under the same npm prefix as the registered entry point. For example, for an entry point under `/run/pappai/private/runners/node_modules/`, use `npm install --prefix /run/pappai/private/runners --omit=dev --ignore-scripts --save-exact @flinbein/pappai-runner-codex@VERSION`. Replace `VERSION` with the release number.

Call `$.runners.restart({"name":"codex"})` on the workspace to load the installed package with its saved configuration. Restart affects all active Codex workers. Use the same procedure with the previous package version to roll back.

When upgrading a persistent session from the `pappai_dir` tool on Codex CLI 0.170.0, stop the controller, back up the runner state directory and run `node <installed-package>/scripts/upgrade-thread-tools.mjs <app-state>` for each persistent APP state directory before starting the new controller. Codex stores dynamic tool definitions at thread creation. The script updates the discovery name and help signature in stored rollout metadata and the SQLite index. It replaces each rollout atomically, preserving all conversation records after the header. A repeated invocation reports zero updates. Restore the backup if rolling back both packages. Fresh installations and one-shot APPs can skip this step.

## First call

1. Call `$.profile.create` on the workspace or a TEAM with a name and permissions. Save the returned ID.
2. In the USER web terminal, run `pappai cli PROFILE_ID codex.authorize '{}'`. Open the verification URL and enter the device code in your browser. The selected Codex CLI runs in a temporary home. After sign-in, the helper calls `codex.setup` with the path to the new credentials and displays the result of `codex.status`. The USER needs network access and permission to run the command and call both methods. If you cancel during login, the PROFILE keeps its existing connection. Substitute the registration name for `codex` if needed.
3. Call `$.app.create` on the workspace or a TEAM with `name`, `profile`, `permissions` and `source.manifest`. Use the [one-shot](examples/oneShot.json) or [persistent](examples/persistent.json) manifest.
4. Call `$.profile.scope.set({"scope":["APP_ID"]})` on the PROFILE using the new APP's ID, then call `$.profile.enable({})`. Call `$.app.start({})` on the APP.
5. Call `agent.execute` on the APP with `{"input":"Translate into Russian: the build passed"}`. The example method declares a string result. You can declare a different output JSON Schema for your own method. The runner validates the result before replying.

The controller checks assignment access before an event reaches the model. Each executor obtains model credentials from its assigned profile at startup. APPs that share a profile keep separate conversation histories. Set `idleTimeoutMs` on a persistent APP to release its process between assignments.

For a manual import, place a Codex `auth.json` in a directory the caller can read and call `codex.setup` on the PROFILE with `{"authFile":"/tmp/codex-auth.json"}`. The controller reads the regular file as the caller. Use `codex.status({})` to check the connection and `codex.remove({})` to remove it.

The runner supports API keys and imported ChatGPT subscription credentials. Each installation stores its connection at `profiles/<profileId>/<runnerName>/` and coordinates token refresh across its APPs. The default installation named `codex` keeps its existing history under `state/`. Other installations keep their history under `state/instances/<runnerName>/`. Each subscription worker receives only short-lived credentials. The rotation test uses the native Codex CLI and a local OAuth test server.

A persistent APP can also declare `agent.getHistory` and `agent.interrupt` under `features`. History returns user messages and final assistant replies with a pagination cursor. Interrupt targets the active turn and requires permission to call the method. If no turn is active, the controller returns an error. Both methods run without a model call.

## Executor permissions

The executor runs in an isolated directory. Its connection to the model is a service channel. For workspace operations, the model receives the `pappai_discover`, `pappai_help`, `pappai_call` and `pappai_publish` tools. Use `pappai_help({node, features:true})` to list the full catalog. Omit `features` for the top level, or select names and request `doc:true` and `schema:true` for details. Each entry has a type and version. The controller authorizes calls as the assigned APP using its effective permissions. The PROFILE supplies the model credentials, and its scope controls which APPs may use them.

Workers support Code Mode. For example, `functions.exec` can run `text(await tools.pappai_discover({}))`. Keep the native `bin/codex-code-mode-host` beside `bin/codex` in the trusted CLI distribution. The runner mounts that helper read-only for APP workers. The separate credential refresh process keeps Code Mode disabled. The helper shares the app-server's network namespace. The JavaScript environment exposes the selected tools, and nested pappai calls undergo the usual controller permission checks.

Shell, native Codex file tools and user configuration from the working directory are disabled. Use `run.settings` to select the model, reasoning effort and developer instructions.

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
