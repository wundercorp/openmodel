import { commandExists, runProcess } from '../lib/process.js';

const candidates = ['llama-completion', 'llama-cli', 'main'];

async function findBinary() {
  for (const candidate of candidates) {
    if (await commandExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
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
    '--no-show-timings',
    '--log-disable',
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
    const binary = await findBinary();
    return { available: Boolean(binary), binary };
  },
  async available() {
    return Boolean(await findBinary());
  },
  async run(manifest, prompt, options = {}) {
    const binary = await findBinary();
    if (!binary) {
      throw new Error('llama.cpp was not found. Install llama.cpp and ensure its binaries are on PATH.');
    }
    const modelPath = manifest.artifactPaths?.[0];
    if (!modelPath) {
      throw new Error('The model manifest has no local artifact.');
    }
    await runProcess(binary, buildGenerateArguments(modelPath, prompt, options));
  },
  async generate(manifest, prompt, options = {}) {
    const binary = await findBinary();
    if (!binary) {
      throw new Error('llama.cpp was not found. Install llama.cpp and ensure its binaries are on PATH.');
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
