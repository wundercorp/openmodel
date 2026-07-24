import { commandExists, runProcess } from '../lib/process.js';
import { getPaths } from '../lib/paths.js';
import { readConfig } from '../lib/config.js';

const candidates = ['llama-completion', 'llama-cli', 'main'];

const fedoraCandidates = [
  `${process.env.HOME}/.local/opt/llama-vulkan/llama-cli`,
  '/usr/local/bin/llama-cli',
  '/opt/llama.cpp/bin/llama-cli',
  `${process.env.HOME}/.local/bin/llama-cli`
];

async function findBinary(configBinary) {
  if (configBinary) {
    if (await commandExists(configBinary)) {
      return { binary: configBinary, source: 'config' };
    }
    return { binary: undefined, source: 'config-not-found' };
  }

  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return { binary: candidate, source: 'path' };
    }
  }

  for (const fedoraPath of fedoraCandidates) {
    const expanded = fedoraPath.replace('~', process.env.HOME ?? '');
    if (await commandExists(expanded)) {
      return { binary: expanded, source: 'fedora-candidate' };
    }
  }

  return { binary: undefined, source: 'not-found' };
}

function buildGenerateArguments(modelPath, prompt, options = {}) {
  const requestedMaxTokens = Number(options.maxTokens ?? 512);
  const maxTokens = Number.isFinite(requestedMaxTokens)
    ? Math.max(1, Math.floor(requestedMaxTokens))
    : 512;

  return [
    '-m', modelPath,
    '-p', prompt,
    '-n', String(maxTokens),
    '--single-turn',
    '--simple-io',
    '--no-display-prompt',
    '--color', 'off'
  ];
}

function removeAnsiSequences(value) {
  return String(value ?? '').replace(
    // eslint-disable-next-line no-control-regex
    /\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001B\\))/g,
    ''
  );
}

function removeTrailingCliLines(value) {
  const lines = value.split('\n');

  while (lines.length > 0) {
    const finalLine = lines[lines.length - 1].trim();
    if (
      finalLine === '' ||
      finalLine === '>' ||
      finalLine === 'Exiting...' ||
      /^\[\s*Prompt:.*Generation:.*\]$/i.test(finalLine)
    ) {
      lines.pop();
      continue;
    }
    break;
  }

  return lines.join('\n').trim();
}

async function getBinaryVersion(binary) {
  try {
    const result = await runProcess(binary, ['--version'], { capture: true });
    const output = String(result.stdout ?? '').trim() || String(result.stderr ?? '').trim();
    const match = output.match(/version[:\s]*([0-9.]+[a-z0-9.-]*)/i) ||
                  output.match(/([0-9]+\.[0-9]+(\.[0-9]+)?)/);
    return match ? match[1] : output.split('\n')[0]?.slice(0, 80) || 'unknown';
  } catch {
    return undefined;
  }
}

function extractGeneratedText(rawOutput, prompt) {
  const normalizedOutput = removeAnsiSequences(rawOutput)
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '')
    .trim();

  if (!normalizedOutput) {
    return '';
  }

  const normalizedPrompt = String(prompt ?? '').replace(/\r\n?/g, '\n').trim();
  const exactPromptMarker = normalizedPrompt ? `> ${normalizedPrompt}` : '';
  let generatedText = normalizedOutput;

  if (exactPromptMarker) {
    const exactPromptMarkerIndex = normalizedOutput.lastIndexOf(exactPromptMarker);
    if (exactPromptMarkerIndex >= 0) {
      generatedText = normalizedOutput.slice(exactPromptMarkerIndex + exactPromptMarker.length);
    }
  }

  if (generatedText === normalizedOutput) {
    const userPromptMarker = /(?:^|\n)>\s*user:\s*[^\n]*(?:\n|$)/gi;
    let lastMatch;
    for (const match of normalizedOutput.matchAll(userPromptMarker)) {
      lastMatch = match;
    }
    if (lastMatch?.index !== undefined) {
      generatedText = normalizedOutput.slice(lastMatch.index + lastMatch[0].length);
    }
  }

  generatedText = removeTrailingCliLines(generatedText);
  generatedText = generatedText.replace(/^assistant:\s*/i, '').trim();

  return generatedText || removeTrailingCliLines(normalizedOutput);
}

export const llamaCppRuntime = {
  id: 'llama.cpp',
  async status() {
    const config = await readConfig();
    const configBinary = config.runtimes?.['llama.cpp']?.binary;
    const { binary, source } = await findBinary(configBinary);
    const version = binary ? await getBinaryVersion(binary) : undefined;
    return { available: Boolean(binary), binary, source, version };
  },
  async available() {
    const config = await readConfig();
    const configBinary = config.runtimes?.['llama.cpp']?.binary;
    return Boolean((await findBinary(configBinary)).binary);
  },
  async run(manifest, prompt, options = {}) {
    const config = await readConfig();
    const configBinary = config.runtimes?.['llama.cpp']?.binary;
    const { binary } = await findBinary(configBinary);
    if (!binary) {
      throw new Error('llama.cpp was not found. Install llama.cpp and ensure its binaries are on PATH, or configure an explicit path in ~/.openmodel/config.json.');
    }
    const modelPath = manifest.artifactPaths?.[0];
    if (!modelPath) {
      throw new Error('The model manifest has no local artifact.');
    }
    await runProcess(binary, buildGenerateArguments(modelPath, prompt, options));
  },
  async generate(manifest, prompt, options = {}) {
    const config = await readConfig();
    const configBinary = config.runtimes?.['llama.cpp']?.binary;
    const { binary } = await findBinary(configBinary);
    if (!binary) {
      throw new Error('llama.cpp was not found. Install llama.cpp and ensure its binaries are on PATH, or configure an explicit path in ~/.openmodel/config.json.');
    }
    const modelPath = manifest.artifactPaths?.[0];
    if (!modelPath) {
      throw new Error('The model manifest has no local artifact.');
    }
    const result = await runProcess(
      binary,
      buildGenerateArguments(modelPath, prompt, options),
      {
        capture: true,
        signal: options.signal
      }
    );
    return extractGeneratedText(result.stdout, prompt);
  }
};

export { buildGenerateArguments, extractGeneratedText };
