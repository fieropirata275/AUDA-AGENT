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
  if (a.purpose === 'draft custom agent') return { text: JSON.stringify({ name: 'Torque Expert', emoji: '🔩', description: 'Answers fastening questions from the maintenance manual.', instructions: 'Answer from the manual in your knowledge base. Quote exact values with units.', starters: ['What torque for the M8 bolts?'], criteria: 'The answer quotes the manual value.' }) };
  if (a.purpose === 'agent reflection') return { text: JSON.stringify({ lessons: [{ title: 'Quote units with torque values', lesson: 'When asked about torque, always quote the value with its unit (Nm) and the bolt size it applies to.' }], skill: { title: 'Answering spec questions', steps: '1. Search the knowledge base. 2. Quote the exact value. 3. Name the source.' } }) };
  if (a.purpose === 'chat') {
    const said = JSON.stringify(a.messages.at(-1)?.content ?? '');
    if (/status|what.*(doing|happening)|how.*going/i.test(said)) return { text: 'Three agents are working: the database migration is about halfway, the launch plan is split into three parts, and supplier research is running. One thing needs you — clearing the scratch folder.' };
  }
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

  // Plugins: find the tool by suffix in whatever this agent was given.
  const tool = (suffix) => (a.tools ?? []).find((t) => t.name?.startsWith('p_') && t.name.endsWith(`__${suffix}`))?.name;
  if (title.startsWith('Check my issues')) {
    if (turn === 0) return tool('search_issues') ? { content: [tu(tool('search_issues'), { q: 'is:open bug' })] } : { content: [text('NO PLUGIN TOOL')] };
    if (turn === 1) return { content: [tu(tool('comment'), { owner: 'acme', repo: 'app', number: 7, body: 'Looking into this.' })] };
    const all = JSON.stringify(a.messages);
    return { content: [text(`Issues checked. ${all.includes('Bob Example') ? 'Saw Bob’s issues.' : 'Did not see Bob’s data.'} Comment ${lastText.includes('comment-created') ? 'posted' : 'not posted'}.`)] };
  }
  if (title.startsWith('Forecast')) {
    if (turn === 0) return tool('get_forecast') ? { content: [tu(tool('get_forecast'), { city: 'Lisbon' })] } : { content: [text('NO MCP TOOL')] };
    return { content: [text(`Forecast: ${/Sunny[^"\\]*/.exec(lastText)?.[0] ?? 'unknown'}`)] };
  }
  if (title.startsWith('What torque')) {
    const kb = /From your knowledge base[\s\S]*/.exec(first)?.[0] ?? '';
    const val = /(\d+) ?Nm/.exec(kb)?.[0];
    if (turn === 0) return { content: [tu('learn', { title: 'Torque table lives in the manual', lesson: 'Fastener torque values are in the maintenance manual, section 4.' })] };
    return { content: [text(val ? `The M8 flange bolts take ${val} according to the maintenance manual, tightened in a star pattern with calibrated torque wrench.` : 'I could not find it.')] };
  }

  // A full office job: research → spreadsheet + chart → PDF report → deck → Word → read the PDF back.
  if (title.startsWith('Quarterly pack')) {
    const all = JSON.stringify(a.messages);
    const saved = (ext) => (all.match(new RegExp(`(~/[^\\s"',)]+\\.${ext})`)) ?? [])[1];
    const chart = { type: 'bar', title: 'Revenue by region', labels: ['EMEA', 'Americas', 'APAC'], series: [{ name: 'Revenue', values: [210, 340, 134] }], unit: '$' };
    if (turn === 0) return { content: [tu('search_web', { query: 'quarterly revenue benchmarks SaaS' })] };
    if (turn === 1) return { content: [
      tu('create_spreadsheet', { name: 'revenue-model', title: 'Revenue model', sheets: [{ name: 'Regions', columns: [{ header: 'Region' }, { header: 'Revenue', format: 'currency' }, { header: 'Growth', format: 'percent' }, { header: 'Next year', format: 'currency' }], rows: [['EMEA', 210, 0.14, '=B2*(1+C2)'], ['Americas', 340, 0.21, '=B3*(1+C3)'], ['APAC', 134, 0.17, '=B4*(1+C4)']], totals: true }] }),
      tu('create_chart', { name: 'revenue-by-region', chart }),
    ] };
    if (turn === 2) {
      const src = /(https?:\/\/[^\s"\\]+)/.exec(all.slice(all.indexOf('web search')))?.[1] ?? 'https://example.com';
      return { content: [tu('create_pdf', { name: 'quarterly-report', title: 'Quarterly Report', subtitle: 'Revenue, growth and outlook', toc: true, markdown: `## Executive summary\nRevenue reached **$684M**, up 18%.\n\n## By region\n\`\`\`chart\n${JSON.stringify(chart)}\n\`\`\`\n\n![Revenue by region](${saved('png') ?? 'missing.png'})\n\n## Outlook\n- APAC expansion\n- Margin focus\n\n## Sources\n- [Benchmark](${src})` })] };
    }
    if (turn === 3) return { content: [tu('create_presentation', { name: 'quarterly-review', deck: { title: 'Quarterly Review', subtitle: 'Revenue, growth and outlook', theme: 'midnight', slides: [{ layout: 'title' }, { layout: 'stats', title: 'The quarter', stats: [{ value: '$684M', label: 'Revenue' }, { value: '+18%', label: 'Growth' }] }, { layout: 'chart', title: 'Americas leads', chart, notes: 'Americas is half of revenue.' }, { layout: 'closing', title: 'Thank you' }] } })] };
    if (turn === 4) return { content: [tu('create_document', { name: 'quarterly-report', title: 'Quarterly Report', markdown: '## Executive summary\nRevenue reached $684M.\n\n| Region | Revenue |\n|---|---:|\n| EMEA | 210 |\n| Americas | 340 |' })] };
    if (turn === 5) return { content: [tu('read_document', { path: saved('pdf') ?? 'missing.pdf' })] };
    const pages = /pdf · (\d+) pages/.exec(lastText)?.[1];
    return { content: [text(`Quarterly pack delivered: spreadsheet, chart, PDF report (${pages ?? '?'} pages, read back OK), deck and Word document. Sources cited.`)] };
  }

  // Long-running work, for watching the UI live.
  if (title.startsWith('Marathon') || title.startsWith('Part ')) {
    if (turn === 0) return { content: [tu('narrate', { text: `Working through ${title}.` }), tu('terminal', { cmd: 'sleep 45 && echo done', why: 'Long-running work', timeout_sec: 120 })] };
    return { content: [text(`Finished ${title}.`)] };
  }
  if (title.startsWith('Big project')) {
    if (turn === 0) return { content: [tu('spawn_subtasks', { tasks: ['A', 'B', 'C'].map((t) => ({ title: `Part ${t}`, goal: `Do part ${t}`, done_when: `Part ${t} is done` })) })] };
    return { content: [text('All parts combined.')] };
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
