#!/usr/bin/env node

import path from 'node:path';

const executableName = path.basename(process.argv[1] ?? '');
const args = process.argv.slice(2);

function print(lines) {
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (executableName.includes('claude')) {
  if (args[0] === '--version') {
    print(['Claude Code 2.1.99-fixture']);
  } else if (args.includes('--fork-session') && args.includes('-p')) {
    print([
      JSON.stringify({
        goal: 'Continue the synthetic provider-generated handoff',
        completed: ['Verified the same-provider invocation'],
        decisions: ['Keep provider summaries explicitly opt-in'],
        nextSteps: ['Review the generated summary before capture'],
        blockers: [],
        commands: [],
        risks: ['This synthetic invocation represents provider token usage'],
      }),
    ]);
  } else {
    print([
      'Usage: claude [options] [prompt]',
      '  -r, --resume <session-id>',
      '  --fork-session',
      '  --session-id <session-id>',
    ]);
  }
} else if (executableName.includes('codex-hud')) {
  if (args[0] === '--version') print(['codex-hud 0.99.0']);
  else print(['codex-hud synthetic CLI wrapper', 'Usage: codex [OPTIONS] [COMMAND]', '  resume  Pretend resume command']);
} else if (executableName.includes('legacy-codex')) {
  if (args[0] === '--version') print(['Codex 0.88.0']);
  else print(['Usage: codex [OPTIONS] [COMMAND]', '  run  Run a synthetic task']);
} else if (args[0] === '--version') {
  print(['Codex 0.99.0-fixture']);
} else if (args[0] === 'resume') {
  print(['Usage: codex resume [SESSION_ID]', 'Resume a previous session']);
} else if (args[0] === 'exec' && args[1] === 'resume' && args[2] === '--help') {
  print(['Usage: codex exec resume [SESSION_ID]', 'Resume a previous session in non-interactive mode']);
} else if (args[0] === 'exec' && args[1] === 'resume') {
  print([
    JSON.stringify({
      goal: 'Continue the synthetic Codex provider-generated handoff',
      completed: ['Verified the same-provider invocation'],
      decisions: ['Keep provider summaries explicitly opt-in'],
      nextSteps: ['Review the generated summary before capture'],
      blockers: [],
      commands: [],
      risks: ['This synthetic invocation represents provider token usage'],
    }),
  ]);
} else {
  print(['Usage: codex [OPTIONS] [COMMAND]', 'Commands:', '  resume  Resume a previous session', '  exec    Run non-interactively']);
}
