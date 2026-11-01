const tests = [];

export function test(name, fn) {
  tests.push({ name, fn });
}

export const assert = {
  equal(actual, expected, label = '') {
    if (!Object.is(actual, expected)) {
      throw new Error(`${label} forventede ${JSON.stringify(expected)}, fik ${JSON.stringify(actual)}`);
    }
  },
  deepEqual(actual, expected, label = '') {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${label} forventede ${b}, fik ${a}`);
  },
  ok(value, label = 'værdien') {
    if (!value) throw new Error(`${label} skulle være sand`);
  },
  async rejects(fn, type, label = '') {
    try {
      await fn();
    } catch (error) {
      if (type && !(error instanceof type)) {
        throw new Error(`${label} forventede ${type.name}, fik ${error.name}: ${error.message}`);
      }
      return error;
    }
    throw new Error(`${label} skulle have fejlet`);
  },
};

export function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, options = {}) => {
    const call = { url: String(url), method: options.method ?? 'GET', body: options.body, headers: options.headers ?? {} };
    calls.push(call);
    return handler(call, calls);
  };
  fn.calls = calls;
  return fn;
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

export function empty(status = 204) {
  return new Response(null, { status });
}

export async function runAll(container) {
  const results = [];
  for (const { name, fn } of tests) {
    const started = performance.now();
    window.testProgress = { name, done: results.length, total: tests.length };
    try {
      await Promise.race([
        fn(),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('tog over 60 sekunder')), 60000); }),
      ]);
      results.push({ name, ok: true, ms: Math.round(performance.now() - started) });
    } catch (error) {
      results.push({ name, ok: false, error: error.message });
    }
  }
  const failed = results.filter((result) => !result.ok);
  const slowest = [...results].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 3).map((r) => `${r.name}: ${r.ms} ms`);
  const summary = { total: results.length, passed: results.length - failed.length, failed, slowest };
  window.testSummary = summary;
  if (container) {
    const heading = document.createElement('h1');
    heading.textContent = `${summary.passed} af ${summary.total} tests bestået`;
    container.append(heading);
    for (const result of results) {
      const line = document.createElement('div');
      line.textContent = `${result.ok ? 'OK' : 'FEJL'}  ${result.name}${result.error ? ` – ${result.error}` : ''}`;
      line.style.color = result.ok ? '' : 'crimson';
      container.append(line);
    }
  }
  return summary;
}
