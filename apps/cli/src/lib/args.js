export function parseArgs(input) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < input.length; index += 1) {
    const value = input[index];
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const [rawName, inlineValue] = value.slice(2).split('=', 2);
    if (inlineValue !== undefined) {
      flags[rawName] = inlineValue;
      continue;
    }
    const nextValue = input[index + 1];
    if (nextValue !== undefined && !nextValue.startsWith('--')) {
      flags[rawName] = nextValue;
      index += 1;
    } else {
      flags[rawName] = true;
    }
  }
  return { positionals, flags };
}

export function getFlag(flags, name, fallbackValue = undefined) {
  return flags[name] === undefined ? fallbackValue : flags[name];
}
