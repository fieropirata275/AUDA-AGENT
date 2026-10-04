/**
 * Scripted stand-in for a reasoning model, used by scripts/e2e-agent.mjs.
 * It behaves like a (simple) agent per task title so the real engine, tools,
 * orchestration, review loop, loop detection and recovery can be tested
 * deterministically without an API key.
 */
let n = 0;
const tu = (name, input) => ({ type: 'tool_use', id: `toolu_${Date.now().toString(36)}_${n++}`, name, input });
const text = (t) => ({ type: 'text', text: t });

export async function respond(a) {
  if (a.purpose === 'verification') {
    if (a.prompt.includes('Build a word counter') && !a.prompt.includes('VERIFIED')) {
      return { text: '{"verdict":"fail","issues":["There is no evidence the counter was run against real input"],"summary":"Claimed, not shown"}' };
    }
    return { text: '{"verdict":"pass","issues":[],"summary":"The result matches the criteria"}' };
  }
  if (a.purpose === 'context handoff') return { text: 'Progress summary for handoff.' };
  if (a.purpose !== 'agent turn') return { text: 'ok' };

  const first = typeof a.messages[0].content === 'string' ? a.messages[0].content : '';
  const title = (/Task: (.*)/.exec(first) ?? [])[1] ?? '';
  const turn = a.messages.filter((m) => m.role === 'assistant').length;
  const last = a.messages[a.messages.length - 1];
  const lastText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);

  if (title.startsWith('Build a word counter')) {
    if (turn === 0) return { content: [
      tu('update_plan', { steps: [{ title: 'Write wc.py', status: 'doing' }, { title: 'Run it on sample input', status: 'pending' }] }),
      tu('write_file', { path: 'wc.py', content: 'import sys\nprint(len(sys.stdin.read().split()))\n' }),
    ] };
    if (turn === 1) return { content: [tu('narrate', { text: 'Running the counter on a sample.' }), tu('terminal', { cmd: "printf 'a b c d' | python3 wc.py", why: 'Check the output' })] };
    if (turn === 2) return { content: [text('Wrote wc.py.')] }; // reviewer will reject: no evidence
    if (turn === 3) return { content: [tu('terminal', { cmd: "printf 'one two three' | python3 wc.py", why: 'Show it works on real input' })] };
    if (turn === 4) return { content: [tu('update_plan', { steps: [{ title: 'Write wc.py', status: 'done' }, { title: 'Run it on sample input', status: 'done' }] })] };
    const out = a.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_result').map((b) => String(b.content)).filter((c) => c.includes('stdout')).pop() ?? '';
    return { content: [text(`VERIFIED: wc.py counts words; "one two three" → ${/stdout ---\n(\d+)/.exec(out)?.[1] ?? '?'}.`)] };
  }

  if (title.startsWith('Research three topics')) {
    if (turn === 0) return { content: [tu('spawn_subtasks', { tasks: ['Alpha', 'Beta', 'Gamma'].map((t) => ({ title: `Topic ${t}`, goal: `Write notes about ${t}`, done_when: `${t}.md exists` })) })] };
    return { content: [text(`Combined results. ${lastText.includes('Subtask 3') ? 'All three subtasks reported back.' : 'Missing subtasks!'}`)] };
  }
  if (title.startsWith('Topic ')) {
    if (turn === 0) return { content: [tu('write_file', { path: `${title.slice(6)}.md`, content: `# ${title}\nNotes.\n` })] };
    return { content: [text(`Wrote ${title.slice(6)}.md`)] };
  }

  if (title.startsWith('Loop forever')) return { content: [tu('terminal', { cmd: 'echo same', why: 'checking' })] };

  if (title.startsWith('Clean the scratch folder')) {
    if (turn === 0) return { content: [tu('terminal', { cmd: 'rm -rf scratch', why: 'Remove the scratch folder' })] };
    return { content: [text('Scratch folder removed.')] };
  }

  if (title.startsWith('Slow job')) {
    if (turn === 0) return { content: [tu('terminal', { cmd: 'sleep 6 && echo slow-done', why: 'Long-running work', timeout_sec: 60 })] };
    return { content: [text(`Finished: ${lastText.includes('slow-done') ? 'slow-done' : 'no output'}`)] };
  }
  return { content: [text('Nothing to do.')] };
}
