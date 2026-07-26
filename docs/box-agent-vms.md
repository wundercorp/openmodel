# Box agent VMs

OpenModel uses the Box CLI as the VM transport and [BuilderStudio `bs`](https://www.npmjs.com/package/@wundercorp/bs) as the primary coding agent inside each VM. Claude Code and Codex remain supported as secondary agents.

## Default architecture

The default `om box create` flow is:

1. Verify that the Box CLI is installed and authenticated.
2. Create a Box with `--no-env --no-auto-stop`, or fork a prepared template.
3. Copy only explicitly named environment variables without printing their values.
4. Upload a local project directory through Box SCP.
5. Run an optional project setup command.
6. Install `@wundercorp/bs` in the VM when the `bs` command is not already available.
7. Initialize the uploaded directory as the BuilderStudio workspace.
8. Run the requested task with `bs gain` by default.
9. Optionally install a restartable systemd service and expose a private HTTPS preview.
10. Print lifecycle commands for prompting, SSH, stop, resume, and fork.

If project upload, agent installation, setup, hosting, or prompting fails after VM creation, OpenModel attempts to stop the new Box and includes the Box ID in the error.

## Install and authenticate

Install OpenModel and the Box CLI:

```bash
npm install --global @wundercorp/openmodel
curl -fsSL https://box.ascii.dev/install | sh
```

Create a Box API key and expose it only to the current shell:

```bash
export BOX_API_KEY=your_box_api_key
om box setup
```

An existing `box login` session also works. `om box setup --install` can run the Unix Box installer when the `box` executable is missing.

## Start the primary BuilderStudio agent

A fresh no-env VM does not inherit local or account-wide model credentials. Export an OpenRouter key locally and explicitly name it for forwarding:

```bash
export OPENROUTER_API_KEY=your_openrouter_api_key

om box create \
  "Inspect the repository, run tests, and implement the next useful fix" \
  --project . \
  --env OPENROUTER_API_KEY
```

`--agent bs` is optional because `bs` is the default:

```bash
om box create \
  "Review the architecture and fix the highest-impact issue" \
  --project . \
  --agent bs \
  --env OPENROUTER_API_KEY
```

OpenModel installs the current published `@wundercorp/bs` package inside the VM with:

```bash
npm install --global @wundercorp/bs
```

It then initializes the uploaded project with `bs init --workspace <remote-path>` and runs the task through `bs gain`.

## Choose a BuilderStudio workflow

The default mode is `gain`, which plans and applies workspace changes. Select another `bs` workflow with `--bs-mode`:

```bash
om box create "Analyze this repository" \
  --project . \
  --env OPENROUTER_API_KEY \
  --bs-mode ask

om box create "Create an implementation plan" \
  --project . \
  --env OPENROUTER_API_KEY \
  --bs-mode plan

om box create "Run the full agent workflow" \
  --project . \
  --env OPENROUTER_API_KEY \
  --bs-mode agent

om box create "Review the project with multiple specialists" \
  --project . \
  --env OPENROUTER_API_KEY \
  --bs-mode swarm
```

Supported values map to these remote commands:

| `--bs-mode` | Remote command |
| --- | --- |
| `gain` | `bs gain "task"` |
| `ask` | `bs ask "task"` |
| `plan` | `bs plan "task"` |
| `agent` | `bs agent run "task"` |
| `swarm` | `bs swarm run "task"` |

Pass `--model <model-id>` to override the model selected by BuilderStudio for that task.

## Continue work in an existing VM

Use the remote project path printed by `om box create`:

```bash
om box prompt bx_your_box_id \
  "Implement the approved change and verify it" \
  --agent bs \
  --workdir /home/user/your-project
```

Select another BuilderStudio mode or model when needed:

```bash
om box prompt bx_your_box_id \
  "Review the current diff" \
  --workdir /home/user/your-project \
  --bs-mode ask \
  --model openrouter/auto
```

OpenModel checks for `bs` on every BuilderStudio prompt and installs it if needed. Use `--skip-agent-install` only for a trusted template where the package is already installed.

## Secondary agents

Claude Code and Codex remain available through Box's native agent provider flow.

Claude Code:

```bash
om box create \
  "Inspect the repository and run the tests" \
  --project . \
  --agent claude-code
```

Codex:

```bash
om box create \
  "Inspect the repository and run the tests" \
  --project . \
  --agent codex
```

Configure these providers in the Box dashboard before their first prompt. They do not require `OPENROUTER_API_KEY` unless the project itself needs it.

## Create without an initial prompt

The default command creates the VM, uploads the workspace, and ensures `bs` is available without starting a model request:

```bash
om box create --project .
```

The result includes a follow-up command with the correct remote working directory.

Use `--json` for orchestration:

```bash
om box create --project . --json
```

The JSON summary includes the Box ID, selected agent, whether it is the primary agent, package setup details, project paths, copied environment-variable names, template ID, service and hosting details, verification result, and lifecycle commands. Secret values are excluded.

## Environment variables and secrets

Every newly created workspace uses `--no-env`. OpenModel forwards only names supplied with `--env`.

```bash
export OPENROUTER_API_KEY=...
export GITHUB_TOKEN=...

om box create "Fix the failing tests" \
  --project . \
  --env OPENROUTER_API_KEY \
  --env GITHUB_TOKEN
```

`--env NAME=VALUE` is supported for automation, but it can expose values through shell history or process inspection. Prefer `--env NAME`.

Template forks intentionally reject `--env`; configure per-fork credentials through the Box API or SDK instead of baking user secrets into a template.

Never place credentials in prompts, hosted URLs, committed files, or logs.

## Project setup

Run a setup command after upload and before the agent starts:

```bash
om box create "Run the test suite" \
  --project . \
  --env OPENROUTER_API_KEY \
  --setup-command "npm ci"
```

The command runs through Bash from the uploaded project directory.

## Long-running services and previews

Install an always-on systemd service and expose its port:

```bash
om box create \
  "Verify the application starts correctly" \
  --project . \
  --env OPENROUTER_API_KEY \
  --setup-command "npm ci" \
  --start-command "npm run dev -- --host 0.0.0.0" \
  --service-name openmodel-preview \
  --port 3000
```

The service script is written under `/home/user/.openmodel/services/`; the unit is installed under `/etc/systemd/system/` with `Restart=always`.

Hosted URLs are private by default. Use `--public` only for content intended to be reachable without the Box access token. The application must listen on `0.0.0.0`. OpenModel verifies the returned URL unless `--skip-verify` is supplied.

## Templates

Prepare dependencies and the primary `bs` package once, stop the VM, and fork it for later tasks:

```bash
om box create --project . --setup-command "npm ci"
om box stop bx_template_id
om box create --template bx_template_id --agent bs
```

A template can contain a preinstalled `bs` CLI and reusable dependencies. It should not contain user credentials or task-specific private source code.

## Lifecycle commands

OpenModel passes lifecycle actions through to the Box CLI after authentication:

```bash
om box list
om box status bx_your_box_id
om box ssh bx_your_box_id
om box stop bx_your_box_id
om box resume bx_your_box_id
om box fork bx_your_box_id --no-env
om box host bx_your_box_id 3000
om box desktop bx_your_box_id
om box delete bx_your_box_id
```

Additional passthrough actions include `scp`, `events`, `interrupt`, `forward`, `snapshots`, `snapshot`, `extend`, `limits`, `dashboard`, and `config`.

## Command reference

```text
om box setup [--install]

om box create [prompt]
  [--project path]
  [--agent bs|claude-code|codex]
  [--model name]
  [--bs-mode gain|ask|plan|agent|swarm]
  [--skip-agent-install]
  [--template box-id]
  [--env NAME]
  [--setup-command command]
  [--start-command command]
  [--service-name name]
  [--port 1-65535]
  [--public]
  [--skip-verify]
  [--json]

om box prompt <box-id> <prompt>
  [--agent bs|claude-code|codex]
  [--workdir path]
  [--model name]
  [--bs-mode gain|ask|plan|agent|swarm]
  [--skip-agent-install]
  [--json]
```

## App onboarding

The OpenModel landing page and authenticated **Agent Boxes** dashboard now present:

- BuilderStudio `bs` as the recommended primary agent
- the required explicit `OPENROUTER_API_KEY` forwarding step
- Claude Code and Codex as secondary alternatives
- prompt, stop, resume, and template commands
- optional service and private-preview setup
