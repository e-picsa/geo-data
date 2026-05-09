export async function runOsmium(args: string[]) {
  const isWindows = process.platform === 'win32';
  const osmiumCmd = isWindows ? ['wsl', 'osmium'] : ['osmium'];

  const proc = Bun.spawn([...osmiumCmd, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(`osmium failed: ${stderr}`);
  return stdout;
}
