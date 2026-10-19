import { test, expect } from 'bun:test';
import { spawn } from 'node:child_process';
import path from 'node:path';

test('Run E2E Verification Suite', async () => {
  const scriptPath = path.join(__dirname, 'e2e-verification.ts');
  const proc = spawn('bun', [scriptPath], { stdio: 'inherit' });

  const exitCode = await new Promise<number>((resolve) => {
    proc.on('close', resolve);
  });

  expect(exitCode).toBe(0);
}, 60000);
