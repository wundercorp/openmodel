# Git Repository Workflow

## Initialize

```bash
./git-init.sh
```

Options:

```bash
./git-init.sh --branch main --message "Initial OpenModel release"
./git-init.sh --no-commit
```

The command initializes Git, verifies required ignore rules, stages safe files, checks for sensitive or generated paths, and creates the initial commit.

## Push to an existing remote

```bash
GIT_REMOTE_URL="git@github.com:wundercorp/openmodel.git" ./git-push.sh
```

Equivalent explicit form:

```bash
./git-push.sh \
  --remote-name origin \
  --remote-url git@github.com:wundercorp/openmodel.git \
  --branch main
```

## Create the GitHub repository

```bash
gh auth login
./git-push.sh \
  --create-github \
  --repository wundercorp/openmodel \
  --visibility public
```

The GitHub CLI uses your existing authenticated session. Do not store a GitHub token in the repository.

## Safety behavior

The push command requires:

- An existing commit
- A clean working tree
- No tracked deployment environment file
- No tracked Terraform state or plan
- No tracked keys, tokens, credentials, model weights, build output, or dependency directories

Run Git and deployment separately:

```bash
./git-init.sh
GIT_REMOTE_URL="git@github.com:wundercorp/openmodel.git" ./git-push.sh
./deploy.sh --yes
```

Or compose them:

```bash
./deploy.sh \
  --git-init \
  --git-push \
  --git-remote-url git@github.com:wundercorp/openmodel.git \
  --yes
```
