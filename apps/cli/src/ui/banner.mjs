const OPENMODEL_BANNER_LINES = [
  ' ██████╗ ██████╗ ███████╗███╗   ██╗███╗   ███╗ ██████╗ ██████╗ ███████╗██╗     ',
  '██╔═══██╗██╔══██╗██╔════╝████╗  ██║████╗ ████║██╔═══██╗██╔══██╗██╔════╝██║     ',
  '██║   ██║██████╔╝█████╗  ██╔██╗ ██║██╔████╔██║██║   ██║██║  ██║█████╗  ██║     ',
  '██║   ██║██╔═══╝ ██╔══╝  ██║╚██╗██║██║╚██╔╝██║██║   ██║██║  ██║██╔══╝  ██║     ',
  '╚██████╔╝██║     ███████╗██║ ╚████║██║ ╚═╝ ██║╚██████╔╝██████╔╝███████╗███████╗',
  ' ╚═════╝ ╚═╝     ╚══════╝╚═╝  ╚═══╝╚═╝     ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝╚══════╝'
];

const ANSI_RESET = '\u001B[0m';
const ANSI_BOLD = '\u001B[1m';

function interpolate(startValue, endValue, progressValue) {
  return Math.round(startValue + ((endValue - startValue) * progressValue));
}

function gradientColor(characterIndex, lineLength) {
  const normalizedProgress = lineLength <= 1 ? 0 : characterIndex / (lineLength - 1);
  const startColor = { red: 37, green: 99, blue: 235 };
  const middleColor = { red: 59, green: 130, blue: 246 };
  const endColor = { red: 125, green: 211, blue: 252 };

  if (normalizedProgress <= 0.5) {
    const localProgress = normalizedProgress / 0.5;
    return {
      red: interpolate(startColor.red, middleColor.red, localProgress),
      green: interpolate(startColor.green, middleColor.green, localProgress),
      blue: interpolate(startColor.blue, middleColor.blue, localProgress)
    };
  }

  const localProgress = (normalizedProgress - 0.5) / 0.5;
  return {
    red: interpolate(middleColor.red, endColor.red, localProgress),
    green: interpolate(middleColor.green, endColor.green, localProgress),
    blue: interpolate(middleColor.blue, endColor.blue, localProgress)
  };
}

function supportsColor(outputStream) {
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb') return false;
  return Boolean(outputStream?.isTTY);
}

function colorizeLine(line) {
  let renderedLine = '';
  for (let characterIndex = 0; characterIndex < line.length; characterIndex += 1) {
    const character = line[characterIndex];
    if (character === ' ') {
      renderedLine += character;
      continue;
    }
    const color = gradientColor(characterIndex, line.length);
    renderedLine += `\u001B[38;2;${color.red};${color.green};${color.blue}m${character}`;
  }
  return `${ANSI_BOLD}${renderedLine}${ANSI_RESET}`;
}

export function renderOpenModelBanner({ color = supportsColor(process.stdout) } = {}) {
  const renderedLines = color
    ? OPENMODEL_BANNER_LINES.map((line) => colorizeLine(line))
    : OPENMODEL_BANNER_LINES;
  return `${renderedLines.join('\n')}\n\n`;
}

export function printOpenModelBanner({ outputStream = process.stdout } = {}) {
  outputStream.write(renderOpenModelBanner({ color: supportsColor(outputStream) }));
}
