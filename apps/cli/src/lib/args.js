const repeatableFlagNames = new Set(['env']);

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
    let parsedValue;
    if (inlineValue !== undefined) {
      parsedValue = inlineValue;
    } else {
      const nextValue = input[index + 1];
      if (nextValue !== undefined && !nextValue.startsWith('--')) {
        parsedValue = nextValue;
        index += 1;
      } else {
        parsedValue = true;
      }
    }
    if (!repeatableFlagNames.has(rawName) || flags[rawName] === undefined) {
      flags[rawName] = parsedValue;
    } else if (Array.isArray(flags[rawName])) {
      flags[rawName].push(parsedValue);
    } else {
      flags[rawName] = [flags[rawName], parsedValue];
    }
  }
  return { positionals, flags };
}

export function getFlag(flags, name, fallbackValue = undefined) {
  const value = flags[name];
  if (value === undefined) return fallbackValue;
  return Array.isArray(value) ? value[value.length - 1] : value;
}

export function getFlags(flags, name) {
  const value = flags[name];
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}
