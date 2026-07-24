# Changelog

All notable changes to the OpenModel CLI are documented in this file.

## [0.1.18] - 2026-07-25

### Added
- `om status` command — machine-readable runtime and model status
- `--json` flag for `om status` — structured JSON output for tooling integration
- Config-based llama.cpp binary path: `runtimes.llama.cpp.binary` in `config.json`
- Fedora candidate paths: `~/.local/opt/llama-vulkan/llama-cli`, `/usr/local/bin/llama-cli`, etc.

### Changed
- `om doctor` now shows binary path, source, and version for each runtime
- `getRuntimeStatus()` includes `source` and `version` fields in runtime entries

### Example
```bash
# Text output
$ om status
Platform: linux (x64)
Node: v22.22.2
Data: /home/user/.local/share/openmodel
Models: 1 installed, 1 runnable, 3.2 GB
  llama.cpp: ✓ /home/user/.local/opt/llama-vulkan/llama-cli v9822 (fedora-candidate)
  ollama: ✓ ollama

# JSON output
$ om status --json
{
  "platform": "linux",
  "runtimes": [{"id": "llama.cpp", "available": true, "binary": "...", "version": "9822", "source": "fedora-candidate"}],
  "models": {"installed": 1, "runnable": 1, "storageBytes": 3400000000},
  "gateways": ["huggingface", "direct", "ollama"],
  "warnings": []
}
```
