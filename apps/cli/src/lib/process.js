import { spawn } from 'node:child_process';

export async function commandExists(command) {
  return new Promise((resolve) => {
    const checker = process.platform === 'win32' ? 'where' : 'which';
    const child = spawn(checker, [command], { stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', (code) => resolve(code === 0));
  });
}

function createAbortError() {
  const error = new Error('The local inference request was cancelled.');
  error.name = 'AbortError';
  return error;
}

export async function runProcess(command, argumentsList, options = {}) {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(createAbortError());
      return;
    }

    const child = spawn(command, argumentsList, {
      stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
      env: { ...process.env, ...options.env }
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKillTimeout;

    const cleanup = () => {
      options.signal?.removeEventListener('abort', abortProcess);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
    };

    const settleResolve = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    const settleReject = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };

    const abortProcess = () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        forceKillTimeout = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        }, 2000);
        forceKillTimeout.unref?.();
      }
      settleReject(createAbortError());
    };

    options.signal?.addEventListener('abort', abortProcess, { once: true });
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', settleReject);
    child.once('exit', (code, signal) => {
      if (settled) return;
      if (code === 0) {
        settleResolve({ code, stdout, stderr });
        return;
      }
      settleReject(new Error(`${command} exited with ${code ?? signal}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}
